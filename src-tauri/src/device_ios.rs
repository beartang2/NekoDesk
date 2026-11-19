//! 폰의 화면 밝기·소리 크기(도구 `device.level`). 맥은 지금처럼 AppleScript(code.exec)다. 값은 0~100.
//!
//! - 밝기: UIScreen.mainScreen.brightness 를 읽고 쓴다.
//! - 소리 크기: iOS 에는 시스템 볼륨을 바꾸는 공개 API 가 없다. 화면 밖에 둔 MPVolumeView 의 슬라이더 값을 바꾼다
//!   (직접 설치하는 앱이라 쓴다). 읽기는 AVAudioSession.outputVolume. 바꾼 뒤 다시 읽어 안 바뀌었으면 실패를 돌려준다 —
//!   조용히 성공한 척하지 않는다.
//! UIKit 은 main thread 에서만 만진다.

use crate::error::AppError;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::Encode;
use std::ffi::{c_char, c_void};
use std::sync::mpsc;
use std::time::Duration;

#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}
unsafe impl Encode for Rect {
    const ENCODING: objc2::Encoding = objc2::Encoding::Struct(
        "CGRect",
        &[
            objc2::Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]),
            objc2::Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]),
        ],
    );
}

extern "C" {
    fn dlopen(path: *const c_char, mode: std::ffi::c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// UIControlEventValueChanged
const VALUE_CHANGED: usize = 1 << 12;

fn on_main<T: Send + 'static>(app: &tauri::AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Result<T, AppError> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })?;
    rx.recv_timeout(Duration::from_secs(5)).map_err(|_| AppError::msg("화면이 답하지 않아요."))
}

fn pct(v: f64) -> i64 {
    (v.clamp(0.0, 1.0) * 100.0).round() as i64
}

/// 바꿀 값: set(그 값으로) 또는 by(지금에서 더하고 빼기), 둘 다 없으면 None(읽기만)
fn target(now: i64, set: Option<f64>, by: Option<f64>) -> Option<i64> {
    match (set, by) {
        (Some(s), _) => Some(s.round() as i64),
        (None, Some(b)) => Some(now + b.round() as i64),
        _ => None,
    }
    .map(|v| v.clamp(0, 100))
}

// ── 밝기 ──

unsafe fn screen() -> *mut AnyObject {
    match AnyClass::get(c"UIScreen") {
        Some(cls) => msg_send![cls, mainScreen],
        None => std::ptr::null_mut(),
    }
}

pub fn brightness(app: &tauri::AppHandle, set: Option<f64>, by: Option<f64>) -> Result<String, AppError> {
    on_main(app, move || unsafe {
        let s = screen();
        if s.is_null() {
            return Err(AppError::msg("화면 밝기를 읽을 수 없어요."));
        }
        let now: f64 = msg_send![s, brightness];
        let before = pct(now);
        let Some(to) = target(before, set, by) else { return Ok(format!("화면 밝기: {before}")) };
        let _: () = msg_send![s, setBrightness: to as f64 / 100.0];
        let after: f64 = msg_send![s, brightness];
        if (pct(after) - to).abs() > 2 {
            return Err(AppError::msg(format!("화면 밝기를 못 바꿨어요(지금 {}).", pct(after))));
        }
        Ok(format!("화면 밝기: {before} → {to}"))
    })?
}

// ── 소리 크기 ──

/// AVAudioSession(AVFAudio). 처음 한 번 '다른 소리와 섞이는' 분류로 켠다 — 안 켜면 outputVolume 이 낡은 값일 수 있고,
/// 이 분류는 듣던 음악을 멈추지 않는다(이 앱은 소리를 내지 않는다)
unsafe fn audio_session() -> *mut AnyObject {
    static READY: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    let h = dlopen(c"/System/Library/Frameworks/AVFAudio.framework/AVFAudio".as_ptr(), 1);
    let Some(cls) = AnyClass::get(c"AVAudioSession") else { return std::ptr::null_mut() };
    let session: *mut AnyObject = msg_send![cls, sharedInstance];
    if session.is_null() {
        return session;
    }
    READY.get_or_init(|| {
        let ambient = if h.is_null() { std::ptr::null() } else { dlsym(h, c"AVAudioSessionCategoryAmbient".as_ptr()) as *const *mut AnyObject };
        if !ambient.is_null() {
            let none: *mut *mut AnyObject = std::ptr::null_mut();
            let _: Bool = msg_send![session, setCategory: *ambient, error: none];
        }
        let none: *mut *mut AnyObject = std::ptr::null_mut();
        let _: Bool = msg_send![session, setActive: Bool::YES, error: none];
    });
    session
}

unsafe fn output_volume() -> Option<f64> {
    let s = audio_session();
    if s.is_null() {
        return None;
    }
    let v: f32 = msg_send![s, outputVolume];
    Some(v as f64)
}

/// 화면 밖에 둔 MPVolumeView 의 슬라이더. 앱이 사는 동안 하나를 창에 붙여 둔다(창에 붙어 있어야 슬라이더가 움직인다)
unsafe fn volume_slider() -> Option<*mut AnyObject> {
    static VIEW: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let view = *VIEW.get_or_init(|| {
        crate::music_ios::media_player();
        let (Some(cls), Some(app_cls)) = (AnyClass::get(c"MPVolumeView"), AnyClass::get(c"UIApplication")) else { return 0 };
        let app: *mut AnyObject = msg_send![app_cls, sharedApplication];
        let windows: *mut AnyObject = if app.is_null() { std::ptr::null_mut() } else { msg_send![app, windows] };
        let window: *mut AnyObject = if windows.is_null() { std::ptr::null_mut() } else { msg_send![windows, firstObject] };
        if window.is_null() {
            return 0;
        }
        let alloc: *mut AnyObject = msg_send![cls, alloc];
        let view: *mut AnyObject = msg_send![alloc, initWithFrame: Rect { x: -2000.0, y: -2000.0, w: 100.0, h: 40.0 }];
        if view.is_null() {
            return 0;
        }
        let _: () = msg_send![window, addSubview: view];
        view as usize
    });
    if view == 0 {
        return None;
    }
    let slider_cls = AnyClass::get(c"UISlider")?;
    let subviews: *mut AnyObject = msg_send![view as *mut AnyObject, subviews];
    let n: usize = if subviews.is_null() { 0 } else { msg_send![subviews, count] };
    (0..n)
        .map(|i| -> *mut AnyObject { msg_send![subviews, objectAtIndex: i] })
        .find(|v| !v.is_null() && { let ok: Bool = msg_send![*v, isKindOfClass: slider_cls]; ok.as_bool() })
}

pub fn volume(app: &tauri::AppHandle, set: Option<f64>, by: Option<f64>) -> Result<String, AppError> {
    let before = unsafe { output_volume() }.map(pct).ok_or("소리 크기를 읽을 수 없어요.")?;
    let Some(to) = target(before, set, by) else { return Ok(format!("소리 크기: {before}")) };
    // 슬라이더는 창에 붙인 뒤 한 박자 지나야 움직인다 — 처음이면 붙이고 잠깐 기다린다
    let found = on_main(app, || unsafe { volume_slider().is_some() })?;
    if !found {
        return Err(AppError::msg("소리는 못 바꿨어요: 소리 조절 막대를 찾지 못했어요."));
    }
    std::thread::sleep(Duration::from_millis(150));
    let moved = on_main(app, move || unsafe {
        let Some(slider) = volume_slider() else { return false };
        let _: () = msg_send![slider, setValue: to as f32 / 100.0, animated: Bool::NO];
        let _: () = msg_send![slider, sendActionsForControlEvents: VALUE_CHANGED];
        true
    })?;
    if !moved {
        return Err(AppError::msg("소리는 못 바꿨어요: 소리 조절 막대를 찾지 못했어요."));
    }
    // 시스템 볼륨은 조금 뒤에 바뀐다
    for _ in 0..6 {
        std::thread::sleep(Duration::from_millis(100));
        let now = unsafe { output_volume() }.map(pct).unwrap_or(before);
        if (now - to).abs() <= 7 {
            return Ok(format!("소리 크기: {before} → {now}"));
        }
    }
    let now = unsafe { output_volume() }.map(pct).unwrap_or(before);
    Err(AppError::msg(format!("소리는 못 바꿨어요(지금 {now}).")))
}
