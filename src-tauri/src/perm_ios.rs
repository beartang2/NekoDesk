//! 폰 설정의 권한 칸: 폰이 실제로 쓰는 권한(위치·음악 보관함·카메라·붙여넣기)의 상태와 묻기·설정 앱 열기.
//! 상태는 "allowed"(허용)·"denied"(거절)·"ask"(아직 안 물음). 붙여넣기는 iOS 가 상태를 알려 주지 않아 늘 "ask"
//! (붙여넣을 때 묻는다 — 설정 앱에서 '허용'으로 바꿀 수 있다).

use crate::error::AppError;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use serde::Serialize;
use std::ffi::{c_char, c_void};
use std::sync::mpsc;
use std::time::Duration;

extern "C" {
    fn dlopen(path: *const c_char, mode: std::ffi::c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

#[derive(Serialize)]
pub struct Permissions {
    location: &'static str,
    music: &'static str,
    camera: &'static str,
    paste: &'static str,
}

/// AVFoundation 의 AVMediaTypeVideo(카메라)
unsafe fn video() -> *mut AnyObject {
    let h = dlopen(c"/System/Library/Frameworks/AVFoundation.framework/AVFoundation".as_ptr(), 1);
    if h.is_null() {
        return std::ptr::null_mut();
    }
    let p = dlsym(h, c"AVMediaTypeVideo".as_ptr()) as *const *mut AnyObject;
    if p.is_null() { std::ptr::null_mut() } else { *p }
}

fn camera() -> &'static str {
    unsafe {
        let kind = video();
        let Some(cls) = AnyClass::get(c"AVCaptureDevice").filter(|_| !kind.is_null()) else { return "denied" };
        // AVAuthorizationStatus: 0 아직, 1 제한, 2 거절, 3 허용
        let status: isize = msg_send![cls, authorizationStatusForMediaType: kind];
        match status {
            0 => "ask",
            3 => "allowed",
            _ => "denied",
        }
    }
}

pub fn status() -> Permissions {
    Permissions { location: crate::location::permission(), music: crate::music_ios::permission(), camera: camera(), paste: "ask" }
}

/// 아직 안 물은 권한을 묻는다(iOS 권한 창). 답이 오면 새 상태를 돌려준다
pub async fn ask(app: &tauri::AppHandle, kind: &str) -> Result<Permissions, AppError> {
    match kind {
        // 위치는 한 번 물어 보면서 권한 창이 뜬다. 위치를 못 잡아도 권한만 정해지면 된다
        "location" => {
            let _ = crate::location::current(app).await;
        }
        "music" => {
            let _ = tauri::async_runtime::spawn_blocking(crate::music_ios::authorized).await;
        }
        "camera" => {
            let _ = tauri::async_runtime::spawn_blocking(|| unsafe {
                let kind = video();
                let Some(cls) = AnyClass::get(c"AVCaptureDevice").filter(|_| !kind.is_null()) else { return };
                let (tx, rx) = mpsc::channel::<bool>();
                let done = block2::RcBlock::new(move |ok: Bool| {
                    let _ = tx.send(ok.as_bool());
                });
                let _: () = msg_send![cls, requestAccessForMediaType: kind, completionHandler: &*done];
                let _ = rx.recv_timeout(Duration::from_secs(120));
            })
            .await;
        }
        _ => {}
    }
    Ok(status())
}

/// 설정 앱의 이 앱 화면을 연다(거절한 권한을 다시 켜는 곳). "app-settings:" 는 UIApplicationOpenSettingsURLString 의 값
pub fn open_settings(app: &tauri::AppHandle) -> Result<(), AppError> {
    open_url(app, "app-settings:")
}

/// 링크를 연다(사파리·설정 앱 등, UIApplication openURL)
pub fn open_url(app: &tauri::AppHandle, url: &str) -> Result<(), AppError> {
    let url = std::ffi::CString::new(url).map_err(|e| AppError::msg(e.to_string()))?;
    app.run_on_main_thread(move || unsafe {
        let (Some(app_cls), Some(url_cls)) = (AnyClass::get(c"UIApplication"), AnyClass::get(c"NSURL")) else { return };
        let Some(str_cls) = AnyClass::get(c"NSString") else { return };
        let text: *mut AnyObject = msg_send![str_cls, stringWithUTF8String: url.as_ptr()];
        let url: *mut AnyObject = msg_send![url_cls, URLWithString: text];
        let app: *mut AnyObject = msg_send![app_cls, sharedApplication];
        if url.is_null() || app.is_null() {
            return;
        }
        let options: *mut AnyObject = match AnyClass::get(c"NSDictionary") {
            Some(d) => msg_send![d, dictionary],
            None => return,
        };
        let none: *mut AnyObject = std::ptr::null_mut();
        let _: () = msg_send![app, openURL: url, options: options, completionHandler: none];
    })?;
    Ok(())
}
