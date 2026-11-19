//! 폰의 음악 조작(도구 `music.control`): iOS 음악 앱을 MediaPlayer(MPMusicPlayerController.systemMusicPlayer)로 다룬다.
//! 맥은 지금처럼 AppleScript(code.exec)다. 범위는 사용자 보관함의 곡·가수·앨범·재생목록 — Apple Music 카탈로그 검색은
//! MusicKit 개발자 토큰(유료 개발자 계정)이 있어야 해서 하지 않는다.
//!
//! 처음 쓸 때 "미디어 및 Apple Music" 권한을 묻는다(Info.ios.plist 의 NSAppleMusicUsageDescription). 거절하면 안내 글을 돌려준다.
//! 플레이어는 main thread 에서만 만진다.

use crate::error::AppError;
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use std::ffi::{c_char, CStr};
use std::sync::mpsc;
use std::time::Duration;

extern "C" {
    fn dlopen(path: *const c_char, mode: std::ffi::c_int) -> *mut std::ffi::c_void;
    fn dlsym(handle: *mut std::ffi::c_void, symbol: *const c_char) -> *mut std::ffi::c_void;
}

/// MediaPlayer 프레임워크를 실행 중에 불러온다. Rust 의 #[link] 는 정적 라이브러리(libapp.a)에서 Xcode 의 최종 링크까지
/// 넘어가지 않아 'Undefined symbols' 가 났다 — Xcode 프로젝트를 고치는 대신 여기서 연다(시스템 프레임워크라 늘 있다).
pub(crate) fn media_player() -> Option<usize> {
    static HANDLE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    let h = *HANDLE.get_or_init(|| unsafe { dlopen(c"/System/Library/Frameworks/MediaPlayer.framework/MediaPlayer".as_ptr(), 1) as usize });
    (h != 0).then_some(h)
}

/// 프레임워크의 문자열 상수(MPMediaItemPropertyTitle 등)
unsafe fn constant(name: &CStr) -> *const AnyObject {
    let Some(h) = media_player() else { return std::ptr::null() };
    let p = dlsym(h as *mut std::ffi::c_void, name.as_ptr()) as *const *const AnyObject;
    if p.is_null() { std::ptr::null() } else { *p }
}

/// MPMediaLibraryAuthorizationStatus
const AUTHORIZED: isize = 3;
const NOT_DETERMINED: isize = 0;
/// MPMusicPlaybackState
const PLAYING: isize = 1;
/// MPMediaPredicateComparisonContains
const CONTAINS: isize = 1;
/// MPMusicShuffleModeSongs
const SHUFFLE_SONGS: isize = 2;

const DENIED: &str = "음악 보관함에 접근할 수 없어요. 설정 앱 › NekoDesk › 미디어 및 Apple Music 을 켜 주세요.";

fn class(name: &CStr) -> Result<&'static AnyClass, AppError> {
    media_player();
    AnyClass::get(name).ok_or_else(|| AppError::msg("이 기기에서는 음악 앱을 다룰 수 없어요."))
}

unsafe fn ns_string(s: &str) -> *mut AnyObject {
    let c = std::ffi::CString::new(s.replace('\0', "")).unwrap_or_default();
    match AnyClass::get(c"NSString") {
        Some(cls) => msg_send![cls, stringWithUTF8String: c.as_ptr()],
        None => std::ptr::null_mut(),
    }
}

unsafe fn rust_string(ns: *mut AnyObject) -> Option<String> {
    if ns.is_null() {
        return None;
    }
    let utf8: *const c_char = msg_send![ns, UTF8String];
    (!utf8.is_null()).then(|| CStr::from_ptr(utf8).to_string_lossy().into_owned())
}

/// 권한. 처음이면 묻고 답을 기다린다(시스템 창, 최대 2분). main thread 가 아닌 데서 부른다.
fn authorized() -> Result<bool, AppError> {
    let lib = class(c"MPMediaLibrary")?;
    let status: isize = unsafe { msg_send![lib, authorizationStatus] };
    if status != NOT_DETERMINED {
        return Ok(status == AUTHORIZED);
    }
    let (tx, rx) = mpsc::channel::<isize>();
    let block = block2::RcBlock::new(move |s: isize| {
        let _ = tx.send(s);
    });
    unsafe {
        let _: () = msg_send![lib, requestAuthorization: &*block];
    }
    Ok(rx.recv_timeout(Duration::from_secs(120)).unwrap_or(NOT_DETERMINED) == AUTHORIZED)
}

/// 권한이 이미 있나(묻지 않는다)
fn already_authorized() -> bool {
    media_player();
    AnyClass::get(c"MPMediaLibrary").is_some_and(|lib| {
        let status: isize = unsafe { msg_send![lib, authorizationStatus] };
        status == AUTHORIZED
    })
}

unsafe fn player() -> Result<*mut AnyObject, AppError> {
    let p: *mut AnyObject = msg_send![class(c"MPMusicPlayerController")?, systemMusicPlayer];
    if p.is_null() { Err(AppError::msg("음악 앱을 열 수 없어요.")) } else { Ok(p) }
}

/// 지금 곡(제목·가수)과 재생 중인지
unsafe fn now(p: *mut AnyObject) -> (Option<(String, String)>, bool) {
    let item: *mut AnyObject = msg_send![p, nowPlayingItem];
    let state: isize = msg_send![p, playbackState];
    let song = (!item.is_null()).then(|| {
        let title: *mut AnyObject = msg_send![item, title];
        let artist: *mut AnyObject = msg_send![item, artist];
        (rust_string(title).unwrap_or_default(), rust_string(artist).unwrap_or_default())
    });
    (song, state == PLAYING)
}

fn describe(song: &Option<(String, String)>) -> String {
    match song {
        Some((t, a)) if !a.is_empty() => format!("{t} — {a}"),
        Some((t, _)) => t.clone(),
        None => "곡 없음".into(),
    }
}

/// 보관함에서 찾아 대기열에 넣는다. 찾은 종류를 돌려준다(없으면 None)
unsafe fn queue_search(p: *mut AnyObject, text: &str, kind: Option<&str>) -> Result<Option<&'static str>, AppError> {
    let query_cls = class(c"MPMediaQuery")?;
    let pred_cls = class(c"MPMediaPropertyPredicate")?;
    let value = ns_string(text);
    // 종류를 안 주면 재생목록 → 곡 → 가수 → 앨범 순으로 찾는다
    let order: &[&str] = match kind {
        Some("playlist") => &["playlist"],
        Some("song") => &["song"],
        Some("artist") => &["artist"],
        Some("album") => &["album"],
        _ => &["playlist", "song", "artist", "album"],
    };
    for k in order {
        let (query, prop, label): (*mut AnyObject, *const AnyObject, &'static str) = match *k {
            "playlist" => (msg_send![query_cls, playlistsQuery], constant(c"MPMediaPlaylistPropertyName"), "재생목록"),
            "song" => (msg_send![query_cls, songsQuery], constant(c"MPMediaItemPropertyTitle"), "곡"),
            "artist" => (msg_send![query_cls, songsQuery], constant(c"MPMediaItemPropertyArtist"), "가수"),
            _ => (msg_send![query_cls, songsQuery], constant(c"MPMediaItemPropertyAlbumTitle"), "앨범"),
        };
        if query.is_null() || prop.is_null() {
            continue;
        }
        let pred: *mut AnyObject = msg_send![pred_cls, predicateWithValue: value, forProperty: prop, comparisonType: CONTAINS];
        let _: () = msg_send![query, addFilterPredicate: pred];
        let items: *mut AnyObject = msg_send![query, items];
        let count: usize = if items.is_null() { 0 } else { msg_send![items, count] };
        if count == 0 {
            continue;
        }
        let _: () = msg_send![p, setQueueWithQuery: query];
        return Ok(Some(label));
    }
    Ok(None)
}

/// 도구 하나: action = play | pause | next | previous | now | search. search 는 query(와 고르면 kind: song·artist·album·playlist)
pub fn control(app: &tauri::AppHandle, action: &str, query: Option<String>, kind: Option<String>) -> Result<String, AppError> {
    if !authorized()? {
        return Ok(DENIED.into());
    }
    let action = action.to_owned();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let r = unsafe { run(&action, query.as_deref().map(str::trim).filter(|q| !q.is_empty()), kind.as_deref()) };
        let _ = tx.send(r);
    })?;
    rx.recv_timeout(Duration::from_secs(10)).map_err(|_| AppError::msg("음악 앱이 답하지 않아요."))?
}

unsafe fn run(action: &str, query: Option<&str>, kind: Option<&str>) -> Result<String, AppError> {
    let p = player()?;
    match action {
        "pause" => {
            let _: () = msg_send![p, pause];
            Ok("멈췄어요.".into())
        }
        "next" | "previous" => {
            if action == "next" {
                let _: () = msg_send![p, skipToNextItem];
            } else {
                let _: () = msg_send![p, skipToPreviousItem];
            }
            let _: () = msg_send![p, play];
            Ok(format!("지금 곡: {}", describe(&now(p).0)))
        }
        "now" => {
            let (song, playing) = now(p);
            Ok(match song {
                None => "재생 중인 곡이 없어요.".into(),
                Some(_) => format!("{}: {}", if playing { "재생 중" } else { "멈춤" }, describe(&song)),
            })
        }
        "search" | "play" if query.is_some() => {
            let text = query.unwrap_or_default();
            match queue_search(p, text, kind)? {
                Some(label) => {
                    let _: () = msg_send![p, setShuffleMode: 0isize]; // 찾은 것은 순서대로
                    let _: () = msg_send![p, play];
                    Ok(format!("{label}에서 '{text}'을(를) 찾아 틀었어요. 지금 곡: {}", describe(&now(p).0)))
                }
                None => Ok(format!("보관함에서 '{text}'을(를) 찾지 못했어요. Apple Music 카탈로그 검색은 지원하지 않아요.")),
            }
        }
        "play" => {
            // 대기열이 비어 있으면 보관함 전체를 섞어서
            let (song, _) = now(p);
            if song.is_none() {
                let all: *mut AnyObject = msg_send![class(c"MPMediaQuery")?, songsQuery];
                let items: *mut AnyObject = if all.is_null() { std::ptr::null_mut() } else { msg_send![all, items] };
                let count: usize = if items.is_null() { 0 } else { msg_send![items, count] };
                if count == 0 {
                    return Ok("보관함에 곡이 없어요.".into());
                }
                let _: () = msg_send![p, setQueueWithQuery: all];
                let _: () = msg_send![p, setShuffleMode: SHUFFLE_SONGS];
            }
            let _: () = msg_send![p, play];
            Ok(format!("재생해요. 지금 곡: {}", describe(&now(p).0)))
        }
        _ => Err(AppError::msg(format!("모르는 음악 동작: {action}"))),
    }
}

/// 지금 듣는 곡(맥의 ambient::Track 과 같은 모양 — 화면은 같은 걸로 읽는다)
#[derive(serde::Serialize)]
pub struct Track {
    pub title: String,
    pub artist: String,
}

/// 지금 듣는 곡(산책이 출발 전 상태를 가지고 나갈 때, ambient_track). 재생 중이 아니거나 권한이 없으면 None — 묻지 않는다
pub fn track(app: &tauri::AppHandle) -> Option<Track> {
    if !already_authorized() {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let got = unsafe { player().ok().map(|p| now(p)) };
        let _ = tx.send(got);
    })
    .ok()?;
    let (song, playing) = rx.recv_timeout(Duration::from_secs(5)).ok()??;
    let (title, artist) = song.filter(|(t, _)| playing && !t.is_empty())?;
    Some(Track { title, artist })
}
