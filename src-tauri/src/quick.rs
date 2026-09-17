//! 어느 앱에서든 ⌃⇧N 으로 여는 빠른 질문 창.
//!
//! 단축키를 누르면 **창을 띄우기 전에** 지금 선택한 텍스트·클립보드·앞에 있던 앱
//! 이름을 읽어 둔다. 창이 뜨면 포커스가 이쪽으로 넘어와 선택이 사라지기 때문이다.
//!
//! ## 선택한 텍스트는 어떻게 읽나
//!
//! 손쉬운 사용(Accessibility) API 로 포커스된 요소의 `AXSelectedText` 를 묻는다.
//! ⌘C 를 흉내 내 클립보드로 복사하는 흔한 방법은 쓰지 않았다 — 사용자의 클립보드를
//! 덮어써야 하고, 이미지·파일 같은 내용을 온전히 되돌리지 못하면 데이터가 날아간다.
//! 대신 네이티브 앱(메모·메일·Safari 주소창 등)에서는 잘 되고 Chrome·Electron 앱
//! 본문에서는 자주 비어 온다. 그럴 땐 사용자가 ⌘C 한 번 하고 부르면 클립보드 칩으로
//! 들어간다.
//! ponytail: ⌘C 흉내 + NSPasteboardItem 전체 백업·복원, AX 가 너무 자주 비면 추가.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 클립보드·선택이 이보다 길면 자른다. 로그 파일 전체를 복사해 둔 채 부르는 경우.
const MAX_CONTEXT_CHARS: usize = 20_000;

#[derive(Clone, Serialize, Default)]
pub struct QuickContext {
    pub selection: Option<String>,
    pub clipboard: Option<String>,
    pub app: Option<String>,
}

/// 단축키 핸들러. 떠 있으면 닫고, 아니면 맥락을 읽고 띄운다.
pub fn toggle(app: &AppHandle) {
    let Some(win) = app.get_webview_window("quick") else { return };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }

    let ctx = read_context();
    present(&win);
    let _ = app.emit_to("quick", "quick-context", ctx);
}

/// 창을 띄운다.
///
/// `show()` + `set_focus()` 는 **앱 전체를 활성화**한다. 그러면 메인 창이 앞으로
/// 끌려오고, 전체화면 앱 위에서 부르면 네코가 있는 데스크톱으로 화면이 넘어간다.
/// macOS 에선 활성화 없이 키 입력을 받는 패널로 띄운다(Spotlight 식).
#[cfg(target_os = "macos")]
fn present(win: &tauri::WebviewWindow) {
    match win.ns_window() {
        Ok(ptr) => unsafe { macos::present_on_cursor_screen(ptr.cast()) },
        Err(_) => {
            let _ = win.center();
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn present(win: &tauri::WebviewWindow) {
    let _ = win.center();
    let _ = win.show();
    let _ = win.set_focus();
}

/// 앱 시작 때 한 번. 빠른 질문 창을 비활성 패널로 바꾼다.
#[cfg(target_os = "macos")]
pub fn install_panel(win: &tauri::WebviewWindow) {
    if let Ok(ptr) = win.ns_window() {
        if !unsafe { macos::make_panel(ptr.cast()) } {
            log::warn!("빠른 질문 창을 패널로 못 바꿨어 — 일반 창으로 뜬다");
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install_panel(_win: &tauri::WebviewWindow) {}

/// 화면(메뉴 막대·Dock 을 뺀 영역) 안에서 창을 가운데 둘 원점.
///
/// 전부 AppKit 의 **포인트** 좌표(왼쪽 아래가 원점)다. 예전엔 tao 의 cursor_position
/// 을 썼는데, 그건 주 모니터 배율을 곱한 물리 픽셀을 주고 monitor_from_point 는
/// 포인트를 받는다. 레티나에선 좌표가 두 배로 어긋나 다른 모니터를 못 찾았다.
fn centered_origin(visible: (f64, f64, f64, f64), win_size: (f64, f64)) -> (f64, f64) {
    let (x, y, w, h) = visible;
    ((x + (w - win_size.0) / 2.0).round(), (y + (h - win_size.1) / 2.0).round())
}

fn clip(s: String) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    Some(t.chars().take(MAX_CONTEXT_CHARS).collect())
}

#[cfg(not(target_os = "macos"))]
fn read_context() -> QuickContext {
    QuickContext::default()
}

#[cfg(target_os = "macos")]
fn read_context() -> QuickContext {
    // 앱 이름은 선택을 읽기 전에 — 순서는 상관없지만 둘 다 창을 띄우기 전이어야 한다.
    let app = unsafe { macos::frontmost_app_name() };
    let selection = unsafe { macos::selected_text() }.and_then(clip);
    let clipboard = std::process::Command::new("pbpaste")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(clip);
    QuickContext { selection, clipboard, app }
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use std::ffi::{c_void, CStr};
    use std::sync::atomic::{AtomicBool, Ordering};

    type CFTypeRef = *const c_void;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
        fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(el: CFTypeRef, attr: CFTypeRef, out: *mut CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(el: CFTypeRef, seconds: f32) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: CFTypeRef);
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint { x: f64, y: f64 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize { width: f64, height: f64 }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect { origin: CGPoint, size: CGSize }

    unsafe impl objc2::Encode for CGPoint {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl objc2::Encode for CGSize {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl objc2::Encode for CGRect {
        const ENCODING: objc2::Encoding = objc2::Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    const NS_NONACTIVATING_PANEL: usize = 1 << 7;
    const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
    /// NSStatusWindowLevel. 전체화면 앱과 일반 떠 있는 창 위.
    const STATUS_WINDOW_LEVEL: isize = 25;

    extern "C-unwind" fn yes(_: &AnyObject, _: objc2::runtime::Sel) -> Bool { Bool::YES }
    extern "C-unwind" fn no(_: &AnyObject, _: objc2::runtime::Sel) -> Bool { Bool::NO }

    /// tao 가 만든 창(TaoWindow)을 NSPanel 하위 클래스로 바꾼다.
    ///
    /// 앱을 활성화하지 않고도 키 입력을 받으려면 `nonactivatingPanel` 스타일이
    /// 필요한데, 그건 NSPanel 에만 있다. 창을 새로 만들면 웹뷰를 다시 붙여야 해서
    /// 클래스만 바꾼다(tauri-nspanel 과 같은 방법).
    ///
    /// 객체 메모리는 TaoWindow 크기로 잡혀 있다. NSPanel 이 NSWindow 보다 크면 바꾼
    /// 뒤 남의 메모리를 읽게 되므로, 크기가 같을 때만 바꾸고 아니면 false.
    /// TaoWindow 의 `focusable` 변수도 같은 자리에 둔다 — tao 가 그 이름으로 읽는다.
    pub unsafe fn make_panel(window: *mut AnyObject) -> bool {
        use objc2::runtime::ClassBuilder;
        use objc2::sel;

        let (Some(panel_cls), Some(window_cls)) = (AnyClass::get(c"NSPanel"), AnyClass::get(c"NSWindow")) else {
            return false;
        };
        if panel_cls.instance_size() != window_cls.instance_size() || window.is_null() {
            return false;
        }

        let cls = match AnyClass::get(c"NekoQuickPanel") {
            Some(c) => c,
            None => {
                let Some(mut b) = ClassBuilder::new(c"NekoQuickPanel", panel_cls) else { return false };
                b.add_ivar::<Bool>(c"focusable");
                // 테두리 없는 창은 기본으로 키 윈도우가 못 된다 — 그러면 글자를 못 친다.
                b.add_method(sel!(canBecomeKeyWindow), yes as extern "C-unwind" fn(_, _) -> _);
                // 메인 창이 되면 앱의 메인 창 자리를 뺏는다.
                b.add_method(sel!(canBecomeMainWindow), no as extern "C-unwind" fn(_, _) -> _);
                b.register()
            }
        };
        if cls.instance_size() != (*window).class().instance_size() {
            return false;
        }
        objc2::ffi::object_setClass(window, cls);

        let mask: usize = msg_send![window, styleMask];
        let _: () = msg_send![window, setStyleMask: mask | NS_NONACTIVATING_PANEL];
        // 모든 Space 에, 전체화면 앱 위에도.
        let _: () = msg_send![window, setCollectionBehavior: CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUXILIARY];
        let _: () = msg_send![window, setLevel: STATUS_WINDOW_LEVEL];
        // 패널은 기본으로 앱이 비활성화되면 숨는다. 이 앱은 애초에 활성화하지 않는다.
        let _: () = msg_send![window, setHidesOnDeactivate: Bool::NO];
        true
    }

    /// 마우스가 있는 화면 가운데에 띄우고 키 입력을 받게 한다. 앱은 활성화하지 않는다.
    pub unsafe fn present_on_cursor_screen(window: *mut AnyObject) {
        let (Some(event_cls), Some(screen_cls)) = (AnyClass::get(c"NSEvent"), AnyClass::get(c"NSScreen")) else {
            return;
        };
        let mouse: CGPoint = msg_send![event_cls, mouseLocation];
        let screens: *mut AnyObject = msg_send![screen_cls, screens];
        let count: usize = msg_send![screens, count];

        for i in 0..count {
            let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            let frame: CGRect = msg_send![screen, frame];
            let inside = mouse.x >= frame.origin.x
                && mouse.x < frame.origin.x + frame.size.width
                && mouse.y >= frame.origin.y
                && mouse.y < frame.origin.y + frame.size.height;
            if !inside {
                continue;
            }
            let visible: CGRect = msg_send![screen, visibleFrame];
            let win_frame: CGRect = msg_send![window, frame];
            let (x, y) = super::centered_origin(
                (visible.origin.x, visible.origin.y, visible.size.width, visible.size.height),
                (win_frame.size.width, win_frame.size.height),
            );
            let _: () = msg_send![window, setFrameOrigin: CGPoint { x, y }];
            break;
        }

        let _: () = msg_send![window, orderFrontRegardless];
        let _: () = msg_send![window, makeKeyWindow];
    }

    /// NSString 은 CFString 과 같은 객체다(toll-free bridge). AX 속성 이름으로 그대로 쓴다.
    unsafe fn ns_string(s: &CStr) -> *mut AnyObject {
        let Some(cls) = AnyClass::get(c"NSString") else { return std::ptr::null_mut() };
        msg_send![cls, stringWithUTF8String: s.as_ptr()]
    }

    unsafe fn to_rust(obj: *mut AnyObject) -> Option<String> {
        let cls = AnyClass::get(c"NSString")?;
        if obj.is_null() {
            return None;
        }
        let is_string: Bool = msg_send![obj, isKindOfClass: cls];
        if !is_string.as_bool() {
            return None;
        }
        let utf8: *const std::ffi::c_char = msg_send![obj, UTF8String];
        (!utf8.is_null()).then(|| CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }

    pub unsafe fn frontmost_app_name() -> Option<String> {
        let ws_cls = AnyClass::get(c"NSWorkspace")?;
        let ws: *mut AnyObject = msg_send![ws_cls, sharedWorkspace];
        let front: *mut AnyObject = msg_send![ws, frontmostApplication];
        if front.is_null() {
            return None;
        }
        let name: *mut AnyObject = msg_send![front, localizedName];
        to_rust(name)
    }

    /// 권한 창은 실행당 한 번만 띄운다. 거절한 사람에게 단축키마다 들이밀면 안 된다.
    static PROMPTED: AtomicBool = AtomicBool::new(false);

    unsafe fn trusted() -> bool {
        let prompt = !PROMPTED.swap(true, Ordering::Relaxed);
        let (Some(dict_cls), Some(num_cls)) = (AnyClass::get(c"NSDictionary"), AnyClass::get(c"NSNumber")) else {
            return false;
        };
        let value: *mut AnyObject = msg_send![num_cls, numberWithBool: Bool::new(prompt)];
        let key = ns_string(c"AXTrustedCheckOptionPrompt");
        let options: *mut AnyObject = msg_send![dict_cls, dictionaryWithObject: value, forKey: key];
        AXIsProcessTrustedWithOptions(options as CFTypeRef)
    }

    pub unsafe fn selected_text() -> Option<String> {
        if !trusted() {
            return None;
        }
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            return None;
        }
        // 기본 제한은 6초다. 응답 없는 앱에 물으면 단축키가 그만큼 굳는다.
        AXUIElementSetMessagingTimeout(system, 0.25);

        let mut focused: CFTypeRef = std::ptr::null();
        let ok = AXUIElementCopyAttributeValue(system, ns_string(c"AXFocusedUIElement") as CFTypeRef, &mut focused);
        CFRelease(system);
        if ok != 0 || focused.is_null() {
            return None;
        }

        let mut selected: CFTypeRef = std::ptr::null();
        let ok = AXUIElementCopyAttributeValue(focused, ns_string(c"AXSelectedText") as CFTypeRef, &mut selected);
        CFRelease(focused);
        if ok != 0 || selected.is_null() {
            return None;
        }
        let text = to_rust(selected as *mut AnyObject);
        CFRelease(selected);
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_inside_the_visible_frame_of_the_screen() {
        // 오른쪽 외장 모니터: 왼쪽 끝 x=1512, 아래 Dock 70pt 위부터 1010pt 높이(포인트).
        assert_eq!(centered_origin((1512.0, 70.0, 1920.0, 1010.0), (640.0, 128.0)), (1512.0 + 640.0, 70.0 + 441.0));
    }

    #[test]
    fn works_for_screens_left_of_or_below_the_primary() {
        // 주 모니터 왼쪽에 둔 모니터는 x 가 음수다.
        assert_eq!(centered_origin((-1920.0, -200.0, 1920.0, 1080.0), (640.0, 128.0)), (-1280.0, 276.0));
    }

    #[test]
    fn blank_context_is_dropped() {
        assert_eq!(clip("  \n\t ".into()), None);
        assert_eq!(clip("  안녕 \n".into()).as_deref(), Some("안녕"));
    }

    #[test]
    fn huge_context_is_capped_by_characters_not_bytes() {
        // 바이트로 자르면 한글 중간이 잘려 깨진다.
        let long = "가".repeat(MAX_CONTEXT_CHARS + 50);
        assert_eq!(clip(long).unwrap().chars().count(), MAX_CONTEXT_CHARS);
    }
}
