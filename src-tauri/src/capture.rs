//! 네코 캡처 — 클릭하면 그 창, 드래그하면 그 영역.
//!
//! macOS 의 `screencapture -i` 는 영역(드래그)과 창(클릭) 중 한 모드로 시작해 스페이스로
//! 오간다. 둘을 한 번에 받으려고 고르는 화면을 직접 띄운다: 모니터마다 투명한 막 창을
//! 올리고(CaptureOverlay.tsx), 거기서 고른 것을 받은 뒤 막을 걷고
//! `screencapture -l 창번호` / `-R 영역` 으로 찍는다.
//!
//! 막 창은 **부수지 않고 숨겨 두었다가 다시 쓴다.** 패널로 클래스를 바꾼 창을 닫으면
//! (tao 의 close) 메인 스레드에서 앱이 통째로 죽었다. 빠른 질문 창도 같은 이유로 숨기기만 한다.
//! 다시 쓸 때는 `capture-start` 를 보내 이전 상태를 지우게 한다.
//!
//! 좌표는 전부 **포인트, 왼쪽 위 원점**(주 모니터 왼쪽 위가 0,0)이다. CGWindowList 의
//! 창 위치와 `screencapture -R` 이 이 좌표를 쓴다. NSScreen 은 왼쪽 아래 원점이라
//! 들어올 때 한 번 뒤집는다.

use serde::{Deserialize, Serialize};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};

use crate::error::AppError;

/// 고르는 화면을 이만큼 두면 그만둔 것으로 본다.
const PICK_TIMEOUT: Duration = Duration::from_secs(120);
/// 막을 닫은 뒤 화면에서 사라질 때까지. 바로 찍으면 막의 마지막 프레임이 찍힌다.
const SETTLE: Duration = Duration::from_millis(120);
/// 숨기기 전, 막이 "끝"(capture-end)을 받고 빈 화면을 그릴 시간. 안 기다리고 숨기면 덮개가 남은
/// 채로 숨었다가, 빨리 다시 켰을 때 그 덮개가 한 프레임 비치고 사라져 깜빡였다.
const CLEAR: Duration = Duration::from_millis(60);
/// 마우스를 직접 읽는 간격(초당 30번).
///
/// 막은 앱을 활성화하지 않는 패널이라 마우스 움직임은 키 창인 막 하나만 받는다. 모니터와
/// 데스크톱(Space)을 오가다 보면 macOS 가 키를 다른 앱에 넘기고, 막은 끝내 되찾지 못해
/// 마지막으로 강조한 창 하나에 굳었다. 그래서 키 창에 기대지 않고 마우스 위치·버튼을 직접
/// 읽어 커서 아래 막에 보낸다(`capture-cursor`). 막은 브라우저 이벤트가 끊기면 이걸 쓴다.
const FOLLOW_EVERY: Duration = Duration::from_millis(33);
/// 이만큼(FOLLOW_EVERY 의 배수)마다 커서 아래 막을 다시 키 창으로 — esc·십자 커서용.
/// 실패해도 위의 직접 읽기가 있어 고르기는 된다.
const REFOCUS_TICKS: u32 = 30;
/// 밝기 지도를 다시 읽는 간격(FOLLOW_EVERY 의 배수, 2초). 막 아래 화면만 읽으니 막은 안 찍힌다.
/// 처음 한 장만 쓰면 캡처 중 데스크톱을 옮기거나 화면이 바뀌어도 옛 화면 밝기를 봤다.
/// 화면 읽기는 WindowServer 에도 일을 시켜 자주 하면 움직임이 끊긴다 — 평소엔 2초, 데스크톱을
/// 다 넘긴 뒤(is_moving 이 풀릴 때) 그 모니터만 바로 한 번.
const LUM_TICKS: u32 = 60;
/// 밝기 지도의 가로 칸 수. 발바닥 정중앙 한 점을 읽으니 한 칸이 발바닥(18pt)보다 충분히 작아야 한다.
const LUM_W: usize = 512;
/// 손을 뗀 뒤 macOS 가 마저 넘기는 시간. 손을 떼고 0.43~0.54초 뒤에 창 목록이 넘어간 데스크톱
/// 것으로 줄었다(2026-10, macOS 27.2 에서 잼). 그동안은 넘기는 중으로 본다. 600 이었을 땐 목록이
/// 그보다 늦게 줄면, 다 넘긴 줄 알고 빛을 퍼뜨렸다가 목록이 줄자 다시 모았다가 또 퍼뜨렸다.
const AFTER_SWIPE_MS: u64 = 750;
/// 창 목록이 바뀐 뒤 이만큼 조용해야 다 넘어간 것으로 본다.
const QUIET_MS: u64 = 250;
/// 다 넘긴 뒤 이만큼은 창 목록이 바뀌어도 넘기기로 치지 않는다. 넘어간 데스크톱의 창들이 뒤늦게
/// 하나둘 나타나며 목록이 또 바뀌는데, 그걸 넘기기로 보면 퍼지던 빛이 다시 모였다.
const SETTLE_MS: u64 = 700;
/// 손을 안 뗀 채 이보다 오래 가면 끝 신호를 놓친 것으로 본다.
const MAX_SWIPE_MS: u64 = 5000;

/// 커서 아래 막에 보내는 마우스. 좌표는 그 막(모니터) 기준.
#[derive(Clone, Copy, Serialize, PartialEq)]
struct Cursor {
    x: f64,
    y: f64,
    down: bool,
}

#[derive(Clone, Copy, Serialize, Deserialize, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
pub struct Target {
    pub id: u32,
    pub app: String,
    #[serde(flatten)]
    pub rect: Rect,
}

/// 막 창 하나가 처음에 받아 가는 것: 자기 모니터 위치와, 강조할 수 있는 창들(앞에서부터),
/// 그 모니터의 밝기 지도. 밝기 지도는 발바닥·발자국·가장자리 빛이 밑바탕에 맞춰 밝거나
/// 어둡게 되는 데만 쓴다 — 투명한 막은 뒤에 있는 다른 앱의 화면을 볼 수 없다.
#[derive(Clone, Serialize)]
pub struct Targets {
    pub screen: Rect,
    pub windows: Vec<Target>,
    pub lum: Option<Lum>,
    /// 캡처를 시작할 때 커서가 이 모니터에 있었으면 그 자리(모니터 기준). 막이 거기서 퍼지며 켜진다.
    pub start: Option<[f64; 2]>,
}

/// 밝기 지도: 화면을 흑백 LUM_W 칸 너비로 줄인 것. 한 칸 1바이트(0 검정 ~ 255 흰색), base64.
#[derive(Clone, Serialize)]
pub struct Lum {
    w: usize,
    h: usize,
    data: String,
}

#[derive(Clone, Deserialize, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Pick {
    Window { id: u32 },
    Region { rect: Rect },
}

/// 진행 중인 캡처 하나. 막 창이 `capture_targets` 로 읽고 `capture_pick` 으로 답한다.
#[derive(Default)]
pub struct CaptureState(Mutex<Option<Session>>);

struct Session {
    screens: Vec<Rect>,
    /// 시작할 때 커서 자리(전체 화면 기준).
    mouse: Option<[f64; 2]>,
    lums: Vec<Option<Lum>>,
    windows: Vec<Target>,
    reply: mpsc::Sender<Option<Pick>>,
}

fn label(i: usize) -> String {
    format!("capture-{i}")
}

/// 막 창 라벨 → 모니터 번호.
fn screen_index(label: &str) -> Option<usize> {
    label.strip_prefix("capture-")?.parse().ok()
}

/// screens[i] 모니터의 창들, 앞에 있는 것부터. 두 모니터에 걸친 창은 더 많이 걸친 쪽에만 넣는다 —
/// "모니터마다 별도의 데스크톱"(기본값)이면 macOS 는 창을 한 모니터에만 그리고 넘친 부분은 옆
/// 모니터에 안 보인다. 걸치기만 해도 넣었더니, 옆 모니터 가장자리에 보이지도 않는 창 자리가 밝게
/// 뚫려 어두운 면과 밝은 면의 경계가 생겼다.
fn windows_on(windows: &[Target], screens: &[Rect], i: usize) -> Vec<Target> {
    windows.iter().filter(|t| home(&t.rect, screens) == Some(i)).cloned().collect()
}

/// 이 창이 가장 많이 걸친 모니터. 어디에도 안 걸쳤으면 None.
fn home(rect: &Rect, screens: &[Rect]) -> Option<usize> {
    screens
        .iter()
        .map(|s| overlap(rect, s))
        .enumerate()
        .filter(|(_, area)| *area > 0.0)
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

pub fn targets_for(label: &str, state: &CaptureState) -> Result<Targets, AppError> {
    let guard = state.0.lock()?;
    let session = guard.as_ref().ok_or("진행 중인 캡처가 없어.")?;
    let i = screen_index(label).filter(|&i| i < session.screens.len()).ok_or("모르는 캡처 창이야.")?;
    let screen = session.screens[i];
    let start = session
        .mouse
        .filter(|[x, y]| *x >= screen.x && *x < screen.x + screen.w && *y >= screen.y && *y < screen.y + screen.h)
        .map(|[x, y]| [x - screen.x, y - screen.y]);
    Ok(Targets {
        screen,
        windows: windows_on(&session.windows, &session.screens, i),
        lum: session.lums.get(i).cloned().flatten(),
        start,
    })
}

/// 창 번호들, 순서 없이. 앞뒤 순서만 바뀐 건 데스크톱이 넘어간 게 아니다.
fn ids(windows: &[Target]) -> Vec<u32> {
    let mut ids: Vec<u32> = windows.iter().map(|t| t.id).collect();
    ids.sort_unstable();
    ids
}

/// 이 프로세스 안에서만 쓰는 ms 시계. 0 은 "아직 없음" 이라 1 부터.
fn clock_ms() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
}

/// 이 모니터가 데스크톱(Space)을 넘기는 중인가. 막은 모든 데스크톱에 떠 있어서, 넘기는 동안
/// 강조를 그대로 두면 미끄러지며 일그러지고, 넘어간 데스크톱에 이전 강조가 잠깐 남았다.
/// 넘기는 동안엔 강조·가장자리 빛을 접는다.
///
/// 두 신호를 본다(시각은 clock_ms):
/// - 화면 넘기기 동작(began·ended). 손가락을 대는 순간 온다. 커서가 있는 모니터(here) 몫.
/// - 이 모니터의 창 목록이 바뀐 때(changed). 넘기기 시작 0~17ms 뒤 다음 데스크톱 창들이 더해지고,
///   다 넘어가면 줄어든다. 넘기기 동작을 못 들을 때(권한 없음)도 이걸로 대강 잡힌다. 지난번에 다
///   넘긴 때(settled) 바로 뒤의 변화는 넘어간 데스크톱이 마저 그려지는 것이라 치지 않는다.
fn is_moving(now: u64, began: u64, ended: u64, changed: Option<u64>, here: bool, settled: Option<u64>) -> bool {
    let held = began > ended && now.saturating_sub(began) < MAX_SWIPE_MS;
    let finishing = ended > 0 && now.saturating_sub(ended) < AFTER_SWIPE_MS;
    let changed = changed.filter(|&t| settled.map_or(true, |s| t > s + SETTLE_MS));
    (here && (held || finishing)) || changed.is_some_and(|t| now.saturating_sub(t) < QUIET_MS)
}

pub fn pick(state: &CaptureState, pick: Option<Pick>) -> Result<(), AppError> {
    if let Some(session) = state.0.lock()?.as_ref() {
        let _ = session.reply.send(pick);
    }
    Ok(())
}

/// 두 네모가 겹치는 넓이.
fn overlap(a: &Rect, b: &Rect) -> f64 {
    let w = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
    let h = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
    w.max(0.0) * h.max(0.0)
}

/// 고르게 하고 찍는다. 그만두면 None. 끝날 때까지 돌아오지 않는다(main thread 에서 부르지 말 것).
pub fn run(app: &AppHandle) -> Result<Option<Vec<u8>>, AppError> {
    let state = app.state::<CaptureState>();
    let (tx, rx) = mpsc::channel();
    let screens = on_main(app, || unsafe { macos::screens() })?;
    let mouse = on_main(app, || unsafe { macos::mouse_global() }).ok().flatten();
    let windows = unsafe { macos::windows() };
    // 막마다 마지막으로 보낸 창 목록.
    let mut shown: Vec<Vec<Target>> = (0..screens.len()).map(|i| windows_on(&windows, &screens, i)).collect();
    // 막이 보이기 전에 찍어야 한다. 막은 지난번에 숨겨 둔 채이거나 아직 없다.
    let lums = screens.iter().map(|r| unsafe { macos::lum(*r, None) }).collect();
    *state.0.lock()? = Some(Session { screens: screens.clone(), mouse, lums, windows, reply: tx });
    // esc 는 키 창인 막만 받는다. 키 창이 어디로 갔든 그만둘 수 있게 캡처하는 동안만 전역으로 잡는다.
    let escape = Shortcut::new(None, Code::Escape);
    let _ = app.global_shortcut().register(escape);

    let result = (|| {
        let overlays = open_overlays(app, &screens)?;
        let ptrs: Vec<usize> = overlays.iter().filter_map(|w| w.ns_window().ok().map(|p| p as usize)).collect();
        let numbers: Vec<u32> = {
            let ptrs = ptrs.clone();
            on_main(app, move || unsafe { macos::window_numbers(&ptrs) })?
        };
        // 앱을 활성화하지 않는 패널이라, 입력(마우스 움직임·esc)은 키 창인 막 하나만 받는다.
        // 커서가 다른 모니터로 넘어가면 그 막을 키 창으로 바꿔 준다 — 안 하면 그쪽에선
        // 강조·발바닥이 멈추고 한 번 눌러야 움직였다.
        let started = std::time::Instant::now();
        let mut ticks = 0u32;
        let mut focused: Option<usize> = None;
        let mut sent: Option<(usize, Cursor)> = None;
        // 막마다 마지막으로 보낸 밝기 지도. 화면이 그대로면 다시 보내지 않는다(한 장에 200KB 남짓).
        let mut sent_lum: Vec<Option<String>> = vec![None; screens.len()];
        // 막마다: 창 목록이 마지막으로 바뀐 때, 넘기는 중이라고 알렸는지.
        let mut changed: Vec<Option<u64>> = vec![None; screens.len()];
        let mut moving = vec![false; screens.len()];
        let mut settled: Vec<Option<u64>> = vec![None; screens.len()];
        let _ = on_main(app, || unsafe { macos::watch_swipes(true) });
        let picked = loop {
            match rx.recv_timeout(FOLLOW_EVERY) {
                Ok(p) => break p,
                Err(mpsc::RecvTimeoutError::Disconnected) => break None,
                Err(mpsc::RecvTimeoutError::Timeout) if started.elapsed() > PICK_TIMEOUT => break None,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    ticks += 1;
                    let mouse = {
                        let ptrs = ptrs.clone();
                        on_main(app, move || unsafe { macos::mouse_on(&ptrs) }).ok().flatten()
                    };
                    let under = mouse.map(|(i, _)| i);
                    // 바뀌었을 때만 보낸다. 모니터를 떠나면 그 막에 null 을 보내 강조를 거둔다.
                    if mouse != sent {
                        if let Some((old, _)) = sent.filter(|(old, _)| Some(*old) != under) {
                            let _ = app.emit_to(label(old), "capture-cursor", Option::<Cursor>::None);
                        }
                        if let Some((i, c)) = mouse {
                            let _ = app.emit_to(label(i), "capture-cursor", Some(c));
                        }
                        sent = mouse;
                    }
                    // 모니터를 옮기면 키 창만 넘긴다. 맨 앞으로 다시 올리는 건(창 순서를 건드려
                    // 순간 끊김이 생긴다) 주기적으로 다시 잡을 때만.
                    let refocus = ticks % REFOCUS_TICKS == 0;
                    if let Some(i) = under.filter(|&i| Some(i) != focused || refocus) {
                        let ptr = ptrs[i];
                        let _ = app.run_on_main_thread(move || unsafe { macos::focus(ptr, refocus) });
                        focused = Some(i);
                    }
                    // 창 목록은 매번 읽는다. 데스크톱을 넘기기 시작한 걸 바로 알아채야 한다.
                    let now = clock_ms();
                    let (began, ended) = macos::swipes();
                    let fresh = unsafe { macos::windows() };
                    let mut flipped = Vec::new();
                    for i in 0..screens.len() {
                        let mine = windows_on(&fresh, &screens, i);
                        if mine != shown[i] {
                            if ids(&mine) != ids(&shown[i]) {
                                changed[i] = Some(now);
                            }
                            let _ = app.emit_to(label(i), "capture-windows", &mine);
                            shown[i] = mine;
                        }
                        let m = is_moving(now, began, ended, changed[i], under == Some(i), settled[i]);
                        if m != moving[i] {
                            moving[i] = m;
                            if !m {
                                settled[i] = Some(now);
                            }
                            flipped.push(i);
                        }
                    }
                    if let Some(session) = state.0.lock()?.as_mut() {
                        session.windows = fresh;
                    }
                    // 다 넘어간 모니터는 새 데스크톱 밝기를 바로 읽어, 강조를 다시 켜기 전에 보낸다.
                    for (i, screen) in screens.iter().enumerate() {
                        let settled = flipped.contains(&i) && !moving[i];
                        if moving[i] || !(settled || ticks % LUM_TICKS == 0) {
                            continue;
                        }
                        let Some(lum) = (unsafe { macos::lum(*screen, numbers.get(i).copied()) }) else { continue };
                        if sent_lum[i].as_deref() != Some(lum.data.as_str()) {
                            sent_lum[i] = Some(lum.data.clone());
                            let _ = app.emit_to(label(i), "capture-lum", lum);
                        }
                    }
                    for i in flipped {
                        let _ = app.emit_to(label(i), "capture-moving", moving[i]);
                    }
                }
            }
        };
        let _ = on_main(app, || unsafe { macos::watch_swipes(false) });
        for i in 0..overlays.len() {
            let _ = app.emit_to(label(i), "capture-end", ());
        }
        std::thread::sleep(CLEAR);
        for w in overlays {
            let _ = w.hide();
        }
        let Some(picked) = picked else { return Ok(None) };
        std::thread::sleep(SETTLE);
        shoot(&picked)
    })();
    let _ = app.global_shortcut().unregister(escape);
    *state.0.lock()? = None;
    result
}

/// 전역 esc. 진행 중인 캡처가 있으면 그만둔다.
pub fn cancel(app: &AppHandle) {
    let _ = pick(&app.state::<CaptureState>(), None);
}

/// 캡처 막이 떠 있는가.
pub fn is_active(app: &AppHandle) -> bool {
    app.state::<CaptureState>().0.lock().map(|g| g.is_some()).unwrap_or(false)
}

fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Result<T, AppError> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })?;
    rx.recv().map_err(|_| AppError::msg("main thread 가 답하지 않았어."))
}

/// 모니터마다 막 창을 띄운다. 지난번 것이 있으면 다시 쓰고, 모니터가 늘었으면 새로 만든다.
/// 모니터가 줄어 남는 막은 숨겨진 채로 둔다.
fn open_overlays(app: &AppHandle, screens: &[Rect]) -> Result<Vec<tauri::WebviewWindow>, AppError> {
    let mut out = Vec::new();
    for (i, screen) in screens.iter().enumerate() {
        let win = match app.get_webview_window(&label(i)) {
            Some(w) => w,
            None => tauri::WebviewWindowBuilder::new(app, label(i), tauri::WebviewUrl::App("index.html".into()))
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .skip_taskbar(true)
                .always_on_top(true)
                .visible(false)
                .focused(false)
                // 키 창이 아닌 막의 첫 클릭도 고르기로 받는다(키 창으로 만드는 데 쓰고 버리지 않게).
                .accept_first_mouse(true)
                .build()?,
        };
        // 보이기 전에 지난 상태를 지우고 새 목록을 받게 한다. 막 만든 창은 열리면서 스스로 받는다.
        let _ = app.emit_to(label(i), "capture-start", ());
        let ns = win.ns_window()? as usize;
        let rect = *screen;
        on_main(app, move || unsafe { macos::cover(ns as *mut objc2::runtime::AnyObject, rect) })?;
        out.push(win);
    }
    Ok(out)
}

fn temp_jpg(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "nekodesk-{tag}-{}.jpg",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    ))
}

fn region_arg(rect: &Rect) -> String {
    format!("-R{},{},{},{}", rect.x.round(), rect.y.round(), rect.w.round().max(1.0), rect.h.round().max(1.0))
}

/// 고른 것을 찍어 PNG 바이트로. 그만두면(파일이 안 생기면) None.
///
/// JPEG 로 찍으면 프런트가 모델용으로 줄이며 한 번 더 압축해 글씨가 뭉갰다. 무손실로 받아 한 번만 줄인다.
fn shoot(picked: &Pick) -> Result<Option<Vec<u8>>, AppError> {
    let path = temp_jpg("capture").with_extension("png");
    let mut cmd = std::process::Command::new("screencapture");
    // -x 셔터 소리 없음. 창은 -o 로 그림자를 뺀다 — 투명한 여백이 JPEG 로 줄일 때 검게 찍힌다.
    cmd.args(["-x", "-t", "png"]);
    match picked {
        Pick::Window { id } => cmd.arg("-o").arg(format!("-l{id}")),
        Pick::Region { rect } => cmd.arg(region_arg(rect)),
    };
    cmd.arg(&path).status().map_err(|e| format!("화면 캡처를 못 했어: {e}"))?;
    let shot = std::fs::read(&path).ok();
    let _ = std::fs::remove_file(&path);
    Ok(shot)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{Rect, Target};
    use crate::quick::macos::{make_panel, ns_string, to_rust};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRectC {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
        fn CGWindowListCreateImage(bounds: CGRectC, option: u32, window: u32, image_option: u32) -> *const c_void;
        fn CGImageGetWidth(image: *const c_void) -> usize;
        fn CGImageGetHeight(image: *const c_void) -> usize;
        fn CGImageRelease(image: *const c_void);
        fn CGColorSpaceCreateDeviceGray() -> *const c_void;
        fn CGColorSpaceRelease(space: *const c_void);
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: *const c_void,
            bitmap_info: u32,
        ) -> *const c_void;
        fn CGContextDrawImage(ctx: *const c_void, rect: CGRectC, image: *const c_void);
        fn CGContextRelease(ctx: *const c_void);
    }

    const BELOW_WINDOW: u32 = 1 << 2;
    /// 레티나여도 1배 픽셀로. 어차피 LUM_W 칸으로 줄인다.
    const NOMINAL_RESOLUTION: u32 = 1 << 4;

    /// 그 모니터 영역의 밝기 지도. `below` 를 주면 그 창(막) 아래만 — 막은 안 찍힌다.
    /// 화면 녹화 권한이 없으면 바탕화면만 보이거나 None. 어느 thread 에서나.
    pub unsafe fn lum(rect: Rect, below: Option<u32>) -> Option<super::Lum> {
        use base64::{engine::general_purpose, Engine as _};
        let bounds = CGRectC { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
        let (option, window) = match below {
            Some(n) => (BELOW_WINDOW, n),
            None => (ON_SCREEN_ONLY, 0),
        };
        let image = CGWindowListCreateImage(bounds, option, window, NOMINAL_RESOLUTION);
        if image.is_null() {
            return None;
        }
        let (iw, ih) = (CGImageGetWidth(image), CGImageGetHeight(image));
        let w = super::LUM_W;
        let h = ((w as f64) * ih as f64 / iw.max(1) as f64).round().max(1.0) as usize;
        let mut data = vec![0u8; w * h];
        let gray = CGColorSpaceCreateDeviceGray();
        // 8비트 흑백, 알파 없음. 이미지를 이 판에 줄여 그리면 칸마다 밝기가 남는다(첫 줄이 맨 위).
        let ctx = CGBitmapContextCreate(data.as_mut_ptr().cast(), w, h, 8, w, gray, 0);
        if !ctx.is_null() {
            CGContextDrawImage(ctx, CGRectC { x: 0.0, y: 0.0, w: w as f64, h: h as f64 }, image);
            CGContextRelease(ctx);
        }
        CGColorSpaceRelease(gray);
        CGImageRelease(image);
        (!ctx.is_null()).then(|| super::Lum { w, h, data: general_purpose::STANDARD.encode(&data) })
    }

    /// 커서 자리, 전체 화면 기준(주 모니터 왼쪽 위가 0,0). main thread 전용.
    pub unsafe fn mouse_global() -> Option<[f64; 2]> {
        let event_cls = AnyClass::get(c"NSEvent")?;
        let mouse: NSPoint = msg_send![event_cls, mouseLocation];
        let main_top = screens().first().map(|s| s.h)?;
        Some([mouse.x, main_top - mouse.y])
    }

    /// 막 창들의 창 번호(CGWindowID). main thread 전용.
    pub unsafe fn window_numbers(windows: &[usize]) -> Vec<u32> {
        windows
            .iter()
            .map(|&ptr| {
                let n: isize = msg_send![ptr as *mut AnyObject, windowNumber];
                n as u32
            })
            .collect()
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFMachPortCreateRunLoopSource(alloc: *const c_void, port: *const c_void, order: isize) -> *const c_void;
        fn CFRunLoopGetMain() -> *const c_void;
        fn CFRunLoopAddSource(run_loop: *const c_void, source: *const c_void, mode: *const c_void);
        static kCFRunLoopCommonModes: *const c_void;
    }

    type TapCallback = extern "C" fn(*const c_void, u32, *const c_void, *mut c_void) -> *const c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(tap: u32, place: u32, options: u32, events: u64, callback: TapCallback, user: *mut c_void)
            -> *const c_void;
        fn CGEventTapEnable(tap: *const c_void, enable: bool);
        fn CGEventGetIntegerValueField(event: *const c_void, field: u32) -> i64;
    }

    const SESSION_TAP: u32 = 1;
    const HEAD_INSERT: u32 = 0;
    const LISTEN_ONLY: u32 = 1;
    /// 화면 넘기기(Dock 쓸기) 이벤트. 공개되지 않은 값이라 2026-10 macOS 27.2 에서 직접 쟀다:
    /// 이벤트 종류 30, 필드 110 이 23 이면 Dock 쓸기, 필드 132 가 단계(1 시작 · 4 끝 · 8 취소).
    const DOCK_GESTURE: u32 = 30;
    const GESTURE_KIND: u32 = 110;
    const DOCK_SWIPE: i64 = 23;
    const GESTURE_PHASE: u32 = 132;
    /// 콜백이 늦거나 입력이 몰리면 macOS 가 탭을 끈다. 이 두 "이벤트" 로 알려 준다.
    const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
    const TAP_DISABLED_BY_USER_INPUT: u32 = 0xFFFF_FFFF;

    static TAP: AtomicUsize = AtomicUsize::new(0);
    static WATCHING: AtomicBool = AtomicBool::new(false);
    static SWIPE_BEGAN: AtomicU64 = AtomicU64::new(0);
    static SWIPE_ENDED: AtomicU64 = AtomicU64::new(0);

    extern "C" fn on_gesture(_proxy: *const c_void, kind: u32, event: *const c_void, _user: *mut c_void) -> *const c_void {
        unsafe {
            if kind == TAP_DISABLED_BY_TIMEOUT || kind == TAP_DISABLED_BY_USER_INPUT {
                let tap = TAP.load(Ordering::Relaxed);
                if tap != 0 && WATCHING.load(Ordering::Relaxed) {
                    CGEventTapEnable(tap as *const c_void, true);
                }
            } else if kind == DOCK_GESTURE && CGEventGetIntegerValueField(event, GESTURE_KIND) == DOCK_SWIPE {
                match CGEventGetIntegerValueField(event, GESTURE_PHASE) {
                    1 => SWIPE_BEGAN.store(super::clock_ms(), Ordering::Relaxed),
                    4 | 8 => SWIPE_ENDED.store(super::clock_ms(), Ordering::Relaxed),
                    _ => {}
                }
            }
        }
        event
    }

    /// 캡처하는 동안 화면 넘기기를 듣는다(듣기만, 다른 앱엔 그대로 간다). 처음 한 번 만들고 그 뒤엔
    /// 켜고 끄기만 한다. 못 만들면(권한이 없으면) 그냥 둔다 — 창 목록 변화로도 대강 잡힌다.
    /// 다음 캡처 때 다시 해 본다. main thread 전용.
    pub unsafe fn watch_swipes(on: bool) {
        WATCHING.store(on, Ordering::Relaxed);
        let mut tap = TAP.load(Ordering::Relaxed);
        if tap == 0 {
            if !on {
                return;
            }
            let port = CGEventTapCreate(SESSION_TAP, HEAD_INSERT, LISTEN_ONLY, 1u64 << DOCK_GESTURE, on_gesture, std::ptr::null_mut());
            if port.is_null() {
                return;
            }
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), port, 0);
            CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
            CFRelease(source);
            tap = port as usize;
            TAP.store(tap, Ordering::Relaxed);
        }
        CGEventTapEnable(tap as *const c_void, on);
    }

    /// 마지막으로 화면 넘기기를 시작한 때와 끝낸 때(clock_ms, 없으면 0).
    pub fn swipes() -> (u64, u64) {
        (SWIPE_BEGAN.load(Ordering::Relaxed), SWIPE_ENDED.load(Ordering::Relaxed))
    }

    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    /// 이보다 작은 창은 강조할 대상이 아니다(메뉴 막대 아이콘, 투명한 도우미 창).
    const MIN_SIDE: f64 = 40.0;

    /// 모니터들. 주 모니터의 왼쪽 위가 0,0 인 포인트 좌표로 뒤집는다. main thread 전용.
    pub unsafe fn screens() -> Vec<Rect> {
        let Some(cls) = AnyClass::get(c"NSScreen") else { return vec![] };
        let screens: *mut AnyObject = msg_send![cls, screens];
        let count: usize = msg_send![screens, count];
        let mut out = Vec::with_capacity(count);
        let mut main_top = 0.0;
        for i in 0..count {
            let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            let f: NSRect = msg_send![screen, frame];
            if i == 0 {
                main_top = f.origin.y + f.size.height;
            }
            out.push(Rect { x: f.origin.x, y: main_top - (f.origin.y + f.size.height), w: f.size.width, h: f.size.height });
        }
        out
    }

    /// 막 창을 그 모니터 전체에 덮고 띄운다. 앱은 활성화하지 않는다 — 전체화면 앱
    /// 위에서 부르면 네코가 있는 데스크톱으로 화면이 넘어가 버린다. main thread 전용.
    pub unsafe fn cover(window: *mut AnyObject, rect: Rect) {
        make_panel(window, false);
        // NSScreen 좌표(왼쪽 아래 원점)로 되돌린다.
        let main_top = screens().first().map(|s| s.h).unwrap_or(0.0);
        let frame = NSRect::new(NSPoint::new(rect.x, main_top - rect.y - rect.h), NSSize::new(rect.w, rect.h));
        let _: () = msg_send![window, setFrame: frame, display: true];
        let _: () = msg_send![window, orderFrontRegardless];
        // 키보드(esc)는 마우스가 있는 모니터의 막이 받는다.
        let Some(event_cls) = AnyClass::get(c"NSEvent") else { return };
        let mouse: NSPoint = msg_send![event_cls, mouseLocation];
        let inside = mouse.x >= frame.origin.x
            && mouse.x < frame.origin.x + frame.size.width
            && mouse.y >= frame.origin.y
            && mouse.y < frame.origin.y + frame.size.height;
        if inside {
            let _: () = msg_send![window, makeKeyWindow];
        }
    }

    /// 커서가 있는 막의 번호와, 그 막 기준 커서 자리(왼쪽 위 원점)·왼쪽 버튼. main thread 전용.
    pub(super) unsafe fn mouse_on(windows: &[usize]) -> Option<(usize, super::Cursor)> {
        let event_cls = AnyClass::get(c"NSEvent")?;
        let mouse: NSPoint = msg_send![event_cls, mouseLocation];
        let buttons: usize = msg_send![event_cls, pressedMouseButtons];
        windows.iter().enumerate().find_map(|(i, &ptr)| {
            let f: NSRect = msg_send![ptr as *mut AnyObject, frame];
            let inside = mouse.x >= f.origin.x
                && mouse.x < f.origin.x + f.size.width
                && mouse.y >= f.origin.y
                && mouse.y < f.origin.y + f.size.height;
            inside.then(|| {
                let c = super::Cursor {
                    x: mouse.x - f.origin.x,
                    y: f.origin.y + f.size.height - mouse.y,
                    down: buttons & 1 != 0,
                };
                (i, c)
            })
        })
    }

    /// 막을 키 창으로(front 면 맨 앞으로도). 스스로 키라고 답해도 다시 한다(REFOCUS_TICKS 참고). main thread 전용.
    pub unsafe fn focus(ptr: usize, front: bool) {
        let window = ptr as *mut AnyObject;
        if front {
            let _: () = msg_send![window, orderFrontRegardless];
        }
        let _: () = msg_send![window, makeKeyWindow];
    }

    unsafe fn get(dict: *mut AnyObject, key: &std::ffi::CStr) -> *mut AnyObject {
        msg_send![dict, objectForKey: ns_string(key)]
    }

    unsafe fn num(dict: *mut AnyObject, key: &std::ffi::CStr) -> Option<f64> {
        let n = get(dict, key);
        (!n.is_null()).then(|| msg_send![n, doubleValue])
    }

    /// 화면에 보이는 보통 창들, 앞에 있는 것부터. 네코 메인 창도 들어간다 — 캡처 막과
    /// 빠른 질문 창은 보통 창보다 높은 층(25)이라 층 검사에서 빠지고, 빠른 질문 창은 그 전에 숨는다.
    /// 앱 이름은 화면 녹화 권한 없이도 온다(창 제목은 권한이 있어야 와서 안 쓴다).
    pub unsafe fn windows() -> Vec<Target> {
        let list = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
        if list.is_null() {
            return vec![];
        }
        let array = list as *mut AnyObject;
        let count: usize = msg_send![array, count];
        let mut out = Vec::new();
        for i in 0..count {
            let info: *mut AnyObject = msg_send![array, objectAtIndex: i];
            // 0 = 보통 창. 메뉴 막대·Dock·알림은 층이 다르다.
            if num(info, c"kCGWindowLayer") != Some(0.0) || num(info, c"kCGWindowAlpha").unwrap_or(1.0) <= 0.0
            {
                continue;
            }
            let bounds = get(info, c"kCGWindowBounds");
            let (Some(id), false) = (num(info, c"kCGWindowNumber"), bounds.is_null()) else { continue };
            let (Some(x), Some(y), Some(w), Some(h)) =
                (num(bounds, c"X"), num(bounds, c"Y"), num(bounds, c"Width"), num(bounds, c"Height"))
            else {
                continue;
            };
            if w < MIN_SIDE || h < MIN_SIDE {
                continue;
            }
            let app = to_rust(get(info, c"kCGWindowOwnerName")).unwrap_or_default();
            out.push(Target { id: id as u32, app, rect: Rect { x, y, w, h } });
        }
        CFRelease(list);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_labels_map_back_to_screens() {
        assert_eq!(screen_index(&label(0)), Some(0));
        assert_eq!(screen_index(&label(2)), Some(2));
        assert_eq!(screen_index("quick"), None);
        assert_eq!(screen_index("capture-x"), None);
    }

    #[test]
    fn a_window_belongs_to_the_screen_it_covers_most() {
        let screens = [
            Rect { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 },
            Rect { x: 1512.0, y: -100.0, w: 1920.0, h: 1080.0 },
        ];
        let window = |id, x| Target { id, app: String::new(), rect: Rect { x, y: 100.0, w: 300.0, h: 300.0 } };
        // 오른쪽에만 있는 창, 왼쪽으로 더 걸친 창, 오른쪽으로 더 걸친 창.
        let windows = [window(1, 1600.0), window(2, 1300.0), window(3, 1450.0)];
        let ids = |ws: Vec<Target>| ws.iter().map(|t| t.id).collect::<Vec<_>>();
        assert_eq!(ids(windows_on(&windows, &screens, 0)), vec![2]);
        assert_eq!(ids(windows_on(&windows, &screens, 1)), vec![1, 3]);
        let off = Rect { x: -900.0, y: 0.0, w: 300.0, h: 300.0 };
        assert_eq!(home(&off, &screens), None);
    }

    #[test]
    fn swiping_hides_focus_until_the_desktop_settles() {
        // 손가락을 대고 있는 동안은 커서가 있는 모니터만.
        assert!(is_moving(1_000, 900, 0, None, true, None));
        assert!(!is_moving(1_000, 900, 0, None, false, None));
        // 한 번 사이에 시작·끝이 다 와도(빨리 튕기기), 손 뗀 뒤 macOS 가 마저 넘기는 동안은 넘기는 중.
        assert!(is_moving(1_000, 980, 990, None, true, None));
        assert!(!is_moving(1_800, 980, 990, None, true, None));
        // 다 넘어가며 창 목록이 바뀌면 조용해질 때까지 기다린다.
        assert!(is_moving(1_900, 980, 990, Some(1_700), true, None));
        assert!(!is_moving(2_000, 980, 990, Some(1_700), true, None));
        // 끝 신호를 놓쳐도 영영 접혀 있지 않는다.
        assert!(!is_moving(10_000, 900, 0, None, true, None));
        // 넘기기 동작을 못 들어도 창 목록 변화로.
        assert!(is_moving(1_100, 0, 0, Some(1_000), false, None));
        assert!(!is_moving(1_300, 0, 0, Some(1_000), false, None));
        // 다 넘긴 바로 뒤에 창 목록이 또 바뀌어도 다시 모으지 않는다. 한참 뒤의 변화는 친다.
        assert!(!is_moving(2_100, 980, 990, Some(2_000), true, Some(1_800)));
        assert!(is_moving(2_700, 980, 990, Some(2_600), true, Some(1_800)));
    }

    #[test]
    fn picks_arrive_as_tagged_json() {
        let w: Pick = serde_json::from_str(r#"{"kind":"window","id":42}"#).unwrap();
        assert!(matches!(w, Pick::Window { id: 42 }));
        let r: Pick = serde_json::from_str(r#"{"kind":"region","rect":{"x":1,"y":2,"w":3,"h":4}}"#).unwrap();
        assert!(matches!(r, Pick::Region { rect } if rect == Rect { x: 1.0, y: 2.0, w: 3.0, h: 4.0 }));
    }
}
