//! 다른 앱 따라 하기(네코 감독의 '바깥' 입력, src/neko/ambient.ts). 사용자가 다른 앱에서 무엇을 하는지
//! 고양이가 흉내 낸다.
//!
//! - 맨 앞 앱: `NSWorkspace.frontmostApplication` 의 번들 ID. 권한이 필요 없다(화면 모드도 이걸 쓴다).
//! - 다른 앱에서 키를 친 지: `CGEventSourceSecondsSinceLastEventType(키 누름)`. 어떤 키인지는 모르고
//!   마지막으로 누른 뒤 지난 초만 안다.
//! - 글을 치는 중인지(단축키엔 반응하지 않게, 0.1.24 사용자): 두 조건이 다 맞을 때만.
//!   1. 키를 실제로 친다: 키 누름 횟수(`CGEventSourceCounterForEventType`)가 2초에 3번 넘게 늘었다. ⌘·⌃ 를 누르고
//!      있었으면 그 사이 키는 빼고(단축키), 조합키 누름(flagsChanged)만큼도 뺀다. 키 내용은 모른다(입력 모니터링 권한 안 씀).
//!   2. 입력 칸에 포커스: 손쉬운 사용 API 로 포커스된 요소의 역할만 본다(값·글은 안 읽는다). 키가 늘었을 때만 묻고
//!      3초 기억한다. 권한이 없으면 1번만 본다. Chromium·Electron 앱(Chrome·VS Code·Slack…)엔 묻지 않는다 — 물으면 그 앱이
//!      접근성 트리를 켜 CPU 를 더 쓰고 VS Code 는 화면 읽기 모드로 바뀔 수 있다(사용자 선택, docs/neko-perf.md).
//!      이 앱(NekoDesk)이 맨 앞이면 화면(ambient.ts)이 document.activeElement 로 본다.
//! - 음악 재생: 음악 앱이 켜져 있을 때만 그 앱에 AppleScript 로 묻는다(처음 한 번 '자동화' 권한 창).
//!   꺼진 앱엔 묻지 않는다 — 안 켜진 앱에 tell 하면 그 앱이 뜨거나 '어디 있나요' 창이 뜬다.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};
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
    /// 키를 실제로 치는 중(2초에 3번 넘게, ⌘·⌃ 단축키 뺌). 이 앱이 맨 앞이면 화면이 입력 칸을 따로 본다
    pub keys: bool,
    /// 다른 앱에서 글을 치는 중: keys 이고 포커스가 글 입력 칸(모르면 — 권한 없음·Chromium 앱 — 키만)
    pub typing: bool,
}

/// 이만큼 사이에
const KEY_WINDOW: Duration = Duration::from_millis(2200);
/// 이만큼 넘게 쳐야 글을 치는 중이다(단축키 한두 번은 아니다)
const MIN_KEYS: u32 = 3;
/// 입력 칸 판단을 기억하는 동안(키가 늘 때마다 묻지 않는다). 맨 앞 앱이 바뀌면 다시 묻는다
const FOCUS_TTL: Duration = Duration::from_secs(3);

struct Keys {
    /// 지난번 읽은 키 누름·조합키 바뀜 횟수
    last: Option<(u32, u32)>,
    /// 최근 간격마다 어림한 글 키 수
    recent: VecDeque<(Instant, u32)>,
    /// 마지막 입력 칸 판단: 그때, 그 앱, 결과
    focus: Option<(Instant, Option<String>, Option<bool>)>,
    /// 번들 ID → Chromium·Electron 앱인가(한 번만 본다)
    chromium: Vec<(String, bool)>,
}

static KEYS: Mutex<Keys> = Mutex::new(Keys { last: None, recent: VecDeque::new(), focus: None, chromium: Vec::new() });

/// 한 간격(1초 폴링 사이)에 친 글 키 수 어림. ⌘·⌃ 를 누르고 있었으면 0(단축키 연타). 아니면 키 누름에서 조합키 누름 수를
/// 뺀다(flagsChanged 는 누르고 뗄 때 둘) — ⌘C 한 번은 0 이 된다. Shift·⌥(대문자·쌍자음·특수문자)도 몇 개 빠지지만 글은 그보다 많다.
/// ponytail: 폴링 사이에 ⌘ 를 누르고 연타한 뒤 폴링 전에 떼면 못 거른다 — 그땐 입력 칸 조건이 남는다
fn typed_keys(keys: u32, flags: u32, cmd_ctrl: bool) -> u32 {
    if cmd_ctrl {
        0
    } else {
        keys.saturating_sub(flags / 2)
    }
}

/// 최근 KEY_WINDOW 간격들의 글 키 어림 합이 MIN_KEYS 이상인가
fn burst(typed: impl Iterator<Item = u32>) -> bool {
    typed.sum::<u32>() >= MIN_KEYS
}

/// 글을 치는 중인가: 키를 치고, 입력 칸이 아니라고 확실하지 않을 때(모르면 키만 본다)
fn judge(keys: bool, text_focus: Option<bool>) -> bool {
    keys && text_focus != Some(false)
}

/// 글 입력 칸 역할(손쉬운 사용 AXRole). 검색 칸·비밀번호 칸은 AXTextField 의 하위 역할이다
fn is_text_role(role: &str) -> bool {
    matches!(role, "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField")
}

/// Chromium·Electron 앱인가(번들의 Frameworks 에 그 엔진이 있다). 이런 앱은 입력 칸을 묻지 않는다
fn chromium_bundle(app: &std::path::Path) -> bool {
    const MARKS: [&str; 6] = ["Electron", "Chrom", "Browser Framework", "Edge Framework", "Opera Framework", "Vivaldi Framework"];
    std::fs::read_dir(app.join("Contents/Frameworks")).into_iter().flatten().flatten().any(|e| {
        let n = e.file_name().to_string_lossy().into_owned();
        n.ends_with(".framework") && MARKS.iter().any(|m| n.contains(m))
    })
}

pub fn probe(app: &AppHandle) -> Result<Probe, AppError> {
    let (front, own) = on_main(app, || unsafe { macos::frontmost() })?;
    let (keys, flags, cmd_ctrl) = macos::key_counters();
    let now = Instant::now();
    let mut st = KEYS.lock()?;
    let (k0, f0) = st.last.unwrap_or((keys, flags));
    st.last = Some((keys, flags));
    let fresh = keys.wrapping_sub(k0);
    st.recent.push_back((now, typed_keys(fresh, flags.wrapping_sub(f0), cmd_ctrl)));
    st.recent.retain(|(t, _)| now.duration_since(*t) <= KEY_WINDOW);
    // 입력 칸: 다른 앱에서 키가 늘었을 때만 묻고 FOCUS_TTL 동안 기억한다(앱이 바뀌면 다시)
    let known = st.focus.as_ref().filter(|(t, a, _)| *a == front && now.duration_since(*t) <= FOCUS_TTL).map(|f| f.2);
    let text_focus = match known {
        Some(t) => t,
        None if !own && fresh > 0 => {
            let skip = match front.as_deref() {
                Some(id) => match st.chromium.iter().find(|(a, _)| a == id) {
                    Some(&(_, c)) => c,
                    None => {
                        let owned = id.to_string();
                        let c = on_main(app, move || unsafe { macos::bundle_path(&owned) }).ok().flatten().is_some_and(|p| chromium_bundle(&p));
                        st.chromium.push((id.to_string(), c));
                        c
                    }
                },
                None => true,
            };
            let t = if skip { None } else { unsafe { macos::focused_role() }.map(|r| r.is_some_and(|r| is_text_role(&r))) };
            st.focus = Some((now, front.clone(), t));
            t
        }
        None => None,
    };
    let keys = burst(st.recent.iter().map(|(_, n)| *n));
    Ok(Probe { app: front, own, typed_ago: macos::seconds_since_key(), keys, typing: !own && judge(keys, text_focus) })
}

/// 켜져 있는 음악 앱 중 하나라도 재생 중인가. 권한을 안 주거나 물을 수 없으면 false.
pub fn music(app: &AppHandle) -> Result<bool, AppError> {
    let running = on_main(app, || unsafe { macos::running(&MUSIC_APPS) })?;
    Ok(running.iter().any(|id| playing(id)))
}

/// 지금 듣는 곡(산책이 출발 전 상태를 가지고 나갈 때 한 번, walk). 재생 중인 첫 음악 앱 기준.
#[derive(Serialize, Debug, PartialEq)]
pub struct Track {
    pub title: String,
    pub artist: String,
}

/// 재생 중인 음악 앱의 곡 제목·가수. 재생 중이 아니거나 권한이 없으면 None. 같은 앱 자동화 권한이라 새 권한 창은 없다.
pub fn track(app: &AppHandle) -> Result<Option<Track>, AppError> {
    let running = on_main(app, || unsafe { macos::running(&MUSIC_APPS) })?;
    Ok(running.iter().filter(|id| playing(id)).find_map(|id| current_track(id)))
}

fn current_track(bundle: &str) -> Option<Track> {
    let script = format!("tell application id \"{bundle}\" to (name of current track) & linefeed & (artist of current track)");
    let out = std::process::Command::new("/usr/bin/osascript").args(["-e", &script]).output().ok()?;
    out.status.success().then(|| parse_track(&String::from_utf8_lossy(&out.stdout))).flatten()
}

/// osascript 답("제목\n가수\n") → 곡. 제목이 비면 None
fn parse_track(answer: &str) -> Option<Track> {
    let mut lines = answer.trim_end_matches(['\n', '\r']).splitn(2, '\n');
    let title = lines.next()?.trim().to_string();
    let artist = lines.next().unwrap_or("").trim().to_string();
    (!title.is_empty()).then_some(Track { title, artist })
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
    use crate::quick::macos::{ns_string, to_rust};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    /// kCGEventSourceStateHIDSystemState
    const HID_SYSTEM_STATE: i32 = 1;
    /// kCGEventKeyDown
    const KEY_DOWN: u32 = 10;
    /// kCGEventFlagsChanged(조합키를 누르고 뗌)
    const FLAGS_CHANGED: u32 = 12;
    /// kCGEventFlagMaskCommand | kCGEventFlagMaskControl. Shift·⌥ 는 글(대문자·쌍자음·특수문자)에도 써서 막지 않는다
    const CMD_CTRL: u64 = 0x10_0000 | 0x4_0000;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
        fn CGEventSourceFlagsState(state: i32) -> u64;
    }

    type CFTypeRef = *const std::ffi::c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXUIElementCreateSystemWide() -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(el: CFTypeRef, attr: CFTypeRef, out: *mut CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(el: CFTypeRef, seconds: f32) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: CFTypeRef);
    }
    /// kAXErrorNoValue: 포커스된 요소가 없다
    const AX_NO_VALUE: i32 = -25212;

    pub fn seconds_since_key() -> f64 {
        unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, KEY_DOWN) }
    }

    /// (키 누름 횟수, 조합키 바뀜 횟수, 지금 ⌘·⌃ 를 누르고 있나). 어느 키인지는 모른다.
    pub fn key_counters() -> (u32, u32, bool) {
        unsafe {
            (
                CGEventSourceCounterForEventType(HID_SYSTEM_STATE, KEY_DOWN),
                CGEventSourceCounterForEventType(HID_SYSTEM_STATE, FLAGS_CHANGED),
                CGEventSourceFlagsState(HID_SYSTEM_STATE) & CMD_CTRL != 0,
            )
        }
    }

    /// 시스템 전체에서 포커스된 요소의 역할(AXRole)만. 값·글은 읽지 않는다. 권한이 없거나 묻지 못하면 None,
    /// 포커스된 요소가 없으면 Some(None). 권한 창은 띄우지 않는다(빠른 질문이 띄운다).
    pub unsafe fn focused_role() -> Option<Option<String>> {
        if !AXIsProcessTrusted() {
            return None;
        }
        let system = AXUIElementCreateSystemWide();
        if system.is_null() {
            return None;
        }
        // 기본 제한은 6초다. 응답 없는 앱에 물으면 그만큼 굳는다
        AXUIElementSetMessagingTimeout(system, 0.25);
        let mut focused: CFTypeRef = std::ptr::null();
        let ok = AXUIElementCopyAttributeValue(system, ns_string(c"AXFocusedUIElement") as CFTypeRef, &mut focused);
        CFRelease(system);
        if ok == AX_NO_VALUE {
            return Some(None);
        }
        if ok != 0 || focused.is_null() {
            return None;
        }
        let mut role: CFTypeRef = std::ptr::null();
        let ok = AXUIElementCopyAttributeValue(focused, ns_string(c"AXRole") as CFTypeRef, &mut role);
        CFRelease(focused);
        if ok != 0 || role.is_null() {
            return Some(None);
        }
        let out = to_rust(role as *mut AnyObject);
        CFRelease(role);
        Some(out)
    }

    /// 번들 ID 의 앱 자리. main thread 전용.
    pub unsafe fn bundle_path(id: &str) -> Option<std::path::PathBuf> {
        let ws = workspace()?;
        let id = std::ffi::CString::new(id).ok()?;
        let url: *mut AnyObject = msg_send![ws, URLForApplicationWithBundleIdentifier: ns_string(&id)];
        if url.is_null() {
            return None;
        }
        let path: *mut AnyObject = msg_send![url, path];
        to_rust(path).map(std::path::PathBuf::from)
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

    /// 폴링 간격들의 (키 누름, 조합키 바뀜, ⌘·⌃ 누름)과 입력 칸 판단으로 probe 와 같게 판정한다
    fn typing(intervals: &[(u32, u32, bool)], text_focus: Option<bool>) -> bool {
        judge(burst(intervals.iter().map(|&(k, f, m)| typed_keys(k, f, m))), text_focus)
    }

    #[test]
    fn typing_needs_real_keys_and_a_text_field() {
        // 단축키 한 번(⌘C — 폴링 땐 이미 뗌): 키 1, 조합키 누르고 뗌 2 → 아니다
        assert!(!typing(&[(1, 2, false)], Some(true)));
        // 단축키 연타(⌘ 누른 채 Z 여러 번 — 폴링 때 ⌘ 를 누르고 있다) → 아니다. ⌘Tab 으로 앱 넘기기도
        assert!(!typing(&[(5, 1, true), (3, 1, true)], Some(true)));
        // ⌘C ⌘V 를 번갈아(뗐다 누름) → 아니다
        assert!(!typing(&[(2, 4, false), (2, 4, false)], Some(true)));
        // 입력 칸에서 타이핑(Shift 몇 번 섞여도) → 맞다
        assert!(typing(&[(6, 0, false), (5, 2, false)], Some(true)));
        // 입력 칸 밖에서 키 연타(Finder 화살표·게임) → 아니다
        assert!(!typing(&[(8, 0, false), (7, 0, false)], Some(false)));
        // 입력 칸을 모르면(권한 없음·Chromium 앱) 키만 본다 — 단축키는 그래도 걸러진다
        assert!(typing(&[(4, 0, false)], None));
        assert!(!typing(&[(1, 2, false)], None));
        // 2초에 두 번은 아직 아니다
        assert!(!typing(&[(1, 0, false), (1, 0, false)], Some(true)));
    }

    #[test]
    fn text_roles_and_chromium_apps() {
        for r in ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"] {
            assert!(is_text_role(r), "{r}");
        }
        for r in ["AXOutline", "AXList", "AXButton", "AXWebArea", "AXGroup"] {
            assert!(!is_text_role(r), "{r}");
        }
        let root = std::env::temp_dir().join(format!("neko-ambient-{}", std::process::id()));
        for (app, fw) in [("Code.app", "Electron Framework.framework"), ("Chrome.app", "Google Chrome Framework.framework"), ("Notes.app", "Notes.framework")] {
            std::fs::create_dir_all(root.join(app).join("Contents/Frameworks").join(fw)).unwrap();
        }
        assert!(chromium_bundle(&root.join("Code.app")));
        assert!(chromium_bundle(&root.join("Chrome.app")));
        assert!(!chromium_bundle(&root.join("Notes.app")));
        assert!(!chromium_bundle(&root.join("없는.app")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reads_track_answers() {
        assert_eq!(parse_track("밤편지\n아이유\n"), Some(Track { title: "밤편지".into(), artist: "아이유".into() }));
        assert_eq!(parse_track("Intro\n\n"), Some(Track { title: "Intro".into(), artist: String::new() }));
        assert_eq!(parse_track("\n"), None);
        assert_eq!(parse_track(""), None);
    }

    #[test]
    fn reads_player_state_answers() {
        assert!(is_playing("playing\n"));
        assert!(!is_playing("paused"));
        assert!(!is_playing("stopped"));
        assert!(!is_playing(""));
    }
}
