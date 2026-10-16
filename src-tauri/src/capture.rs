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
/// 화면 읽기는 WindowServer 에도 일을 시켜 자주 하면 움직임이 끊긴다 — 평소엔 2초, 창 목록이
/// 바뀌면(데스크톱 이동 등) 그때 바로 한 번.
const LUM_TICKS: u32 = 60;
/// 밝기 지도의 가로 칸 수. 발바닥 정중앙 한 점을 읽으니 한 칸이 발바닥(18pt)보다 충분히 작아야 한다.
const LUM_W: usize = 512;
/// 창 목록을 다시 읽는 간격(FOLLOW_EVERY 의 배수). 데스크톱(Space)을 막 옮긴 직후엔
/// 목록이 이전 데스크톱 것으로 남아 있어, 전체화면 창 대신 거기 없는 창이 잡히곤 했다.
const REFRESH_TICKS: u32 = 15;

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

/// 이 모니터에 걸친 창들, 앞에 있는 것부터.
fn windows_on(windows: &[Target], screen: &Rect) -> Vec<Target> {
    windows.iter().filter(|t| intersects(&t.rect, screen)).cloned().collect()
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
        windows: windows_on(&session.windows, &screen),
        lum: session.lums.get(i).cloned().flatten(),
        start,
    })
}

/// 창 목록을 다시 읽어, 바뀌었으면 각 막에 자기 모니터 몫을 보낸다(`capture-windows`). 바뀌었으면 true.
fn refresh_windows(app: &AppHandle, state: &CaptureState) -> Result<bool, AppError> {
    let fresh = unsafe { macos::windows() };
    let mut guard = state.0.lock()?;
    let Some(session) = guard.as_mut() else { return Ok(false) };
    if session.windows == fresh {
        return Ok(false);
    }
    for (i, screen) in session.screens.iter().enumerate() {
        let _ = app.emit_to(label(i), "capture-windows", windows_on(&fresh, screen));
    }
    session.windows = fresh;
    Ok(true)
}

pub fn pick(state: &CaptureState, pick: Option<Pick>) -> Result<(), AppError> {
    if let Some(session) = state.0.lock()?.as_ref() {
        let _ = session.reply.send(pick);
    }
    Ok(())
}

fn intersects(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/// 고르게 하고 찍는다. 그만두면 None. 끝날 때까지 돌아오지 않는다(main thread 에서 부르지 말 것).
pub fn run(app: &AppHandle) -> Result<Option<Vec<u8>>, AppError> {
    let state = app.state::<CaptureState>();
    let (tx, rx) = mpsc::channel();
    let screens = on_main(app, || unsafe { macos::screens() })?;
    let mouse = on_main(app, || unsafe { macos::mouse_global() }).ok().flatten();
    let windows = unsafe { macos::windows() };
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
                    let windows_changed =
                        ticks % REFRESH_TICKS == 0 && refresh_windows(app, &state).unwrap_or(false);
                    if windows_changed || ticks % LUM_TICKS == 0 {
                        for (i, screen) in screens.iter().enumerate() {
                            let Some(lum) = (unsafe { macos::lum(*screen, numbers.get(i).copied()) }) else { continue };
                            if sent_lum[i].as_deref() != Some(lum.data.as_str()) {
                                sent_lum[i] = Some(lum.data.clone());
                                let _ = app.emit_to(label(i), "capture-lum", lum);
                            }
                        }
                    }
                }
            }
        };
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
    fn windows_on_another_screen_are_left_out() {
        let main = Rect { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 };
        let right = Rect { x: 1512.0, y: -100.0, w: 1920.0, h: 1080.0 };
        let on_right = Rect { x: 1600.0, y: 0.0, w: 800.0, h: 600.0 };
        let straddling = Rect { x: 1400.0, y: 100.0, w: 300.0, h: 300.0 };
        assert!(!intersects(&on_right, &main));
        assert!(intersects(&on_right, &right));
        assert!(intersects(&straddling, &main) && intersects(&straddling, &right));
    }

    #[test]
    fn picks_arrive_as_tagged_json() {
        let w: Pick = serde_json::from_str(r#"{"kind":"window","id":42}"#).unwrap();
        assert!(matches!(w, Pick::Window { id: 42 }));
        let r: Pick = serde_json::from_str(r#"{"kind":"region","rect":{"x":1,"y":2,"w":3,"h":4}}"#).unwrap();
        assert!(matches!(r, Pick::Region { rect } if rect == Rect { x: 1.0, y: 2.0, w: 3.0, h: 4.0 }));
    }
}
