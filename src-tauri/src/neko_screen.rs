//! 네코 '모니터 화면' 자리(docs/neko-screen-mode.md). 주 모니터 전체를 덮는 투명 창 하나에 네코가
//! 산다. 평소엔 클릭이 뒤로 지나가고, 고양이 위에서만 받는다.
//!
//! - 창: 키 창이 못 되는 패널이다 — 고양이를 눌러도 치던 앱의 키보드를 뺏지 않는다. 패널로 바꾼
//!   창은 닫으면 앱이 죽어서(capture.rs 머리말) 숨기기만 한다.
//! - 커서: 폴러가 33ms 마다 읽어 화면 창에 보낸다(`neko-screen-cursor`). 고양이 위인지는 화면 창이
//!   엔진 hit 로 보고 `neko_screen_catch` 로 알린다. 클릭 통과는 여기서만 바꾼다(`wants_clicks`).
//! - 2초마다: 화면 크기와 바닥(Dock 위), 잠금·잠자기·화면 보호기, 전체화면 영상.
//!
//! 좌표는 포인트, 주 모니터 왼쪽 위가 0,0(capture.rs 와 같다). 창이 주 모니터를 덮으니 창 좌표와 같다.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::capture::on_main;
use crate::error::AppError;

const LABEL: &str = "neko-screen";
/// 커서를 읽는 간격(초당 30번). capture.rs 의 FOLLOW_EVERY 와 같다.
const TICK: Duration = Duration::from_millis(33);
/// 이만큼(TICK 의 배수, 2초)마다 화면 크기·멈춤·전체화면 영상을 본다.
const SLOW_TICKS: u32 = 60;
/// 멈췄거나 숨긴 동안은 커서를 안 읽고 이 간격으로 멈춤 조건만 본다.
const SLOW: Duration = Duration::from_secs(2);
/// 화면 창이 '고양이 위'라고 마지막으로 알린 뒤 이만큼 지나면 클릭을 다시 흘린다. 화면 창이
/// 굳거나 죽어도 0.25초 안에 다른 앱 클릭이 돌아온다. 화면 창은 고양이 위에 있는 동안 0.1초마다 알린다.
const CATCH_TTL: Duration = Duration::from_millis(250);

/// 화면 창이 처음과 바뀔 때 받는 판 크기와 바닥(엔진 세계 좌표).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    pub w: f64,
    pub h: f64,
    /// 고양이가 서는 높이. visibleFrame 의 바닥, 곧 Dock 바로 위.
    pub ground: f64,
}

struct State {
    /// 설정이 화면 자리고 산책 중이 아니다(메인 창이 정한다).
    on: bool,
    on_top: bool,
    /// 네코 캡처 중이라 숨김.
    capture: bool,
    /// 전체화면 영상·발표라 숨김.
    video: bool,
    /// 잠금·사용자 전환·디스플레이 잠자기·화면 보호기.
    asleep: bool,
    /// 마지막으로 화면 창에 알린 '움직여도 된다'.
    active: Option<bool>,
    layout: Option<Layout>,
    catch_at: Option<Instant>,
    /// 지금 클릭을 받는 중(ignoresMouseEvents = NO).
    catching: bool,
    /// 받는 중에 눌렀다 — 놓을 때까지 화면 어디서든 받는다(목덜미 잡고 끌기).
    grabbing: bool,
    poller: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    on: false,
    on_top: true,
    capture: false,
    video: false,
    asleep: false,
    active: None,
    layout: None,
    catch_at: None,
    catching: false,
    grabbing: false,
    poller: false,
});

/// 클릭을 받을지. 잡고 끄는 중이면 무조건 받는다. 아니면 화면 창이 방금(CATCH_TTL 안에) '고양이
/// 위'라고 했고, 커서가 이 화면에 있고, ⌥ 를 안 눌렀고, 버튼을 누른 채 들어온 게 아닐 때만 —
/// 다른 앱에서 창이나 글을 끌다가 고양이 위를 지나가도 끊기지 않게.
fn wants_clicks(grabbing: bool, fresh: bool, on_screen: bool, option: bool, down: bool) -> bool {
    grabbing || (fresh && on_screen && !option && !down)
}

/// 주 모니터 frame·visibleFrame(AppKit 좌표, 왼쪽 아래 원점)으로 판과 바닥을 낸다.
fn layout_of(frame: [f64; 4], visible: [f64; 4]) -> Layout {
    let [_, fy, _, fh] = frame;
    let [_, vy, _, _] = visible;
    Layout { w: frame[2], h: fh, ground: fh - (vy - fy) }
}

/// 맨 앞 창이 화면 전체를 덮는가(전체화면 앱). 좌표는 왼쪽 위 원점.
fn covers(rect: &crate::capture::Rect, w: f64, h: f64) -> bool {
    rect.x <= 0.5 && rect.y <= 0.5 && rect.x + rect.w >= w - 0.5 && rect.y + rect.h >= h - 0.5
}

/// 메인 창이 자리·산책·'항상 위'가 바뀔 때 부른다. 처음 켤 때 창을 만든다.
pub fn show(app: &AppHandle, on: bool, on_top: bool) -> Result<(), AppError> {
    {
        let mut st = STATE.lock()?;
        st.on = on;
        st.on_top = on_top;
    }
    if !on && app.get_webview_window(LABEL).is_none() {
        return Ok(()); // 한 번도 안 띄웠으면 만들 것도 없다
    }
    if app.get_webview_window(LABEL).is_none() {
        create(app)?;
    }
    sync(app)?;
    if on {
        start_poller(app)?;
    }
    Ok(())
}

/// 화면 창이 커서가 고양이 위인지 알린다.
pub fn set_catch(on: bool) -> Result<(), AppError> {
    STATE.lock()?.catch_at = on.then(Instant::now);
    Ok(())
}

/// 화면 창이 처음 뜰 때 판 크기와 바닥을 가져간다. 아직 모르면 None(곧 `neko-screen-layout` 이 온다).
pub fn layout() -> Option<Layout> {
    STATE.lock().ok()?.layout
}

/// 네코 캡처 동안 숨긴다. 숨긴 게 있으면 true(사라질 때까지 기다리라고).
pub fn set_capture(app: &AppHandle, on: bool) -> bool {
    let was_visible = match STATE.lock() {
        Ok(mut st) => {
            let v = visible(&st);
            st.capture = on;
            v
        }
        Err(_) => return false,
    };
    if app.get_webview_window(LABEL).is_some() {
        let _ = sync(app);
    }
    on && was_visible
}

fn visible(st: &State) -> bool {
    st.on && !st.capture && !st.video
}

fn create(app: &AppHandle) -> Result<(), AppError> {
    let win = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html".into()))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        // 키 창이 아닌 패널이라, 끄면 첫 클릭을 창 활성화에 써 버린다.
        .accept_first_mouse(true)
        // 1단계엔 파일을 안 받는다. 2단계 파일 물려주기(§7)에서 켠다.
        .disable_drag_drop_handler()
        .build()?;
    let ns = win.ns_window()? as usize;
    if !on_main(app, move || unsafe { macos::setup(ns as *mut objc2::runtime::AnyObject) })? {
        log::warn!("화면 네코 창을 패널로 못 바꿨어 — 눌렀을 때 키보드를 뺏을 수 있다");
    }
    Ok(())
}

/// 지금 상태대로 창을 올리거나 숨기고, 레벨·자리를 맞춘다. 화면 창에 바뀐 판·멈춤을 알린다.
fn sync(app: &AppHandle) -> Result<(), AppError> {
    let Some(win) = app.get_webview_window(LABEL) else { return Ok(()) };
    let (show, on_top) = {
        let st = STATE.lock()?;
        (visible(&st), st.on_top)
    };
    let ns = win.ns_window()? as usize;
    let placed = on_main(app, move || unsafe { macos::place(ns as *mut objc2::runtime::AnyObject, show, on_top) })?;
    let mut st = STATE.lock()?;
    if let Some(l) = placed.filter(|l| st.layout != Some(*l)) {
        st.layout = Some(l);
        let _ = app.emit_to(LABEL, "neko-screen-layout", l);
    }
    if !show && st.catching {
        st.catching = false;
        st.grabbing = false;
        let _ = win.set_ignore_cursor_events(true);
    }
    let active = show && !st.asleep;
    if st.active != Some(active) {
        st.active = Some(active);
        let _ = app.emit_to(LABEL, "neko-screen-active", active);
    }
    Ok(())
}

fn start_poller(app: &AppHandle) -> Result<(), AppError> {
    {
        let mut st = STATE.lock()?;
        if st.poller {
            return Ok(());
        }
        st.poller = true;
    }
    let app = app.clone();
    std::thread::spawn(move || poll(app));
    Ok(())
}

/// 화면 자리가 켜져 있는 동안 돈다. 꺼지면 다음 깸에서 끝난다(다시 켜면 새로 뜬다).
fn poll(app: AppHandle) {
    let mut tick: u32 = 0;
    let mut sent: Option<[f64; 2]> = None;
    loop {
        let active = match STATE.lock() {
            Ok(st) if st.on => st.active == Some(true),
            Ok(mut st) => {
                st.poller = false;
                return;
            }
            Err(_) => return,
        };
        if !active || tick % SLOW_TICKS == 0 {
            survey(&app);
        }
        if active {
            follow(&app, &mut sent);
        } else {
            sent = None;
        }
        tick = tick.wrapping_add(1);
        std::thread::sleep(if active { TICK } else { SLOW });
    }
}

/// 커서를 화면 창에 보내고 클릭 통과를 맞춘다.
fn follow(app: &AppHandle, sent: &mut Option<[f64; 2]>) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let Ok(Some(p)) = on_main(app, || unsafe { macos::probe() }) else { return };
    let Ok(mut st) = STATE.lock() else { return };
    let Some(l) = st.layout else { return };
    let cursor = Some(p.mouse).filter(|[x, y]| *x >= 0.0 && *y >= 0.0 && *x < l.w && *y < l.h);
    if cursor != *sent {
        *sent = cursor;
        let _ = app.emit_to(LABEL, "neko-screen-cursor", cursor);
    }
    if !p.down {
        st.grabbing = false;
    } else if st.catching {
        st.grabbing = true;
    }
    let fresh = st.catch_at.is_some_and(|t| t.elapsed() < CATCH_TTL);
    let want = wants_clicks(st.grabbing, fresh, cursor.is_some(), p.option, p.down);
    if want != st.catching {
        st.catching = want;
        let _ = win.set_ignore_cursor_events(!want);
    }
}

/// 화면 크기·바닥, 멈춤 조건, 전체화면 영상.
fn survey(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_none() {
        return;
    }
    let Ok(s) = on_main(app, || unsafe { macos::survey() }) else { return };
    let changed = match STATE.lock() {
        Ok(mut st) => {
            let changed = st.asleep != s.asleep || st.video != s.video || st.layout != Some(s.layout);
            st.asleep = s.asleep;
            st.video = s.video;
            changed
        }
        Err(_) => return,
    };
    if changed {
        let _ = sync(app);
    }
}

pub(crate) mod macos {
    use super::Layout;
    use crate::quick::macos::{make_panel, ns_string, to_rust};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSRect;
    use std::ffi::c_void;

    /// make_panel 이 주는 것(모든 Space·전체화면 앱 위)에 더해: Mission Control 에서 옮겨지지
    /// 않고(Stationary), ⌘` 순환에 안 끼고(IgnoresCycle).
    const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    const STATIONARY: usize = 1 << 4;
    const IGNORES_CYCLE: usize = 1 << 6;
    const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
    /// NSStatusWindowLevel. 메뉴 막대(24)·Dock(20)·전체화면 앱 위.
    const STATUS_WINDOW_LEVEL: isize = 25;
    /// kCGDesktopIconWindowLevelKey. '항상 위' 를 끄면 바탕화면 아이콘 바로 위, 모든 창 아래.
    const DESKTOP_ICON_LEVEL_KEY: i32 = 18;
    const OPTION_KEY: usize = 1 << 19;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowLevelForKey(key: i32) -> i32;
        fn CGSessionCopyCurrentDictionary() -> *const c_void;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayIsAsleep(display: u32) -> u32;
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMCopyAssertionsByProcess(out: *mut *const c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    pub struct Probe {
        pub mouse: [f64; 2],
        pub down: bool,
        pub option: bool,
    }

    pub struct Survey {
        pub layout: Layout,
        pub asleep: bool,
        pub video: bool,
    }

    /// 패널로 바꾸고 클릭을 흘린다. main thread 전용.
    pub unsafe fn setup(window: *mut AnyObject) -> bool {
        let ok = make_panel(window, false, false);
        let _: () = msg_send![window, setCollectionBehavior: CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUXILIARY | STATIONARY | IGNORES_CYCLE];
        let _: () = msg_send![window, setIgnoresMouseEvents: Bool::YES];
        ok
    }

    unsafe fn main_screen() -> Option<(NSRect, NSRect)> {
        let screens: *mut AnyObject = msg_send![AnyClass::get(c"NSScreen")?, screens];
        let count: usize = msg_send![screens, count];
        if count == 0 {
            return None;
        }
        let screen: *mut AnyObject = msg_send![screens, objectAtIndex: 0usize];
        Some((msg_send![screen, frame], msg_send![screen, visibleFrame]))
    }

    fn rect4(r: NSRect) -> [f64; 4] {
        [r.origin.x, r.origin.y, r.size.width, r.size.height]
    }

    /// 주 모니터 전체를 덮고 레벨을 맞춘 뒤 올리거나 숨긴다. main thread 전용.
    pub unsafe fn place(window: *mut AnyObject, show: bool, on_top: bool) -> Option<Layout> {
        let level = if on_top { STATUS_WINDOW_LEVEL } else { CGWindowLevelForKey(DESKTOP_ICON_LEVEL_KEY) as isize + 1 };
        let _: () = msg_send![window, setLevel: level];
        let (frame, visible) = main_screen()?;
        let now: NSRect = msg_send![window, frame];
        if rect4(now) != rect4(frame) {
            let _: () = msg_send![window, setFrame: frame, display: false];
        }
        if show {
            let _: () = msg_send![window, orderFrontRegardless];
        } else {
            let _: () = msg_send![window, orderOut: std::ptr::null_mut::<AnyObject>()];
        }
        Some(super::layout_of(rect4(frame), rect4(visible)))
    }

    /// 커서(주 모니터 왼쪽 위 기준)·왼쪽 버튼·⌥. main thread 전용.
    pub unsafe fn probe() -> Option<Probe> {
        let event = AnyClass::get(c"NSEvent")?;
        let mouse = crate::capture::macos::mouse_global()?;
        let buttons: usize = msg_send![event, pressedMouseButtons];
        let flags: usize = msg_send![event, modifierFlags];
        Some(Probe { mouse, down: buttons & 1 != 0, option: flags & OPTION_KEY != 0 })
    }

    /// 판 크기, 멈춤 조건, 전체화면 영상. main thread 전용.
    pub unsafe fn survey() -> Survey {
        let (frame, visible) = main_screen().unwrap_or_default();
        let layout = super::layout_of(rect4(frame), rect4(visible));
        let asleep = locked() || CGDisplayIsAsleep(CGMainDisplayID()) != 0 || screen_saver();
        Survey { layout, asleep, video: video(&layout) }
    }

    unsafe fn bool_of(dict: *mut AnyObject, key: &std::ffi::CStr) -> Option<bool> {
        let v: *mut AnyObject = msg_send![dict, objectForKey: ns_string(key)];
        (!v.is_null()).then(|| {
            let b: Bool = msg_send![v, boolValue];
            b.as_bool()
        })
    }

    /// 화면이 잠겼거나 다른 사용자로 넘어갔다. 세션 정보를 못 읽으면(로그인 창) 잠긴 것으로 본다.
    /// `CGSSessionScreenIsLocked` 는 문서에 없는 키다 — 없어지면 디스플레이 잠자기 검사가 대부분 같이 잡는다.
    unsafe fn locked() -> bool {
        let dict = CGSessionCopyCurrentDictionary();
        if dict.is_null() {
            return true;
        }
        let d = dict as *mut AnyObject;
        let locked = bool_of(d, c"CGSSessionScreenIsLocked").unwrap_or(false);
        let on_console = bool_of(d, c"kCGSSessionOnConsoleKey").unwrap_or(true);
        CFRelease(dict);
        locked || !on_console
    }

    unsafe fn screen_saver() -> bool {
        let Some(ws) = AnyClass::get(c"NSWorkspace") else { return false };
        let ws: *mut AnyObject = msg_send![ws, sharedWorkspace];
        let front: *mut AnyObject = msg_send![ws, frontmostApplication];
        if front.is_null() {
            return false;
        }
        let id: *mut AnyObject = msg_send![front, bundleIdentifier];
        to_rust(id).as_deref() == Some("com.apple.ScreenSaver.Engine")
    }

    /// 주 모니터 맨 앞 창이 화면 전체를 덮고(전체화면), 그 앱이 화면 꺼짐을 막고 있다(영상·발표).
    unsafe fn video(l: &Layout) -> bool {
        let windows = crate::capture::macos::windows();
        let Some(front) = windows.iter().find(|t| t.rect.x < l.w && t.rect.y < l.h && t.rect.x + t.rect.w > 0.0 && t.rect.y + t.rect.h > 0.0)
        else {
            return false;
        };
        super::covers(&front.rect, l.w, l.h) && keeps_display_awake(front.pid)
    }

    unsafe fn keeps_display_awake(pid: i32) -> bool {
        let mut dict: *const c_void = std::ptr::null();
        if pid <= 0 || IOPMCopyAssertionsByProcess(&mut dict) != 0 || dict.is_null() {
            return false;
        }
        let found = (|| {
            let num: *mut AnyObject = msg_send![AnyClass::get(c"NSNumber")?, numberWithInt: pid];
            let list: *mut AnyObject = msg_send![dict as *mut AnyObject, objectForKey: num];
            if list.is_null() {
                return Some(false);
            }
            let count: usize = msg_send![list, count];
            for i in 0..count {
                let a: *mut AnyObject = msg_send![list, objectAtIndex: i];
                let kind: *mut AnyObject = msg_send![a, objectForKey: ns_string(c"AssertType")];
                if matches!(to_rust(kind).as_deref(), Some("PreventUserIdleDisplaySleep" | "NoDisplaySleepAssertion")) {
                    return Some(true);
                }
            }
            Some(false)
        })()
        .unwrap_or(false);
        CFRelease(dict);
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_only_on_a_fresh_hover_unless_grabbing() {
        // 고양이 위(방금 알림), 버튼 안 누름 → 받는다
        assert!(wants_clicks(false, true, true, false, false));
        // 알림이 오래됨(화면 창이 굳음) → 흘린다
        assert!(!wants_clicks(false, false, true, false, false));
        // ⌥ → 흘린다
        assert!(!wants_clicks(false, true, true, true, false));
        // 다른 앱에서 끌던 채로 들어옴 → 흘린다
        assert!(!wants_clicks(false, true, true, false, true));
        // 다른 모니터 → 흘린다
        assert!(!wants_clicks(false, true, false, false, false));
        // 잡고 끄는 중 → 알림이 없고 화면 밖이어도 놓을 때까지 받는다
        assert!(wants_clicks(true, false, false, true, true));
    }

    #[test]
    fn ground_sits_on_top_of_the_dock() {
        // 1512×982 화면, 아래 Dock 70pt, 위 메뉴 막대 33pt(AppKit 좌표는 왼쪽 아래 원점)
        let l = layout_of([0.0, 0.0, 1512.0, 982.0], [0.0, 70.0, 1512.0, 879.0]);
        assert_eq!(l, Layout { w: 1512.0, h: 982.0, ground: 912.0 });
        // Dock 이 옆에 있거나 숨으면 화면 맨 아래
        assert_eq!(layout_of([0.0, 0.0, 1512.0, 982.0], [60.0, 0.0, 1452.0, 949.0]).ground, 982.0);
    }

    #[test]
    fn only_a_window_over_the_whole_screen_is_full_screen() {
        use crate::capture::Rect;
        assert!(covers(&Rect { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 }, 1512.0, 982.0));
        // 최대화(메뉴 막대 아래부터)는 전체화면이 아니다
        assert!(!covers(&Rect { x: 0.0, y: 33.0, w: 1512.0, h: 879.0 }, 1512.0, 982.0));
    }
}
