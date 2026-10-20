//! 일정 알림 때 커서가 있는 화면의 테두리를 빛낸다. 캡처 막의 가장자리 빛(edge-flow.ts)을 그대로
//! 쓴다 — 커서에서 퍼져 테두리에 붙고, 잠깐 숨 쉬다가 스러진다(GlowAlert.tsx).
//!
//! 클릭이 뒤로 그대로 지나가는 투명 창이라 하던 일을 막지 않는다. 앱을 활성화하지 않고 전체화면
//! 앱 위에도 뜬다. 창은 캡처 막처럼 부수지 않고 숨겨 두었다 다시 쓴다 — 패널로 바꾼 창을 닫으면
//! 앱이 죽었다(capture.rs).

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::error::AppError;

const LABEL: &str = "glow";

/// 빛이 퍼져 나올 커서 자리(그 화면 기준, 왼쪽 위 원점)와 화면 크기. 포인트.
#[derive(Serialize, Clone, Copy, Debug)]
pub struct GlowAt {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// 막 만든 창은 아직 이벤트를 못 듣는다. 띄울 자리를 여기 두고, 창이 열릴 때나 glow-alert 를 받을 때
/// 가져가게 한다(take).
static PENDING: Mutex<Option<GlowAt>> = Mutex::new(None);

pub fn alert(app: &AppHandle) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        // 캡처 막이 떠 있으면 이미 테두리가 빛나고 있다.
        if crate::capture::is_active(app) {
            return Ok(());
        }
        let win = match app.get_webview_window(LABEL) {
            Some(w) => w,
            None => tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html".into()))
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .skip_taskbar(true)
                .always_on_top(true)
                .visible(false)
                .focused(false)
                .build()?,
        };
        let ns = win.ns_window()? as usize;
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(unsafe { macos::cover_cursor_screen(ns as *mut objc2::runtime::AnyObject) });
        })?;
        let Some(at) = rx.recv().map_err(|_| AppError::msg("main thread 가 답하지 않았어."))? else {
            return Ok(());
        };
        *PENDING.lock()? = Some(at);
        let _ = app.emit_to(LABEL, "glow-alert", ());
    }
    Ok(())
}

pub fn take() -> Option<GlowAt> {
    PENDING.lock().ok()?.take()
}

#[cfg(target_os = "macos")]
mod macos {
    use super::GlowAt;
    use crate::quick::macos::make_panel;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::{NSPoint, NSRect};

    /// 커서가 있는 화면을 덮어 띄운다. 키 창으로 만들지 않는다 — 하던 입력을 빼앗지 않게. main thread 전용.
    pub unsafe fn cover_cursor_screen(window: *mut AnyObject) -> Option<GlowAt> {
        let (event_cls, screen_cls) = (AnyClass::get(c"NSEvent")?, AnyClass::get(c"NSScreen")?);
        make_panel(window, false);
        let _: () = msg_send![window, setIgnoresMouseEvents: Bool::YES];
        let mouse: NSPoint = msg_send![event_cls, mouseLocation];
        let screens: *mut AnyObject = msg_send![screen_cls, screens];
        let count: usize = msg_send![screens, count];
        for i in 0..count {
            let screen: *mut AnyObject = msg_send![screens, objectAtIndex: i];
            let f: NSRect = msg_send![screen, frame];
            let inside = mouse.x >= f.origin.x
                && mouse.x < f.origin.x + f.size.width
                && mouse.y >= f.origin.y
                && mouse.y < f.origin.y + f.size.height;
            if inside {
                let _: () = msg_send![window, setFrame: f, display: true];
                let _: () = msg_send![window, orderFrontRegardless];
                return Some(GlowAt {
                    x: mouse.x - f.origin.x,
                    y: f.origin.y + f.size.height - mouse.y,
                    w: f.size.width,
                    h: f.size.height,
                });
            }
        }
        None
    }
}
