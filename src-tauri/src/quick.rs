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
    let _ = win.center();
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("quick", "quick-context", ctx);
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
