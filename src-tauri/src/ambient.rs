//! 다른 앱 따라 하기(네코 감독의 '바깥' 입력, src/neko/ambient.ts). 사용자가 다른 앱에서 무엇을 하는지
//! 고양이가 흉내 낸다.
//!
//! - 맨 앞 앱: `NSWorkspace.frontmostApplication` 의 번들 ID. 권한이 필요 없다(화면 모드도 이걸 쓴다).
//! - 다른 앱에서 키를 친 지: `CGEventSourceSecondsSinceLastEventType(키 누름)`. 어떤 키인지는 모르고
//!   마지막으로 누른 뒤 지난 초만 안다.
//! - 음악 재생: 음악 앱이 켜져 있을 때만 그 앱에 AppleScript 로 묻는다(처음 한 번 '자동화' 권한 창).
//!   꺼진 앱엔 묻지 않는다 — 안 켜진 앱에 tell 하면 그 앱이 뜨거나 '어디 있나요' 창이 뜬다.

use serde::Serialize;
use tauri::AppHandle;

use crate::capture::on_main;
use crate::error::AppError;

/// 재생 중인지 물어볼 음악 앱
const MUSIC_APPS: [&str; 2] = ["com.apple.Music", "com.spotify.client"];

#[derive(Serialize, Debug, PartialEq)]
pub struct Probe {
    /// 맨 앞 앱 번들 ID. 모르면 None
    pub app: Option<String>,
    /// 맨 앞 앱이 이 앱(NekoDesk)이다 — 이때 타이핑은 앱 안 입력이라 감독이 따로 센다
    pub own: bool,
    /// 마지막으로 키를 누른 뒤 지난 초(어느 앱이든)
    pub typed_ago: f64,
}

pub fn probe(app: &AppHandle) -> Result<Probe, AppError> {
    let (front, own) = on_main(app, || unsafe { macos::frontmost() })?;
    Ok(Probe { app: front, own, typed_ago: macos::seconds_since_key() })
}

/// 켜져 있는 음악 앱 중 하나라도 재생 중인가. 권한을 안 주거나 물을 수 없으면 false.
pub fn music(app: &AppHandle) -> Result<bool, AppError> {
    let running = on_main(app, || unsafe { macos::running(&MUSIC_APPS) })?;
    Ok(running.iter().any(|id| playing(id)))
}

fn playing(bundle: &str) -> bool {
    let script = format!("tell application id \"{bundle}\" to (player state as string)");
    std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .map(|o| is_playing(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false)
}

/// Music 는 "playing", Spotify 는 "playing"(또는 상수 이름 «kPSP»)으로 답한다.
fn is_playing(answer: &str) -> bool {
    let a = answer.trim();
    a == "playing" || a == "«constant ****kPSP»"
}

pub(crate) mod macos {
    use crate::quick::macos::to_rust;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    /// kCGEventSourceStateHIDSystemState
    const HID_SYSTEM_STATE: i32 = 1;
    /// kCGEventKeyDown
    const KEY_DOWN: u32 = 10;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }

    pub fn seconds_since_key() -> f64 {
        unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, KEY_DOWN) }
    }

    unsafe fn workspace() -> Option<*mut AnyObject> {
        let ws: *mut AnyObject = msg_send![AnyClass::get(c"NSWorkspace")?, sharedWorkspace];
        (!ws.is_null()).then_some(ws)
    }

    /// 맨 앞 앱 번들 ID 와 그게 이 앱인지. main thread 전용.
    pub unsafe fn frontmost() -> (Option<String>, bool) {
        let Some(ws) = workspace() else { return (None, false) };
        let front: *mut AnyObject = msg_send![ws, frontmostApplication];
        if front.is_null() {
            return (None, false);
        }
        let pid: i32 = msg_send![front, processIdentifier];
        let id: *mut AnyObject = msg_send![front, bundleIdentifier];
        (to_rust(id), pid as u32 == std::process::id())
    }

    /// 주어진 번들 ID 중 켜져 있는 것. main thread 전용.
    pub unsafe fn running(ids: &[&str]) -> Vec<String> {
        let Some(ws) = workspace() else { return vec![] };
        let apps: *mut AnyObject = msg_send![ws, runningApplications];
        let count: usize = msg_send![apps, count];
        let mut out = Vec::new();
        for i in 0..count {
            let a: *mut AnyObject = msg_send![apps, objectAtIndex: i];
            let id: *mut AnyObject = msg_send![a, bundleIdentifier];
            if let Some(id) = to_rust(id).filter(|id| ids.contains(&id.as_str()) && !out.contains(id)) {
                out.push(id);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_player_state_answers() {
        assert!(is_playing("playing\n"));
        assert!(!is_playing("paused"));
        assert!(!is_playing("stopped"));
        assert!(!is_playing(""));
    }
}
