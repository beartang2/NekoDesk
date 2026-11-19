//! 동기화의 Tauri 쪽: 열쇠·토큰(키체인), 주기 작업, `sync-changed` 이벤트, 설정 › 동기화 커맨드.
//!
//! 기본은 꺼져 있다. 사용자가 서버를 넣고 켜기 전엔 아무것도 밖으로 안 나간다(sync_state.enabled).
//! 주기: 메인 창이 앞에 있으면 15초, 아니면 5분. 로컬에서 쓴 직후·창이 앞으로 올 때는 kick 으로 바로.

use super::*;
use crate::DbState;
use chacha20poly1305::aead::rand_core::RngCore;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

static KICK: OnceLock<mpsc::Sender<()>> = OnceLock::new();
/// 이번 실행에서 한 번이라도 다 맞췄나 — 오래된 대화 자동 삭제는 그 뒤에만 돈다(§2.5 규칙 1)
static SYNCED: AtomicBool = AtomicBool::new(false);

const PAIR_PREFIX: &str = "nekosync1:";
/// 서버의 기기 목록에 보이는 이름(사용자 결정, 0.1.16): 맥은 컴퓨터 이름("○○의 MacBook Air"), 폰은 기기 이름.
/// iOS 16 부터 권한 없이는 "iPhone" 만 줘서, 그때는 모델 이름("iPhone 13 mini")으로 구분한다. 못 받으면 종류만.
/// 서버에 평문으로 남는 값이다(기기 목록에 보이려고). 실행당 한 번 읽는다 — 폰은 UIKit 을 부르니 처음은 main thread
/// 에서(lib.rs setup).
pub fn device_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        let kind = if cfg!(target_os = "ios") { "iPhone" } else { "Mac" };
        let name: String = read_device_name().unwrap_or_default().chars().filter(|c| !c.is_control()).take(80).collect();
        if name.trim().is_empty() { kind.to_owned() } else { name.trim().to_owned() }
    })
    .clone()
}

#[cfg(target_os = "macos")]
fn read_device_name() -> Option<String> {
    let out = std::process::Command::new("/usr/sbin/scutil").args(["--get", "ComputerName"]).output().ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if out.status.success() && !name.is_empty() { Some(name) } else { hw_model() }
}

#[cfg(target_os = "ios")]
fn read_device_name() -> Option<String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let given = unsafe {
        let device: *mut AnyObject = msg_send![AnyClass::get(c"UIDevice")?, currentDevice];
        let name: *mut AnyObject = if device.is_null() { std::ptr::null_mut() } else { msg_send![device, name] };
        let utf8: *const std::ffi::c_char = if name.is_null() { std::ptr::null() } else { msg_send![name, UTF8String] };
        (!utf8.is_null()).then(|| std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned())
    };
    // 권한이 없으면 종류 이름만 온다 — 그걸로는 두 대를 못 가른다
    match given.filter(|n| !matches!(n.trim(), "" | "iPhone" | "iPad" | "iPod touch")) {
        Some(name) => Some(name),
        None => hw_model().map(|id| model_name(&id).map(str::to_owned).unwrap_or(id)),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
fn read_device_name() -> Option<String> {
    None
}

/// 아이폰 모델 번호 → 이름(Xcode 27.2 의 device_traits.db). 표에 없는 새 모델은 번호 그대로 보인다
#[cfg(any(target_os = "ios", test))]
fn model_name(id: &str) -> Option<&'static str> {
    const NAMES: &[(&str, &str)] = &[
        ("iPhone14,2", "iPhone 13 Pro"), ("iPhone14,3", "iPhone 13 Pro Max"), ("iPhone14,4", "iPhone 13 mini"), ("iPhone14,5", "iPhone 13"),
        ("iPhone14,6", "iPhone SE (3세대)"), ("iPhone14,7", "iPhone 14"), ("iPhone14,8", "iPhone 14 Plus"),
        ("iPhone15,2", "iPhone 14 Pro"), ("iPhone15,3", "iPhone 14 Pro Max"), ("iPhone15,4", "iPhone 15"), ("iPhone15,5", "iPhone 15 Plus"),
        ("iPhone16,1", "iPhone 15 Pro"), ("iPhone16,2", "iPhone 15 Pro Max"),
        ("iPhone17,1", "iPhone 16 Pro"), ("iPhone17,2", "iPhone 16 Pro Max"), ("iPhone17,3", "iPhone 16"), ("iPhone17,4", "iPhone 16 Plus"), ("iPhone17,5", "iPhone 16e"),
        ("iPhone18,1", "iPhone 17 Pro"), ("iPhone18,2", "iPhone 17 Pro Max"), ("iPhone18,3", "iPhone 17"), ("iPhone18,4", "iPhone Air"), ("iPhone18,5", "iPhone 17e"),
        ("iPhone19,2", "iPhone 18 Pro"), ("iPhone19,3", "iPhone 18 Pro Max"), ("iPhone19,4", "iPhone Duo"),
    ];
    NAMES.iter().find(|(k, _)| *k == id).map(|(_, v)| *v)
}

/// `sysctl hw.model`(맥)·`hw.machine`(폰). 권한이 필요 없다.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn hw_model() -> Option<String> {
    use std::ffi::{c_char, c_int, c_void};
    extern "C" {
        fn sysctlbyname(name: *const c_char, oldp: *mut c_void, oldlenp: *mut usize, newp: *mut c_void, newlen: usize) -> c_int;
    }
    let key = if cfg!(target_os = "ios") { c"hw.machine" } else { c"hw.model" };
    let mut buf = [0u8; 64];
    let mut len = buf.len();
    let ok = unsafe { sysctlbyname(key.as_ptr(), buf.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) } == 0;
    let text = std::str::from_utf8(buf.get(..len)?).ok()?.trim_end_matches('\0').to_owned();
    (ok && !text.is_empty()).then_some(text)
}

/// 곧 맞춘다(로컬에서 쓴 직후, 창이 앞으로 왔을 때). 꺼져 있으면 아무 일도 없다.
pub fn kick() {
    if let Some(tx) = KICK.get() {
        let _ = tx.send(());
    }
}

fn enabled(conn: &Connection) -> bool {
    state(conn, "enabled").ok().flatten().as_deref() == Some("1")
}

/// 동기화가 켜져 있는데 이번 실행에서 아직 못 맞췄다 — 자동 삭제를 미룬다
pub fn prune_blocked(conn: &Connection) -> bool {
    enabled(conn) && !SYNCED.load(Ordering::Relaxed)
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Option<Key> {
    let s = s.trim();
    if s.len() != 64 {
        return None;
    }
    let mut k = [0u8; 32];
    for (i, b) in k.iter_mut().enumerate() {
        *b = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(k)
}

/// 켜져 있고 등록돼 있으면 서버 정보. 열쇠·토큰은 키체인에서(실행당 한 번 묻는다)
fn server(conn: &Connection) -> AppResult<Option<Server>> {
    if !enabled(conn) {
        return Ok(None);
    }
    creds(conn)
}

/// 등록돼 있으면 서버 정보(켜져 있든 아니든)
fn creds(conn: &Connection) -> AppResult<Option<Server>> {
    let (Some(url), Some(device)) = (state(conn, "url")?, state(conn, "device")?) else { return Ok(None) };
    let token = crate::secrets::sync_get("sync_token")?.ok_or("동기화 토큰이 키체인에 없어. 다시 짝을 맞춰줘.")?;
    let key = crate::secrets::sync_get("sync_key")?.as_deref().and_then(unhex).ok_or("동기화 열쇠가 키체인에 없어. 다시 짝을 맞춰줘.")?;
    Ok(Some(Server { url, token, device, key }))
}

#[derive(Serialize, Clone)]
struct Changed {
    #[serde(flatten)]
    changes: Changes,
    /// 이번 실행에서 처음 다 맞췄다(화면은 이때 미뤄 둔 자동 삭제를 돈다)
    first: bool,
}

fn tick(app: &AppHandle) {
    let db = app.state::<DbState>();
    let srv = match db.0.lock().map_err(AppError::from).and_then(|c| server(&c)) {
        Ok(Some(s)) => s,
        Ok(None) => return,
        Err(e) => {
            if let Ok(c) = db.0.lock() {
                let _ = set_state(&c, "last_error", &e.to_string());
            }
            return;
        }
    };
    let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
    let result = tauri::async_runtime::block_on(round(&db.0, &srv, if focused { now_ms() } else { 0 }));
    let Ok(c) = db.0.lock() else { return };
    match result {
        Ok(changes) => {
            let _ = set_state(&c, "last_error", "");
            drop(c);
            let first = !SYNCED.swap(true, Ordering::Relaxed);
            if first || !changes.is_empty() {
                let _ = app.emit("sync-changed", Changed { changes, first });
            }
        }
        // 서버가 없거나 꺼져 있어도 앱은 그대로 돈다. 다음 주기에 다시
        Err(e) => {
            log::info!("동기화 못 함: {e}");
            let _ = set_state(&c, "last_error", &e.to_string());
        }
    }
}

/// 앱이 켜질 때 한 번. 꺼져 있으면 깨어나서 보고 다시 잔다(네트워크 없음).
pub fn start(app: AppHandle) {
    let (tx, rx) = mpsc::channel();
    if KICK.set(tx).is_err() {
        return;
    }
    std::thread::spawn(move || {
        // 창이 뜨는 동안은 기다린다
        let _ = rx.recv_timeout(Duration::from_secs(3));
        loop {
            tick(&app);
            let focused = app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false);
            let wait = Duration::from_secs(if focused { 15 } else { 300 });
            match rx.recv_timeout(wait) {
                // 연달아 쓴 것(질문·답 저장)을 한 번에 올린다
                Ok(()) => {
                    std::thread::sleep(Duration::from_secs(1));
                    while rx.try_recv().is_ok() {}
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    });
}

// ── 설정 › 동기화 ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    registered: bool,
    url: Option<String>,
    device: Option<String>,
    last_sync: Option<i64>,
    last_error: Option<String>,
}

#[tauri::command(async)]
pub fn sync_status(db: State<'_, DbState>) -> Result<Status, AppError> {
    let c = db.0.lock()?;
    Ok(Status {
        enabled: enabled(&c),
        registered: state(&c, "device")?.is_some(),
        url: state(&c, "url")?,
        device: state(&c, "device")?,
        last_sync: state(&c, "last_sync")?.and_then(|v| v.parse().ok()),
        // 풀지 못해 건너뛴 기록이 있으면 그것부터 알린다(동기화 자체는 됐다고 나와도 일부가 안 보인다)
        last_error: match state(&c, "skipped")?.and_then(|n| n.parse::<i64>().ok()).filter(|n| *n > 0) {
            Some(n) => Some(format!("기록 {n}개를 받지 못했어요. 다른 암호 키로 올라간 기록이에요 — 맥에서 '암호 키 재설정'을 한 뒤 이 기기를 다시 연결해 주세요.")),
            None => state(&c, "last_error")?.filter(|e| !e.is_empty()),
        },
    })
}

#[tauri::command(async)]
pub fn sync_enable(db: State<'_, DbState>, on: bool) -> Result<(), AppError> {
    {
        let c = db.0.lock()?;
        if on && state(&c, "device")?.is_none() {
            return Err(AppError::msg("먼저 서버에 이 맥을 등록하거나 기기 연결 코드를 붙여넣어 주세요."));
        }
        set_state(&c, "enabled", if on { "1" } else { "0" })?;
    }
    kick();
    Ok(())
}

#[tauri::command]
pub fn sync_now() {
    kick();
}

/// 서버 주소를 주소 해석기로 읽어 확인하고 다듬는다: https 만(로컬 시험 `wrangler dev` 는 호스트가 정확히
/// 127.0.0.1·localhost 인 http), 사용자 정보(`user@`)·질의·조각은 거절한다. 앞글자만 보면
/// `http://localhost@evil.example`·`http://127.0.0.1.evil.example` 이 통과하고, 확인 창에 보이는 주소도 속일 수 있다.
fn check_url(url: &str) -> AppResult<String> {
    let bad = || AppError::msg("서버 주소는 https:// 로 시작해야 해요.");
    let parsed = tauri::Url::parse(url.trim()).map_err(|_| bad())?;
    let host = parsed.host_str().ok_or_else(bad)?;
    let local = parsed.scheme() == "http" && (host == "127.0.0.1" || host == "localhost");
    if !(parsed.scheme() == "https" || local) || !parsed.username().is_empty() || parsed.password().is_some() || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(bad());
    }
    let port = parsed.port().map(|p| format!(":{p}")).unwrap_or_default();
    Ok(format!("{}://{host}{port}{}", parsed.scheme(), parsed.path().trim_end_matches('/')))
}

/// 확인 창에 보일 서버(호스트와 포트만). `check_url` 을 지난 주소에서만 부른다
fn host_of(url: &str) -> String {
    tauri::Url::parse(url).ok().and_then(|u| u.host_str().map(|h| match u.port() { Some(p) => format!("{h}:{p}"), None => h.to_owned() })).unwrap_or_default()
}

#[derive(Deserialize)]
struct Registered {
    device_id: String,
    token: String,
}

async fn register(url: &str, body: Value) -> AppResult<Registered> {
    call(reqwest::Method::POST, url, "/v1/devices", None, &body).await
}

/// 등록을 적는다. 새 서버(또는 새 등록)라 처음부터 받고, 가진 것은 전부 다시 올린다.
/// `joining`: 이미 쓰는 기기들에 끼어드는 것(짝 문자열)이면 같이 쓰는 설정은 그쪽 것을 따른다(`yield_settings`).
fn save(db: &DbState, url: &str, reg: Registered, key: &Key, joining: bool) -> AppResult<()> {
    crate::secrets::sync_set("sync_token", &reg.token)?;
    crate::secrets::sync_set("sync_key", &hex(key))?;
    let c = db.0.lock()?;
    for (k, v) in [("url", url), ("device", reg.device_id.as_str()), ("since", "0"), ("enabled", "1"), ("last_error", "")] {
        set_state(&c, k, v)?;
    }
    c.execute("UPDATE sync_meta SET dirty = 1", [])?;
    if joining {
        super::yield_settings(&c)?;
    }
    drop(c);
    kick();
    Ok(())
}

/// 첫 기기(이 맥): 배포 때 정한 SETUP_TOKEN 으로 등록하고 동기화 열쇠를 새로 만든다.
#[tauri::command]
pub async fn sync_setup(db: State<'_, DbState>, url: String, setup_token: String) -> Result<(), AppError> {
    let url = check_url(&url)?;
    let reg = register(&url, serde_json::json!({ "name": device_name(), "setup_token": setup_token.trim() })).await?;
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    save(&db, &url, reg, &key, false)
}

#[derive(Serialize, Deserialize)]
struct Pairing {
    u: String,
    c: String,
    k: String,
    /// Claude API 키(고르면 싣는다, §6.4). 폰에서 긴 키를 치지 않게 — 받는 기기가 자기 키체인에 넣는다
    #[serde(default, skip_serializing_if = "Option::is_none")]
    a: Option<String>,
}

/// 짝 문자열: 서버 주소 + 1회용 짝 코드(10분) + 동기화 열쇠(+ `with_claude` 면 Claude API 키).
/// 화면에 잠깐 보이고 서버엔 안 올라간다(§3.2).
#[tauri::command]
pub async fn sync_pair_make(db: State<'_, DbState>, with_claude: Option<bool>) -> Result<String, AppError> {
    let srv = creds(&*db.0.lock()?)?.ok_or("먼저 서버에 이 맥을 등록해줘.")?;
    let a = if with_claude.unwrap_or(false) { crate::secrets::get("anthropic_api_key")?.filter(|k| !k.is_empty()) } else { None };
    #[derive(Deserialize)]
    struct Code {
        code: String,
    }
    let code: Code = call(reqwest::Method::POST, &srv.url, "/v1/pair", Some(&srv.token), &serde_json::json!({})).await?;
    let json = serde_json::to_string(&Pairing { u: srv.url, c: code.code, k: hex(&srv.key), a }).map_err(|e| AppError::msg(e.to_string()))?;
    Ok(format!("{PAIR_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)))
}

/// 폰 카메라로 찍으면 앱이 열리는 주소(Info.ios.plist 의 nekodesk 스킴). 내용은 짝 문자열 그대로다.
const PAIR_LINK: &str = "nekodesk://pair?d=";

/// 짝 문자열을 QR(SVG 글)로. 폰에서는 긴 코드를 칠 수 없으니 카메라로 찍어 연다. 화면에만 그리고 어디에도 안 남긴다.
#[cfg(desktop)]
#[tauri::command(async)]
pub fn sync_pair_qr(pairing: String) -> Result<String, AppError> {
    let body = pairing.trim().strip_prefix(PAIR_PREFIX).ok_or("기기 연결 코드 형식이 아니에요.")?;
    qr_svg(&format!("{PAIR_LINK}{body}"))
}

/// 가운데 발바닥(도트 그림). 이 둘레 한 칸까지 QR 칸을 비운다
#[cfg(desktop)]
const PAW: [&str; 8] = [
    "..##...##..",
    "..##...##..",
    "##.......##",
    "##..###..##",
    "...#####...",
    "..#######..",
    "..#######..",
    "...##.##...",
];

/// 도트 느낌의 QR: 칸마다 틈을 둔 둥근 네모, 가운데에 발바닥. 가운데를 비우는 만큼(전체 칸의 2% 남짓)은
/// 오류 정정(M, 15%)이 메운다 — 찍히는지는 qa/qr-read.mjs 로 확인한다.
#[cfg(desktop)]
fn qr_svg(text: &str) -> AppResult<String> {
    use std::fmt::Write;
    let code = qrcode::QrCode::with_error_correction_level(text, qrcode::EcLevel::M)
        .map_err(|e| AppError::msg(format!("QR 을 만들지 못했어요: {e}")))?;
    let (n, cells) = (code.width(), code.to_colors());
    const QUIET: usize = 4;
    let (pw, ph) = (PAW[0].len(), PAW.len());
    let (px, py) = ((n - pw) / 2, (n - ph) / 2);
    let hole = |x: usize, y: usize| x + 1 >= px && x <= px + pw && y + 1 >= py && y <= py + ph;
    let dot = |out: &mut String, x: usize, y: usize| {
        let _ = write!(out, "M{}.06 {}.06h.88v.88h-.88z", x + QUIET, y + QUIET);
    };
    let (mut dark, mut paw) = (String::new(), String::new());
    for y in 0..n {
        for x in 0..n {
            if cells[y * n + x] == qrcode::Color::Dark && !hole(x, y) {
                dot(&mut dark, x, y);
            }
        }
    }
    for (y, row) in PAW.iter().enumerate() {
        for (x, c) in row.bytes().enumerate() {
            if c == b'#' {
                dot(&mut paw, px + x, py + y);
            }
        }
    }
    let size = n + 2 * QUIET;
    Ok(format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="440" height="440"><rect width="{size}" height="{size}" rx="3" fill="#fff"/><path d="{dark}" fill="#1d2b38"/><path d="{paw}" fill="#75a7ce"/></svg>"##
    ))
}

/// 폰: 카메라로 찍어 열린 주소(`nekodesk://pair?d=…`)에서 짝 문자열을 꺼낸다. 다른 주소면 None.
/// 주소는 아무 앱·웹 링크나 열 수 있으니 여기서 바로 연결하지 않는다 — 화면이 서버 주소를 보여 주고 사용자가 확인해야 한다.
pub fn pairing_from_link(url: &str) -> Option<String> {
    let body = url.strip_prefix(PAIR_LINK)?;
    let pairing = format!("{PAIR_PREFIX}{body}");
    parse_pairing(&pairing).ok().map(|_| pairing)
}

/// 앱 안에서 찍은 QR 의 주소를 짝 문자열과 서버(해석한 호스트·포트)로. 연결 주소가 아니면 None — 화면은 이걸로 확인 창을 띄운다.
#[tauri::command]
pub fn sync_pair_check(link: String) -> Option<(String, String)> {
    let pairing = pairing_from_link(link.trim())?;
    let (url, ..) = parse_pairing(&pairing).ok()?;
    Some((pairing, host_of(&url)))
}

/// 폰: 찍어 온 짝 문자열을 화면이 가져갈 때까지 들고 있는다(앱이 그 주소로 켜지면 화면이 아직 없다).
#[cfg(target_os = "ios")]
static LINKED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[cfg(target_os = "ios")]
pub fn link_opened(app: &AppHandle, url: &str) {
    let Some(pairing) = pairing_from_link(url) else { return };
    if let Ok(mut slot) = LINKED.lock() {
        *slot = Some(pairing);
    }
    let _ = app.emit("pair-link", ());
}

/// 폰: 찍어 온 짝 문자열과 그 서버(해석한 호스트·포트 — 확인 창에 보인다). 한 번 가져가면 비운다.
#[cfg(target_os = "ios")]
#[tauri::command]
pub fn sync_pair_linked() -> Option<(String, String)> {
    let pairing = LINKED.lock().ok()?.take()?;
    let (url, ..) = parse_pairing(&pairing).ok()?;
    Some((pairing, host_of(&url)))
}

fn parse_pairing(s: &str) -> AppResult<(String, String, Key, Option<String>)> {
    let bad = || AppError::msg("기기 연결 코드 형식이 아니에요. 다시 복사해 주세요.");
    let body = s.trim().strip_prefix(PAIR_PREFIX).ok_or_else(bad)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body).map_err(|_| bad())?;
    let p: Pairing = serde_json::from_slice(&raw).map_err(|_| bad())?;
    Ok((check_url(&p.u)?, p.c, unhex(&p.k).ok_or_else(bad)?, p.a.filter(|a| !a.trim().is_empty())))
}

/// 다른 기기에서 만든 짝 문자열로 이 기기를 등록한다(같은 열쇠). Claude API 키가 실려 왔으면 등록된 뒤
/// 이 기기 키체인에 넣는다.
#[tauri::command]
pub async fn sync_pair_join(db: State<'_, DbState>, pairing: String) -> Result<(), AppError> {
    let (url, code, key, claude) = parse_pairing(&pairing)?;
    let reg = register(&url, serde_json::json!({ "name": device_name(), "pair_code": code })).await?;
    save(&db, &url, reg, &key, true)?;
    if let Some(k) = claude {
        crate::secrets::set("anthropic_api_key", &k)?;
    }
    Ok(())
}

// ── 기기 목록·끊기·열쇠 바꾸기 ───────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
pub struct Device {
    id: String,
    name: String,
    created_at: i64,
    last_seen: Option<i64>,
    revoked: i64,
}

#[derive(Serialize, Deserialize)]
pub struct Devices {
    devices: Vec<Device>,
    me: String,
}

fn registered(db: &DbState) -> AppResult<Server> {
    Ok(creds(&*db.0.lock()?)?.ok_or("먼저 서버에 이 맥을 등록해줘.")?)
}

/// 서버 정보와 기기 목록. 토큰이 가리키는 기기(서버가 알려 주는 `me`)가 DB 가 아는 기기와 다르면 DB 를 토큰 쪽에 맞춘다.
/// 키체인의 토큰이 다른 등록 것으로 바뀐 경우다 — dev 빌드와 배포 버전이 키체인 이름을 같이 쓰던 때 dev 에서 등록하면
/// 그랬다. 안 맞추면 '다른 기기 끊기'(열쇠 바꾸기)가 제 토큰의 기기를 끊어, 그 뒤 요청이 다 거절된다.
async fn checked(db: &DbState) -> AppResult<(Server, Devices)> {
    let mut srv = registered(db)?;
    let list: Devices = call(reqwest::Method::GET, &srv.url, "/v1/devices", Some(&srv.token), &Value::Null).await?;
    if list.me != srv.device {
        log::warn!("동기화: 토큰의 기기가 DB 와 달라 DB 를 맞춘다");
        set_state(&*db.0.lock()?, "device", &list.me)?;
        srv.device = list.me.clone();
    }
    Ok((srv, list))
}

#[tauri::command]
pub async fn sync_devices(db: State<'_, DbState>) -> Result<Devices, AppError> {
    Ok(checked(&db).await?.1)
}

/// 다른 기기를 끊는다(토큰이 더는 안 통하고, 그 기기가 만든 짝 코드도 지워진다). 열쇠는 그 기기에 남으니
/// 잃어버린 기기면 열쇠 바꾸기도 한다.
#[tauri::command]
pub async fn sync_revoke(db: State<'_, DbState>, id: String) -> Result<(), AppError> {
    let (srv, _) = checked(&db).await?;
    if id == srv.device {
        return Err(AppError::msg("이 맥은 여기서 끊을 수 없어요. 동기화를 끄면 돼요."));
    }
    let _: Value = call(reqwest::Method::DELETE, &srv.url, &format!("/v1/devices/{id}"), Some(&srv.token), &Value::Null).await?;
    Ok(())
}

/// 이 맥 말고 살아 있는 기기를 다 끊는다
pub(crate) async fn revoke_others(srv: &Server) -> AppResult<()> {
    let list: Devices = call(reqwest::Method::GET, &srv.url, "/v1/devices", Some(&srv.token), &Value::Null).await?;
    for d in list.devices.iter().filter(|d| d.id != srv.device && d.revoked == 0) {
        let _: Value = call(reqwest::Method::DELETE, &srv.url, &format!("/v1/devices/{}", d.id), Some(&srv.token), &Value::Null).await?;
    }
    Ok(())
}

/// 열쇠 바꾸기의 서버 쪽: 짝 코드 무효화(옛 짝 문자열로 새 기기가 못 들어오게) → 다른 기기 끊기 → 기록·짝 코드 비우기
pub(crate) async fn rekey_server(srv: &Server) -> AppResult<()> {
    let _: Value = call(reqwest::Method::DELETE, &srv.url, "/v1/pair", Some(&srv.token), &Value::Null).await?;
    revoke_others(srv).await?;
    let _: Value = call(reqwest::Method::POST, &srv.url, "/v1/reset", Some(&srv.token), &serde_json::json!({})).await?;
    Ok(())
}

/// 열쇠 바꾸기(§3.2): 짝 코드를 죽이고, 다른 기기를 모두 끊고, 서버 기록을 비우고, 새 열쇠로 이 맥 것을 처음부터
/// 다시 올린다. 끝에 기기 목록을 다시 읽어 그사이 들어온 기기도 끊는다. 다른 기기는 새 짝 문자열로 다시 맞춘다.
#[tauri::command]
pub async fn sync_rekey(db: State<'_, DbState>) -> Result<(), AppError> {
    let (srv, _) = checked(&db).await?;
    rekey_server(&srv).await?;
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    crate::secrets::sync_set("sync_key", &hex(&key))?;
    {
        let c = db.0.lock()?;
        set_state(&c, "since", "0")?;
        c.execute("UPDATE sync_meta SET dirty = 1", [])?;
    }
    kick();
    revoke_others(&srv).await
}

// ── 산책: 기기들이 같은 산책 하나를 나눠 쓴다(§5.4) ─────────────────────────────

/// 화면에 주는 마지막 산책. mine = 이 기기가 나간 것
#[derive(Serialize)]
pub struct WalkSeen {
    start: i64,
    end: i64,
    mine: bool,
}

fn seen(conn: &Connection) -> AppResult<Option<WalkSeen>> {
    let me = state(conn, "device")?.unwrap_or_default();
    Ok(stored_walk(conn)?.map(|w| WalkSeen { start: w.start, end: w.end, mine: w.device == me }))
}

/// 기기들이 같이 보는 마지막 산책(동기화가 받아 둔 것). 동기화를 안 쓰면 None
#[tauri::command(async)]
pub fn walk_shared(db: State<'_, DbState>) -> Result<Option<WalkSeen>, AppError> {
    let c = db.0.lock()?;
    if !enabled(&c) {
        return Ok(None);
    }
    seen(&c)
}

#[derive(Serialize)]
pub struct Claimed {
    /// 나가도 된다. false 면 다른 기기가 먼저 나갔다(walk 가 그 산책)
    ok: bool,
    walk: Option<WalkSeen>,
}

/// 나가기 전에 서버에 선점한다. 동기화를 안 쓰거나 서버에 못 닿으면(오프라인·옛 서버) 혼자 나간다 — 전과 같다.
#[tauri::command]
pub async fn walk_claim(db: State<'_, DbState>, start: i64, end: i64) -> Result<Claimed, AppError> {
    let (srv, prev) = {
        let c = db.0.lock()?;
        match server(&c)? {
            Some(srv) => (srv, stored_walk(&c)?.map(|w| w.start).unwrap_or(0)),
            None => return Ok(Claimed { ok: true, walk: None }),
        }
    };
    #[derive(Deserialize)]
    struct Resp {
        ok: bool,
        walk: Option<SharedWalk>,
    }
    let body = serde_json::json!({ "start": start, "end": end, "prev": prev });
    let Ok(resp) = call::<Resp>(reqwest::Method::POST, &srv.url, "/v1/walk/claim", Some(&srv.token), &body).await else {
        return Ok(Claimed { ok: true, walk: None });
    };
    let c = db.0.lock()?;
    store_walk(&c, resp.walk.as_ref())?;
    Ok(Claimed { ok: resp.ok, walk: seen(&c)? })
}

/// 나간 기기가 끝 시각을 고친다(서둘러 돌아옴·도착). 못 알려도 그만이다 — 적어 둔 끝 시각에 끝난 것으로 친다.
#[tauri::command]
pub async fn walk_end(db: State<'_, DbState>, start: i64, end: i64) -> Result<(), AppError> {
    let Some(srv) = server(&*db.0.lock()?)? else { return Ok(()) };
    #[derive(Deserialize)]
    struct Resp {
        walk: Option<SharedWalk>,
    }
    let body = serde_json::json!({ "start": start, "end": end });
    if let Ok(resp) = call::<Resp>(reqwest::Method::POST, &srv.url, "/v1/walk/end", Some(&srv.token), &body).await {
        store_walk(&*db.0.lock()?, resp.walk.as_ref())?;
    }
    Ok(())
}

// ── 세션 목록(화면의 sessionStore) ───────────────────────────────────────────

#[tauri::command(async)]
pub fn session_list(db: State<'_, DbState>) -> Result<Vec<SessionRow>, AppError> {
    super::session_list(&*db.0.lock()?)
}

#[tauri::command(async)]
pub fn session_put(db: State<'_, DbState>, id: String, title: String, created_at: i64) -> Result<(), AppError> {
    super::session_put(&*db.0.lock()?, &id, &title, created_at)?;
    kick();
    Ok(())
}

#[tauri::command(async)]
pub fn session_import(db: State<'_, DbState>, sessions: Vec<SessionRow>) -> Result<(), AppError> {
    super::session_import(&*db.0.lock()?, &sessions)
}

#[tauri::command(async)]
pub fn session_read(db: State<'_, DbState>, id: String, at: i64) -> Result<(), AppError> {
    super::session_read(&*db.0.lock()?, &id, at)
}

#[tauri::command(async)]
pub fn session_delete(db: State<'_, DbState>, id: String) -> Result<(), AppError> {
    super::session_delete(&*db.0.lock()?, &id)?;
    kick();
    Ok(())
}

#[tauri::command(async)]
pub fn session_compact(db: State<'_, DbState>, id: String, summary: String) -> Result<(), AppError> {
    super::session_compact(&*db.0.lock()?, &id, &summary)?;
    kick();
    Ok(())
}

// ── 선물함(화면의 neko/gifts.ts): 하나씩 바꾼다 ──────────────────────────────

#[tauri::command(async)]
pub fn gift_add(db: State<'_, DbState>, gift: Value) -> Result<(), AppError> {
    super::gift_add(&*db.0.lock()?, &gift)?;
    kick();
    Ok(())
}

#[tauri::command(async)]
pub fn gift_patch(db: State<'_, DbState>, id: String, patch: Value) -> Result<bool, AppError> {
    let hit = super::gift_patch(&*db.0.lock()?, &id, &patch)?;
    kick();
    Ok(hit)
}

#[tauri::command(async)]
pub fn gift_remove(db: State<'_, DbState>, ids: Vec<String>) -> Result<(), AppError> {
    super::gift_remove(&*db.0.lock()?, &ids)?;
    kick();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_string_round_trips_and_rejects_junk() {
        let key = [7u8; 32];
        let json = serde_json::to_string(&Pairing { u: "https://sync.example.com".into(), c: "code".into(), k: hex(&key), a: None }).unwrap();
        let s = format!("{PAIR_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&json));
        let (u, c, k, a) = parse_pairing(&format!("  {s}\n")).unwrap();
        assert_eq!((u.as_str(), c.as_str(), k, a), ("https://sync.example.com", "code", key, None));
        // Claude API 키는 골랐을 때만 실린다. 안 실린 문자열엔 그 칸 자체가 없다(0.1.15 가 만든 것과 같은 모양)
        assert!(!json.contains("\"a\""));
        let with = serde_json::to_string(&Pairing { u: "https://sync.example.com".into(), c: "code".into(), k: hex(&key), a: Some("sk-test".into()) }).unwrap();
        let s = format!("{PAIR_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(with));
        assert_eq!(parse_pairing(&s).unwrap().3.as_deref(), Some("sk-test"));
        assert!(parse_pairing("nekosync1:!!!").is_err());
        // 기기 이름: 비지 않고 80자 안, 제어 문자 없음. 폰은 권한 없이 모델 번호를 이름으로 바꾼다
        let name = device_name();
        assert!(!name.is_empty() && name.chars().count() <= 80 && !name.chars().any(char::is_control), "{name}");
        assert_eq!(model_name("iPhone14,4"), Some("iPhone 13 mini"));
        assert_eq!(model_name("iPhone18,3"), Some("iPhone 17"));
        assert_eq!(model_name("iPhone99,9"), None);
        // 카메라로 찍은 주소: 짝 문자열로 되돌아오고, 모양이 아니거나 다른 주소면 버린다
        let link = format!("{PAIR_LINK}{}", s.trim_start_matches(PAIR_PREFIX));
        assert_eq!(pairing_from_link(&link).as_deref(), Some(s.as_str()));
        assert_eq!(pairing_from_link("nekodesk://pair?d=!!!"), None);
        assert_eq!(pairing_from_link("https://example.com/pair?d=x"), None);
        // 맥이 그리는 QR: Claude API 키까지 실린 긴 코드도 한 장에 들어간다
        let long = serde_json::to_string(&Pairing { u: "https://sync.example.com".into(), c: "c".repeat(32), k: hex(&key), a: Some("sk-ant-api03-".to_owned() + &"x".repeat(95)) }).unwrap();
        let long = format!("{PAIR_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(long));
        let svg = sync_pair_qr(long).unwrap();
        assert!(svg.contains("<svg"));
        // 찍히는지 확인할 때: NEKO_QR_OUT=/tmp/qr.svg cargo test --lib sync::run && node qa/qr-read.mjs /tmp/qr.svg
        if let Ok(out) = std::env::var("NEKO_QR_OUT") {
            std::fs::write(out, &svg).unwrap();
        }
        assert!(sync_pair_qr("hello".into()).is_err());
        assert!(parse_pairing("hello").is_err());
        // http 는 로컬 시험 서버만
        assert!(check_url("http://sync.example.com").is_err());
        assert_eq!(check_url("http://127.0.0.1:8787/").unwrap(), "http://127.0.0.1:8787");
        assert_eq!(check_url(" https://sync.example.com/ ").unwrap(), "https://sync.example.com");
        // 앞글자만 맞춘 주소·사용자 정보로 호스트를 가린 주소는 거절한다
        for evil in ["http://127.0.0.1.evil.example", "http://localhost.evil.example", "http://localhost@evil.example", "https://sync.example.com@evil.example", "https://user:pw@evil.example", "https://evil.example/?x=https://sync.example.com", "https://evil.example/#sync.example.com", "ftp://sync.example.com", "sync.example.com"] {
            assert!(check_url(evil).is_err(), "{evil}");
        }
        assert_eq!(host_of("https://sync.example.com/base"), "sync.example.com");
        assert_eq!(host_of("http://127.0.0.1:8787"), "127.0.0.1:8787");
    }
}
