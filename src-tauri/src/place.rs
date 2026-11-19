//! 창을 어느 모니터 가운데에 띄울지. `.center()` 는 늘 주 모니터(맥북 화면) 가운데라 외장 모니터를 쓰면
//! 엉뚱한 화면에 떴다.
//!
//! - 앱을 켤 때 메인 창과 빠른 질문 창: 마우스가 있는 모니터.
//! - 팝업(뷰어·꾸미기·선물함): 메인 창이 있는 모니터. 이미 떠 있는 팝업은 그 모니터에 있으면 사용자가 둔
//!   자리를 지키고, 다른 모니터에 있으면 가운데로 옮긴다.
//!
//! 맥은 AppKit 의 포인트 좌표(왼쪽 아래 원점, 모든 모니터가 한 좌표계)로 계산한다 — 배율이 다른 모니터가
//! 섞여도 어긋나지 않는다. 가운데는 메뉴 막대·Dock 을 뺀 작업 영역(visibleFrame) 기준이다.

use tauri::WebviewWindow;

/// 어느 모니터로
pub enum Screen<'a> {
    /// 마우스가 있는 모니터
    Cursor,
    /// 이 창이 있는 모니터(못 찾으면 마우스가 있는 모니터)
    Of(&'a WebviewWindow),
}

/// win 을 그 모니터 가운데로. keep: 이미 그 모니터에 있으면 그대로 둔다.
/// 메인 스레드에서 돈다 — 뒤이어 부르는 show() 는 옮긴 다음에 처리된다.
pub fn center(win: &WebviewWindow, on: Screen, keep: bool) {
    #[cfg(target_os = "macos")]
    {
        let me = win.ns_window().map(|p| p as usize);
        let of = match on {
            Screen::Cursor => Ok(None),
            Screen::Of(w) => w.ns_window().map(|p| Some(p as usize)),
        };
        if let (Ok(me), Ok(of)) = (me, of) {
            let _ = win.run_on_main_thread(move || unsafe {
                macos::center(me as _, of.map(|p| p as _), keep);
            });
            return;
        }
    }
    let _ = (on, keep);
    let _ = win.center();
}

/// 작업 영역(x, y, w, h) 안에서 창을 가운데 둘 원점(포인트)
pub(crate) fn centered_origin(visible: (f64, f64, f64, f64), win_size: (f64, f64)) -> (f64, f64) {
    let (x, y, w, h) = visible;
    ((x + (w - win_size.0) / 2.0).round(), (y + (h - win_size.1) / 2.0).round())
}

#[cfg(target_os = "macos")]
pub(crate) mod macos {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSPoint, NSRect};

    fn inside(p: NSPoint, r: NSRect) -> bool {
        p.x >= r.origin.x && p.x < r.origin.x + r.size.width && p.y >= r.origin.y && p.y < r.origin.y + r.size.height
    }

    unsafe fn cursor_screen() -> *mut AnyObject {
        let (Some(event), Some(screen)) = (AnyClass::get(c"NSEvent"), AnyClass::get(c"NSScreen")) else {
            return std::ptr::null_mut();
        };
        let mouse: NSPoint = msg_send![event, mouseLocation];
        let screens: *mut AnyObject = msg_send![screen, screens];
        let count: usize = msg_send![screens, count];
        for i in 0..count {
            let s: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            let frame: NSRect = msg_send![s, frame];
            if inside(mouse, frame) {
                return s;
            }
        }
        std::ptr::null_mut()
    }

    /// window 를 of 창의 모니터(없으면 마우스 모니터) 가운데로. 메인 스레드에서만
    pub unsafe fn center(window: *mut AnyObject, of: Option<*mut AnyObject>, keep: bool) {
        let mut screen: *mut AnyObject = match of {
            Some(w) => msg_send![w, screen],
            None => std::ptr::null_mut(),
        };
        if screen.is_null() {
            screen = cursor_screen();
        }
        if screen.is_null() {
            return;
        }
        let area: NSRect = msg_send![screen, frame];
        if keep {
            let mine: *mut AnyObject = msg_send![window, screen];
            if !mine.is_null() {
                let f: NSRect = msg_send![mine, frame];
                if f == area {
                    return;
                }
            }
        }
        let visible: NSRect = msg_send![screen, visibleFrame];
        let f: NSRect = msg_send![window, frame];
        let (x, y) = super::centered_origin(
            (visible.origin.x, visible.origin.y, visible.size.width, visible.size.height),
            (f.size.width, f.size.height),
        );
        let _: () = msg_send![window, setFrameOrigin: NSPoint::new(x, y)];
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
}
