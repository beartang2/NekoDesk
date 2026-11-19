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
        last_error: state(&c, "last_error")?.filter(|e| !e.is_empty()),
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

fn check_url(url: &str) -> AppResult<String> {
    let url = url.trim().trim_end_matches('/').to_owned();
    // 로컬 시험(wrangler dev)만 http 를 받는다
    let local = url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost");
    if url.starts_with("https://") || local {
        Ok(url)
    } else {
        Err(AppError::msg("서버 주소는 https:// 로 시작해야 해요."))
    }
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
fn save(db: &DbState, url: &str, reg: Registered, key: &Key) -> AppResult<()> {
    crate::secrets::sync_set("sync_token", &reg.token)?;
    crate::secrets::sync_set("sync_key", &hex(key))?;
    let c = db.0.lock()?;
    for (k, v) in [("url", url), ("device", reg.device_id.as_str()), ("since", "0"), ("enabled", "1"), ("last_error", "")] {
        set_state(&c, k, v)?;
    }
    c.execute("UPDATE sync_meta SET dirty = 1", [])?;
    drop(c);
    kick();
    Ok(())
}

/// 첫 기기(이 맥): 배포 때 정한 SETUP_TOKEN 으로 등록하고 동기화 열쇠를 새로 만든다.
#[tauri::command]
pub async fn sync_setup(db: State<'_, DbState>, url: String, setup_token: String) -> Result<(), AppError> {
    let url = check_url(&url)?;
    let reg = register(&url, serde_json::json!({ "name": "Mac", "setup_token": setup_token.trim() })).await?;
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    save(&db, &url, reg, &key)
}

#[derive(Serialize, Deserialize)]
struct Pairing {
    u: String,
    c: String,
    k: String,
}

/// 짝 문자열: 서버 주소 + 1회용 짝 코드(10분) + 동기화 열쇠. 화면에 잠깐 보이고 서버엔 안 올라간다(§3.2).
/// ponytail: Claude API 키 싣기(§6.4)는 폰이 생기는 3단계에서.
#[tauri::command]
pub async fn sync_pair_make(db: State<'_, DbState>) -> Result<String, AppError> {
    let srv = creds(&*db.0.lock()?)?.ok_or("먼저 서버에 이 맥을 등록해줘.")?;
    #[derive(Deserialize)]
    struct Code {
        code: String,
    }
    let code: Code = call(reqwest::Method::POST, &srv.url, "/v1/pair", Some(&srv.token), &serde_json::json!({})).await?;
    let json = serde_json::to_string(&Pairing { u: srv.url, c: code.code, k: hex(&srv.key) }).map_err(|e| AppError::msg(e.to_string()))?;
    Ok(format!("{PAIR_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json)))
}

fn parse_pairing(s: &str) -> AppResult<(String, String, Key)> {
    let bad = || AppError::msg("기기 연결 코드 형식이 아니에요. 다시 복사해 주세요.");
    let body = s.trim().strip_prefix(PAIR_PREFIX).ok_or_else(bad)?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(body).map_err(|_| bad())?;
    let p: Pairing = serde_json::from_slice(&raw).map_err(|_| bad())?;
    Ok((check_url(&p.u)?, p.c, unhex(&p.k).ok_or_else(bad)?))
}

/// 다른 기기에서 만든 짝 문자열로 이 기기를 등록한다(같은 열쇠).
#[tauri::command]
pub async fn sync_pair_join(db: State<'_, DbState>, pairing: String) -> Result<(), AppError> {
    let (url, code, key) = parse_pairing(&pairing)?;
    let reg = register(&url, serde_json::json!({ "name": "Mac", "pair_code": code })).await?;
    save(&db, &url, reg, &key)
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

#[tauri::command]
pub async fn sync_devices(db: State<'_, DbState>) -> Result<Devices, AppError> {
    let srv = registered(&db)?;
    call(reqwest::Method::GET, &srv.url, "/v1/devices", Some(&srv.token), &Value::Null).await
}

/// 다른 기기를 끊는다(토큰이 더는 안 통하고, 그 기기가 만든 짝 코드도 지워진다). 열쇠는 그 기기에 남으니
/// 잃어버린 기기면 열쇠 바꾸기도 한다.
#[tauri::command]
pub async fn sync_revoke(db: State<'_, DbState>, id: String) -> Result<(), AppError> {
    let srv = registered(&db)?;
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
    let srv = registered(&db)?;
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
        let json = serde_json::to_string(&Pairing { u: "https://sync.example.com".into(), c: "code".into(), k: hex(&key) }).unwrap();
        let s = format!("{PAIR_PREFIX}{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json));
        let (u, c, k) = parse_pairing(&format!("  {s}\n")).unwrap();
        assert_eq!((u.as_str(), c.as_str(), k), ("https://sync.example.com", "code", key));
        assert!(parse_pairing("nekosync1:!!!").is_err());
        assert!(parse_pairing("hello").is_err());
        // http 는 로컬 시험 서버만
        assert!(check_url("http://sync.example.com").is_err());
        assert!(check_url("http://127.0.0.1:8787/").is_ok());
    }
}
