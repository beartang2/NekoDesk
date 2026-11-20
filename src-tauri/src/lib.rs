use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

mod error;
mod db;
mod http;
// 폰(iOS)에는 파일·코드 실행·로컬 모델·캡처·빠른 질문 같은 데스크탑 도구가 없다 — `cfg(desktop)` 로 가른다(docs/neko-sync.md §6.1).
// 이름을 `fs` 로 두면 이 파일 곳곳의 `std::fs` 와 헷갈린다.
#[cfg(desktop)]
mod files;
#[cfg(desktop)]
mod airdrop;
#[cfg(desktop)]
mod exec;
#[cfg(desktop)]
mod llama;
#[cfg(desktop)]
mod skills;
#[cfg(desktop)]
mod quick;
// 창을 어느 모니터 가운데에 띄울지(마우스·메인 창 모니터). 폰엔 창이 하나라 데스크탑만
#[cfg(desktop)]
mod place;
#[cfg(target_os = "macos")]
mod capture;
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod location;
#[cfg(any(target_os = "macos", target_os = "ios"))]
mod map;
mod secrets;
mod claude;
#[cfg(desktop)]
mod security;
#[cfg(desktop)]
mod procs;
#[cfg(desktop)]
mod glow;
#[cfg(target_os = "macos")]
mod neko_screen;
#[cfg(target_os = "macos")]
mod neko_perch;
#[cfg(target_os = "macos")]
mod ambient;
// 폰의 음악 조작(도구 music.control)
#[cfg(target_os = "ios")]
mod music_ios;
// 폰의 화면 밝기·소리 크기(도구 device.level)
#[cfg(target_os = "ios")]
mod device_ios;
// 폰 설정의 권한 칸
#[cfg(target_os = "ios")]
mod perm_ios;
#[cfg(desktop)]
mod shelf;
// 기기 간 동기화(docs/neko-sync.md). 기본은 꺼져 있다
mod sync;
// 통합 테스트(tests/mcp_stdio.rs)가 실제 프로세스를 띄워 확인하므로 공개한다.
#[cfg(desktop)]
pub mod mcp;
pub use error::AppError;
// 모델은 db::models 소속. 예전에 lib.rs 에 있던 경로를 유지하려 재노출.
pub use db::models::{ConversationMessage, ExecHistoryItem, ScheduleEvent, Todo};

// ── Database state ────────────────────────────────────────────────────────────

pub struct DbState(pub Mutex<Connection>);

/// llama-server 자식 프로세스와 그 포트를 함께 보관한다.
/// 포트를 같이 들고 있어야, 자식 핸들이 stale/None 이어도(앱이 SIGKILL 로 죽어
/// 자식이 launchd 로 reparent 된 고아, 또는 포트 선점으로 spawn 이 조용히 실패한
/// 경우) 종료 시 포트 기준으로 확실히 죽일 수 있다.
#[cfg(desktop)]
#[derive(Default)]
pub struct LlamaProc {
    pub child: Option<std::process::Child>,
    pub port: Option<i32>,
}
#[cfg(desktop)]
pub struct LlamaServerState(pub Mutex<LlamaProc>);

/// 해당 TCP 포트를 LISTEN 중인 프로세스를 종료한다(고아 llama 청소용).
/// 추적 핸들이 없어도 동작하도록 lsof 로 PID 를 찾아 신호를 보낸다.
#[cfg(desktop)]
pub fn kill_port(port: i32) {
    let _ = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!(
            "pids=$(lsof -ti tcp:{p} -sTCP:LISTEN 2>/dev/null); \
             [ -n \"$pids\" ] && kill $pids 2>/dev/null; \
             sleep 0.3; \
             pids=$(lsof -ti tcp:{p} -sTCP:LISTEN 2>/dev/null); \
             [ -n \"$pids\" ] && kill -9 $pids 2>/dev/null; exit 0",
            p = port
        ))
        .output();
}

/// 지금 창 프레임과, 같은 가운데를 둔 목표 프레임(max_w×max_h, 화면의 90% 이내).
/// 화면 밖으로 나가면 안쪽으로 민다. main thread 전용.
#[cfg(target_os = "macos")]
unsafe fn boot_frames(
    ns_window: *mut objc2::runtime::AnyObject,
    max_w: f64,
    max_h: f64,
) -> Option<(objc2_foundation::NSRect, objc2_foundation::NSRect)> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let screen: *mut AnyObject = msg_send![ns_window, screen];
    if screen.is_null() {
        return None;
    }
    let area: NSRect = msg_send![screen, visibleFrame];
    let from: NSRect = msg_send![ns_window, frame];
    let w = max_w.min(area.size.width * 0.9);
    let h = max_h.min(area.size.height * 0.9);
    let cx = from.origin.x + from.size.width / 2.0;
    let cy = from.origin.y + from.size.height / 2.0;
    let x = (cx - w / 2.0).clamp(area.origin.x, area.origin.x + area.size.width - w);
    let y = (cy - h / 2.0).clamp(area.origin.y, area.origin.y + area.size.height - h);
    Some((from, NSRect::new(NSPoint::new(x, y), NSSize::new(w, h))))
}

/// 메인 창 최소 크기. 부팅 창(tauri.conf 360×300)이 작아야 하는 동안만 걸지 않는다.
#[cfg(desktop)]
const MAIN_MIN: (f64, f64) = (720.0, 520.0);
/// 부팅 화면이 이만큼 지나도 안 끝나면(창이 안 보여 프런트가 늦음·키우기가 멈춤) 최소 크기를 먼저 건다
#[cfg(desktop)]
const BOOT_GRACE: std::time::Duration = std::time::Duration::from_secs(8);
#[cfg(desktop)]
static BOOT_SETTLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 부팅이 끝났다(다 키웠든, 못 키웠든, 시간이 지났든): 메인 창에 최소 크기를 건다. 작으면 tao 가 최소 크기까지
/// 키우고, recenter 면 그 화면 가운데로 다시 둔다(작은 창이 오른쪽 위로만 커져 화면 밖으로 나가지 않게).
/// 창 크기를 읽지 않는다 — 읽기는 메인 스레드를 기다려, 메인이 막혔을 때 여기서도 멈춘다.
#[cfg(desktop)]
fn settle_main_window(win: &tauri::WebviewWindow, recenter: bool) {
    BOOT_SETTLED.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Err(e) = win.set_min_size(Some(tauri::LogicalSize::new(MAIN_MIN.0, MAIN_MIN.1))) {
        log::warn!("메인 창 최소 크기를 못 걸었어: {e}");
    }
    if recenter {
        crate::place::center(win, crate::place::Screen::Of(win), false);
    }
}

/// 부팅 창을 같은 가운데에서 본 크기로 키운다. 끝날 때까지 돌아오지 않는다.
///
/// NSWindow 의 animate:YES 는 시간을 못 고르고, 커지는 동안 웹뷰가 다시 그려지지 않아
/// 가운데 있던 고양이가 한쪽에 붙어 보였다. 프레임마다 직접 옮기면 웹뷰도 매번 다시
/// 깔려서 부팅 화면이 가운데를 지킨다.
#[cfg(target_os = "macos")]
fn grow_boot_window(window: &tauri::WebviewWindow, max_w: f64, max_h: f64) -> Result<(), AppError> {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const DURATION: Duration = Duration::from_millis(600);
    const FRAME: Duration = Duration::from_millis(16);

    // 메인 스레드가 이만큼 답하지 않으면 키우기를 그만둔다. 예전엔 끝없이 기다려, 그동안 최소 크기도 안 걸렸다
    const STALL: Duration = Duration::from_secs(2);

    let ns = window.ns_window()? as usize;
    let (tx, rx) = mpsc::channel();
    window.run_on_main_thread(move || {
        let _ = tx.send(unsafe { boot_frames(ns as *mut AnyObject, max_w, max_h) });
    })?;
    let frames = rx.recv_timeout(STALL).map_err(|_| AppError::msg("메인 스레드가 답하지 않아 부팅 창을 못 키웠어"))?;
    // 창이 놓인 화면을 못 찾으면(켜자마자 최소화·다른 앱으로 넘어감) 애니메이션 없이 그냥 키운다.
    // 예전엔 여기서 그대로 돌아가, 창이 부팅 크기(360×300)로 남아 최소 크기보다 작았다.
    let Some((from, to)) = frames else {
        log::warn!("부팅 창이 놓인 화면을 못 찾아 애니메이션 없이 키운다");
        window.set_size(tauri::LogicalSize::new(max_w, max_h))?;
        crate::place::center(window, crate::place::Screen::Of(window), false);
        return Ok(());
    };

    let start = Instant::now();
    loop {
        let t = (start.elapsed().as_secs_f64() / DURATION.as_secs_f64()).min(1.0);
        // ease-in-out cubic: 천천히 출발해 가운데서 빨라지고 천천히 멈춘다.
        let e = if t < 0.5 { 4.0 * t * t * t } else { 1.0 - (-2.0 * t + 2.0).powi(3) / 2.0 };
        let lerp = |a: f64, b: f64| a + (b - a) * e;
        let rect = NSRect::new(
            NSPoint::new(lerp(from.origin.x, to.origin.x), lerp(from.origin.y, to.origin.y)),
            NSSize::new(lerp(from.size.width, to.size.width), lerp(from.size.height, to.size.height)),
        );
        let (tx, rx) = mpsc::channel();
        window.run_on_main_thread(move || {
            let _: () = unsafe { msg_send![ns as *mut AnyObject, setFrame: rect, display: true] };
            let _ = tx.send(());
        })?;
        // 이 프레임이 실제로 그려진 뒤 다음으로 간다. 메인이 밀리면 쌓이지 않고 건너뛴다.
        rx.recv_timeout(STALL).map_err(|_| AppError::msg("메인 스레드가 답하지 않아 부팅 창 키우기를 멈췄어"))?;
        if t >= 1.0 {
            return Ok(());
        }
        std::thread::sleep(FRAME);
    }
}

/// NSHapticFeedbackManager.defaultPerformer 에 performFeedbackPattern:performanceTime: 를 보낸다.
/// 타입 래퍼(objc2-app-kit) 없이 런타임 클래스 조회로 호출해 의존성을 최소화한다.
/// 반드시 main thread 에서 호출할 것.
#[cfg(target_os = "macos")]
unsafe fn perform_haptic(pattern: isize) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    let Some(cls) = AnyClass::get(c"NSHapticFeedbackManager") else { return };
    let performer: *mut AnyObject = msg_send![cls, defaultPerformer];
    if performer.is_null() {
        return;
    }
    // performanceTime: 1 = .now
    let _: () = msg_send![performer, performFeedbackPattern: pattern, performanceTime: 1isize];
}

/// 뷰어 창에 띄울 것. 그림은 data URL, 글 파일은 text.
#[cfg(desktop)]
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerItem {
    name: String,
    data_url: Option<String>,
    text: Option<String>,
}

/// 지금 뷰어 창에 띄울 것. 창은 열릴 때 이걸 가져간다 — 막 만든 창은 이벤트를 듣기 전이라
/// 내용을 이벤트에 실어 보내면 놓친다. 이미 떠 있는 창엔 `viewer-open` 으로 다시 가져가라고 알린다.
#[cfg(desktop)]
#[derive(Default)]
pub struct ViewerState(Mutex<Option<ViewerItem>>);

/// dir 안에서 name 을 쓸 경로. 같은 이름이 있으면 "이름 (2).확장자" 처럼 번호를 붙인다.
/// name 은 화면에서 온 값이라 디렉터리 부분은 버리고 파일 이름만 쓴다.
#[cfg(desktop)]
fn unique_download_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let base = std::path::Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.trim().is_empty() && !n.starts_with('.'))
        .unwrap_or("nekodesk")
        .replace(':', "-");
    let first = dir.join(&base);
    if !first.exists() {
        return first;
    }
    let p = std::path::Path::new(&base);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("nekodesk");
    let ext = p.extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (2..)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|c| !c.exists())
        .expect("번호는 끝이 없다")
}

/// PNG 바이트를 클립보드에 그림으로 올린다. main thread 전용.
#[cfg(target_os = "macos")]
unsafe fn copy_png_to_pasteboard(png: &[u8]) -> bool {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};

    let (Some(data_cls), Some(pb_cls), Some(str_cls)) =
        (AnyClass::get(c"NSData"), AnyClass::get(c"NSPasteboard"), AnyClass::get(c"NSString"))
    else {
        return false;
    };
    let data: *mut AnyObject =
        msg_send![data_cls, dataWithBytes: png.as_ptr().cast::<std::ffi::c_void>(), length: png.len()];
    let kind: *mut AnyObject = msg_send![str_cls, stringWithUTF8String: c"public.png".as_ptr()];
    let pb: *mut AnyObject = msg_send![pb_cls, generalPasteboard];
    if data.is_null() || kind.is_null() || pb.is_null() {
        return false;
    }
    let _: isize = msg_send![pb, clearContents];
    let ok: Bool = msg_send![pb, setData: data, forType: kind];
    ok.as_bool()
}

/// 폰: 웹뷰가 화면 끝까지(상태 막대·홈 막대 밑까지) 그리게 한다. 기본값(자동)이면 iOS 18 의 WKWebView 가 안전 영역만큼
/// 문서를 줄여, 화면 아래 84pt 가 창 바탕색(검정)으로 비었다. 여백은 화면 쪽 CSS 가 env(safe-area-inset-*) 로 둔다.
/// 문서가 화면에 꽉 차니 튕기는 스크롤도 끈다.
#[cfg(target_os = "ios")]
fn ios_full_screen(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|webview| unsafe {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        let scroll: *mut AnyObject = msg_send![webview.inner() as *mut AnyObject, scrollView];
        if scroll.is_null() {
            return;
        }
        // UIScrollViewContentInsetAdjustmentNever = 2
        let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: 2isize];
        // 첫 그림 전·테마가 바뀌는 사이 웹뷰의 흰 바탕이 비치지 않게: 앱이 칠하기 전까지는 iOS 바탕색(어두우면 검정)
        if let Some(color) = objc2::runtime::AnyClass::get(c"UIColor") {
            let bg: *mut AnyObject = msg_send![color, systemBackgroundColor];
            ios_paint(webview.inner() as *mut AnyObject, scroll, bg);
        }
        let _: () = msg_send![scroll, setBounces: false];
        let _: () = msg_send![scroll, setScrollEnabled: false];
        ios_scroll::lock(scroll);
    });
}

/// 폰: 웹뷰·그 스크롤 뷰·창의 바탕을 칠한다(웹뷰는 불투명을 꺼야 바탕이 보인다). main thread 전용
#[cfg(target_os = "ios")]
unsafe fn ios_paint(view: *mut objc2::runtime::AnyObject, scroll: *mut objc2::runtime::AnyObject, color: *mut objc2::runtime::AnyObject) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    if view.is_null() || color.is_null() {
        return;
    }
    let _: () = msg_send![view, setOpaque: false];
    let _: () = msg_send![view, setBackgroundColor: color];
    if !scroll.is_null() {
        let _: () = msg_send![scroll, setBackgroundColor: color];
    }
    let window: *mut AnyObject = msg_send![view, window];
    if !window.is_null() {
        let _: () = msg_send![window, setBackgroundColor: color];
    }
}

/// 폰: 키보드가 올라올 때 WKWebView 가 입력 칸을 보이려고 문서를 통째로 밀어 올린다. 화면 쪽은 보이는 높이에 맞춰
/// 스스로 줄어드니(main.tsx 의 --vvh) 그 밀림은 쓸모없고, 둘이 겹쳐 화면이 한 번 내려갔다 올라왔다.
/// 스크롤 뷰가 움직일 때마다 처음 자리로 되돌린다(스크롤 끄기만으로는 코드로 미는 것을 못 막는다).
#[cfg(target_os = "ios")]
mod ios_scroll {
    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel, Encode, Encoding};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Point {
        x: f64,
        y: f64,
    }
    unsafe impl Encode for Point {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    extern "C-unwind" fn did_scroll(_this: &AnyObject, _cmd: Sel, scroll: *mut AnyObject) {
        unsafe {
            let at: Point = msg_send![scroll, contentOffset];
            if at.x != 0.0 || at.y != 0.0 {
                let _: () = msg_send![scroll, setContentOffset: Point { x: 0.0, y: 0.0 }];
            }
        }
    }

    /// main thread 전용. 델리게이트는 약한 참조라 만든 객체를 놓지 않는다(앱이 사는 동안 하나).
    pub unsafe fn lock(scroll: *mut AnyObject) {
        let cls = AnyClass::get(c"NekoScrollLock").or_else(|| {
            let mut builder = ClassBuilder::new(c"NekoScrollLock", AnyClass::get(c"NSObject")?)?;
            builder.add_method(sel!(scrollViewDidScroll:), did_scroll as extern "C-unwind" fn(_, _, _));
            Some(builder.register())
        });
        let Some(cls) = cls else { return };
        let delegate: *mut AnyObject = msg_send![cls, new];
        let _: () = msg_send![scroll, setDelegate: delegate];
    }
}

/// 폰: 클립보드의 글. 웹뷰의 붙여넣기(navigator.clipboard·길게 눌러 뜨는 메뉴)가 안 되는 일이 있어 시스템 클립보드를
/// 직접 읽는다 — iOS 가 "붙여넣기 허용"을 묻는다. main thread 전용.
#[cfg(target_os = "ios")]
fn ios_pasteboard_text() -> Option<String> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    unsafe {
        let pasteboard: *mut AnyObject = msg_send![AnyClass::get(c"UIPasteboard")?, generalPasteboard];
        if pasteboard.is_null() {
            return None;
        }
        let text: *mut AnyObject = msg_send![pasteboard, string];
        if text.is_null() {
            return None;
        }
        let utf8: *const std::ffi::c_char = msg_send![text, UTF8String];
        (!utf8.is_null()).then(|| std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned())
    }
}

// AVAudioSession 이 든 프레임워크
#[cfg(target_os = "ios")]
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {}

/// 폰의 '따라 하기': 다른 앱에서 소리가 나오는 중인가(음악·영상). 어느 앱·무슨 곡인지는 모른다 — iOS 가 안 알려 준다.
#[cfg(target_os = "ios")]
fn ios_other_audio_playing() -> bool {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    unsafe {
        let Some(cls) = AnyClass::get(c"AVAudioSession") else { return false };
        let session: *mut AnyObject = msg_send![cls, sharedInstance];
        if session.is_null() {
            return false;
        }
        let playing: Bool = msg_send![session, isOtherAudioPlaying];
        playing.as_bool()
    }
}

fn open_db(data_dir: PathBuf) -> Result<Connection, String> {
    // dev 빌드는 별도 디렉토리로 분리
    let dir = if cfg!(debug_assertions) {
        data_dir.parent()
            .unwrap_or(&data_dir)
            .join("nekodesk-dev")
    } else {
        data_dir
    };
    let path = dir.join("nekodesk.sqlite");
    std::fs::create_dir_all(&dir).ok();
    // 대화는 암호화해 둔다(db::cipher). 열쇠를 못 꺼내면 평문으로 열지 않고 멈춘다 —
    // 몰래 평문으로 돌아가면 암호화한 의미가 없고, 새 열쇠를 만들면 기존 DB 를 못 연다.
    // 실패 문구는 그대로 사용자에게 보인다(fatal_alert).
    let key = secrets::db_key().map_err(|e| {
        format!("키체인에서 대화 DB 열쇠를 못 꺼냈어. 다시 켜고 키체인 창이 뜨면 \"항상 허용\"을 눌러줘.\n\n({e})")
    })?;
    let conn = db::cipher::open(&path, &key).map_err(|e| {
        format!("대화 DB 를 열지 못했어. 디스크 공간이 부족하면 비우고 다시 켜줘. 대화 파일은 그대로 있어.\n\n({e})")
    })?;
    conn.execute_batch("PRAGMA journal_mode=WAL;").map_err(|e| e.to_string())?;
    Ok(conn)
}

/// 창이 뜨기 전에 멈출 때 이유를 보여 준다. 그냥 죽으면 사용자는 앱이 왜 안 뜨는지 모른다.
fn fatal_alert(message: &str) {
    let quoted = message.replace('\\', "\\\\").replace('"', "\\\"");
    let _ = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &format!("display alert \"NekoDesk 를 열 수 없어\" message \"{quoted}\" as critical")])
        .status();
}

// init_schema 는 db::init_schema 로 이동했다(DB 계층 소속).

// ── Shared types ──────────────────────────────────────────────────────────────
// Todo/ScheduleEvent/ConversationMessage/ExecHistoryItem 는 db::models 로 이동
// (상단에서 pub use 로 재노출). 아래는 아직 DB 계층이 아닌 순수 IPC 타입들.

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScrapResult {
    pub url: String,
    pub title: String,
    pub content: String,
    /// 페이지 대표 이미지 주소(최대 3개). 모델이 보고 싶을 때 web_image 로 받는다.
    #[serde(default)]
    pub images: Vec<String>,
}

#[cfg(desktop)]
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodeExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
    pub image_data_url: Option<String>,
}




// ── Commands module ───────────────────────────────────────────────────────────
// Tauri 2 requires commands to be in their own module when using generate_handler!
// with multiple commands to avoid macro namespace collisions.

mod commands {
    use super::*;
    use tauri::State;

    // todos 커맨드는 DB 잠금만 잡고 db::todos 순수 함수에 위임한다.
    // SQL·행 매핑은 db/todos.rs 에 있고 거기서 단위 테스트된다.

    #[tauri::command(async)]
    pub fn todo_list(db: State<'_, DbState>) -> Result<Vec<Todo>, AppError> {
        let conn = db.0.lock()?;
        crate::db::todos::list_open(&conn)
    }

    #[tauri::command(async)]
    pub fn todo_add(
        db: State<'_, DbState>,
        content: String,
        due_at: Option<String>,
    ) -> Result<Todo, AppError> {
        let conn = db.0.lock()?;
        crate::db::todos::add(&conn, &content, due_at.as_deref())
    }

    #[tauri::command(async)]
    pub fn todo_list_done(db: State<'_, DbState>) -> Result<Vec<Todo>, AppError> {
        let conn = db.0.lock()?;
        crate::db::todos::list_done(&conn)
    }

    #[tauri::command(async)]
    pub fn todo_complete(db: State<'_, DbState>, id: i64) -> Result<bool, AppError> {
        let conn = db.0.lock()?;
        crate::db::todos::complete(&conn, id)
    }

    #[tauri::command(async)]
    pub fn schedule_list(db: State<'_, DbState>, range: String) -> Result<Vec<ScheduleEvent>, AppError> {
        let conn = db.0.lock()?;
        crate::db::events::list(&conn, crate::db::events::Range::parse(&range))
    }

    #[tauri::command(async)]
    pub fn schedule_add(
        db: State<'_, DbState>,
        title: String,
        start_at: String,
        end_at: Option<String>,
    ) -> Result<ScheduleEvent, AppError> {
        let conn = db.0.lock()?;
        crate::db::events::add(&conn, &title, &start_at, end_at.as_deref())
    }

    #[tauri::command(async)]
    pub fn schedule_delete(db: State<'_, DbState>, ids: Vec<i64>) -> Result<usize, AppError> {
        let conn = db.0.lock()?;
        crate::db::events::delete(&conn, &ids)
    }

    /// 로컬 코드 실행. 실제 구현과 하드 게이트는 `crate::exec` 안에 있다.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn code_exec(
        code: String,
        language: Option<String>,
        work_dir: Option<String>,
        approved: bool,
    ) -> Result<CodeExecResult, AppError> {
        crate::exec::run(&code, language.as_deref(), work_dir.as_deref(), approved)
    }

    #[tauri::command]
    pub async fn web_search(query: String) -> Result<Vec<SearchResult>, AppError> {
        // brave 키는 키체인에 있다. 없거나 못 꺼내면 DuckDuckGo 만 쓴다.
        let brave_key = crate::secrets::get("brave_search_key").ok().flatten();
        crate::http::search::run(&query, brave_key).await
    }

    /// 설명대로 그림을 그려 data URL 로 돌려준다. 토큰·키는 키체인에서, 계정 ID 는 DB 에서 꺼낸다.
    #[tauri::command]
    pub async fn image_generate(
        db: State<'_, DbState>,
        provider: String,
        model: String,
        prompt: String,
    ) -> Result<String, AppError> {
        let cf_account = {
            let conn = db.0.lock()?;
            crate::db::settings::get(&conn, "cf_account_id")?.unwrap_or_default()
        };
        let secret = |k: &str| crate::secrets::get(k).map(Option::unwrap_or_default);
        let (cf_token, google_key) = (secret("cf_api_token")?, secret("google_api_key")?);
        match provider.as_str() {
            "cloudflare" => crate::http::image::cloudflare(&cf_account, &cf_token, &model, &prompt).await,
            "google" => crate::http::image::google(&google_key, &model, &prompt).await,
            _ => Err(AppError::msg("이미지 생성이 꺼져 있어. 설정 > 연동에서 켜줘.")),
        }
    }

    #[tauri::command]
    pub async fn web_scrape(url: String) -> Result<ScrapResult, AppError> {
        crate::http::scrape::run(&url).await
    }

    #[tauri::command]
    pub async fn web_image(url: String) -> Result<String, AppError> {
        crate::http::scrape::image(&url).await
    }

    /// image.trace 의 선 경로를 출력 폴더에 두고 파일 이름을 돌려준다.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn trace_save(name: String, json: String) -> Result<String, AppError> {
        crate::exec::save_trace(&name, &json)
    }

    #[tauri::command(async)]
    pub fn settings_set(db: State<'_, DbState>, key: String, value: String) -> Result<(), AppError> {
        // 비밀은 표에 안 적는다 — secret_set 으로 키체인에.
        if crate::secrets::is_secret(&key) {
            return Err(AppError::msg("비밀은 secret_set 으로 저장해."));
        }
        let conn = db.0.lock()?;
        crate::db::settings::set(&conn, &key, &value)?;
        crate::sync::run::kick();
        Ok(())
    }

    #[tauri::command(async)]
    pub fn settings_get(db: State<'_, DbState>, key: String) -> Result<Option<String>, AppError> {
        if crate::secrets::is_secret(&key) {
            return Err(AppError::msg("비밀은 화면에 돌려주지 않아."));
        }
        let conn = db.0.lock()?;
        crate::db::settings::get(&conn, &key)
    }

    /// API 키를 키체인에 넣는다. 빈 값이면 지운다.
    #[tauri::command(async)]
    pub fn secret_set(key: String, value: String) -> Result<(), AppError> {
        crate::secrets::set(&key, &value)
    }

    /// 저장된 키가 있는가. 값은 돌려주지 않는다 — 화면엔 "저장됨" 만 보인다.
    #[tauri::command(async)]
    pub fn secret_has(key: String) -> Result<bool, AppError> {
        Ok(crate::secrets::get(&key)?.is_some_and(|v| !v.is_empty()))
    }

    /// dev 빌드의 복사 버튼용. 빌드한 앱에선 거절한다 — 화면에서 키를 꺼낼 길을 남기지 않는다.
    #[tauri::command(async)]
    pub fn secret_dev_get(key: String) -> Result<Option<String>, AppError> {
        if !cfg!(debug_assertions) {
            return Err(AppError::msg("dev 빌드에서만 꺼낼 수 있어."));
        }
        crate::secrets::get(&key)
    }

    #[tauri::command(async)]
    pub fn conversation_save(
        db: State<'_, DbState>,
        session_id: String,
        role: String,
        content: String,
        attachments: Option<String>,
        meta: Option<String>,
    ) -> Result<(), AppError> {
        let conn = db.0.lock()?;
        crate::db::conversations::save(
            &conn,
            &session_id,
            &role,
            &content,
            attachments.as_deref(),
            meta.as_deref(),
        )?;
        crate::sync::run::kick();
        Ok(())
    }

    #[tauri::command(async)]
    pub fn conversation_load(
        db: State<'_, DbState>,
        session_id: String,
    ) -> Result<Vec<ConversationMessage>, AppError> {
        let conn = db.0.lock()?;
        crate::db::conversations::load(&conn, &session_id)
    }

    #[tauri::command(async)]
    pub fn conversation_delete(db: State<'_, DbState>, session_id: String) -> Result<(), AppError> {
        let conn = db.0.lock()?;
        crate::db::conversations::delete(&conn, &session_id)
    }

    /// 마지막으로 쓴 지 days 일 지난 세션의 대화를 지운다(keep 은 빼고). 지운 세션 id.
    /// 동기화가 켜져 있으면 이번 실행에서 한 번 맞춘 뒤에만 지운다 — 다른 기기가 어제 쓴 세션을 모르고
    /// 지우지 않게(docs/neko-sync.md §2.5). 그 전엔 빈 목록이고, 화면은 첫 sync-changed 에서 다시 부른다.
    #[tauri::command(async)]
    pub fn conversation_prune(db: State<'_, DbState>, days: u32, keep: Vec<String>) -> Result<Vec<String>, AppError> {
        let conn = db.0.lock()?;
        if crate::sync::run::prune_blocked(&conn) {
            return Ok(Vec::new());
        }
        let tx = conn.unchecked_transaction()?;
        let gone = crate::db::conversations::prune(&tx, days, &keep)?;
        crate::sync::mark_pruned(&tx, &gone, days)?;
        tx.commit()?;
        Ok(gone)
    }

    /// 부팅 화면이 끝나면 프런트가 부른다. 작게 뜬 창이 같은 가운데에서 본 크기로
    /// 부드럽게 커지고, 다 커진 뒤에 돌아온다 — 프런트는 그때 부팅 화면을 걷는다.
    #[cfg(desktop)]
    #[tauri::command]
    pub async fn window_boot_done(window: tauri::WebviewWindow) -> Result<(), AppError> {
        // 처음엔 1366×768 이었는데 커지고 나면 크게 느껴졌다. 한 단계 줄였다.
        const W: f64 = 1000.0;
        const H: f64 = 650.0;
        #[cfg(target_os = "macos")]
        let grown = {
            let win = window.clone();
            tauri::async_runtime::spawn_blocking(move || grow_boot_window(&win, W, H))
                .await
                .map_err(|e| AppError::msg(e.to_string()))
                .and_then(|r| r)
        };
        #[cfg(not(target_os = "macos"))]
        let grown = window.set_size(tauri::LogicalSize::new(W, H)).and_then(|_| window.center()).map_err(AppError::from);
        // 부팅 창은 작아야 해서 최소 크기는 다 커진 뒤에 건다. 키우다 실패해도 건다 — 작게 남았으면
        // 최소 크기까지 커져 그 화면 가운데로. 프런트가 아예 못 부르면 setup 의 BOOT_GRACE 가 건다.
        if let Err(e) = &grown {
            log::warn!("부팅 창 키우기 실패: {e}");
        }
        crate::settle_main_window(&window, grown.is_err());
        grown
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn shelf_list(app: tauri::AppHandle) -> Result<Vec<crate::shelf::ShelfItem>, AppError> {
        crate::shelf::list(&crate::shelf::dir(&app)?)
    }

    /// 보관함에 넣는다. 몸통은 파일 바이트 그대로, 이름은 x-name 헤더(encodeURIComponent).
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn shelf_add(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<crate::shelf::ShelfItem, AppError> {
        let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
            return Err(AppError::msg("파일 내용이 안 왔어."));
        };
        let name = request
            .headers()
            .get("x-name")
            .and_then(|v| v.to_str().ok())
            .map(crate::shelf::percent_decode)
            .unwrap_or_default();
        let item = crate::shelf::add(&crate::shelf::dir(&app)?, &name, bytes)?;
        shelf_changed(&app);
        Ok(item)
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn shelf_remove(app: tauri::AppHandle, name: String) -> Result<(), AppError> {
        crate::shelf::remove(&crate::shelf::dir(&app)?, &name)?;
        shelf_changed(&app);
        Ok(())
    }

    /// 마당 아치에서 끌어내 놓았다: 보관함에서 꺼낸다(목록에서 바로 빼고 파일은 조금 뒤에 지운다).
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn shelf_take(app: tauri::AppHandle, name: String) -> Result<(), AppError> {
        crate::shelf::take(&crate::shelf::dir(&app)?, &name)?;
        shelf_changed(&app);
        Ok(())
    }

    /// 보관함 안 파일·폴더의 macOS 아이콘(64px PNG data URL).
    #[cfg(target_os = "macos")]
    #[tauri::command(async)]
    pub fn file_icon(app: tauri::AppHandle, path: String) -> Result<String, AppError> {
        crate::shelf::icon(&app, &crate::shelf::dir(&app)?, &path)
    }

    /// 보관함이 바뀌었다 — 앱 보관함 목록과 마당 네코 입(최근 3개)이 다시 읽는다.
    #[cfg(desktop)]
    pub(crate) fn shelf_changed(app: &tauri::AppHandle) {
        use tauri::Emitter;
        let _ = app.emit("shelf-changed", ());
    }

    #[tauri::command]
    pub async fn weather_get(location: String) -> Result<String, AppError> {
        crate::http::weather::run(&location).await
    }

    /// 위치 권한 상태(묻지 않는다): "allowed"·"denied"·"ask"
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[tauri::command(async)]
    pub fn location_permission() -> &'static str {
        crate::location::permission()
    }

    /// 위치 서비스로 지금 자리를 찾는다. `"현재 위치 (37.5000,127.0364)"` 꼴.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[tauri::command]
    pub async fn location_current(app: tauri::AppHandle) -> Result<String, AppError> {
        crate::location::current(&app).await
    }

    #[tauri::command]
    pub async fn weather_now(location: String) -> Result<crate::http::weather::WeatherNow, AppError> {
        crate::http::weather::now(&location).await
    }

    /// 트랙패드에 촉각 피드백을 준다. 고양이를 쓰다듬을 때 실제로 트랙패드가 떨린다.
    ///
    /// pattern: 0=generic, 1=alignment(또렷한 탁), 2=levelChange.
    /// NSHapticFeedbackManager 는 AppKit 이라 main thread 에서 호출한다.
    #[tauri::command(async)]
    pub fn haptic_feedback(app: tauri::AppHandle, pattern: Option<i64>) -> Result<(), AppError> {
        #[cfg(target_os = "macos")]
        {
            let p = pattern.unwrap_or(1) as isize;
            app.run_on_main_thread(move || unsafe { perform_haptic(p) })
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, pattern);
        }
        Ok(())
    }

    /// 캡처 막 창이 처음에 받아 간다 — 자기 모니터와, 강조할 수 있는 창들.
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn capture_targets(
        window: tauri::WebviewWindow,
        state: State<'_, crate::capture::CaptureState>,
    ) -> Result<crate::capture::Targets, AppError> {
        crate::capture::targets_for(window.label(), &state)
    }

    /// 막 창에서 고른 것(창 또는 영역). 그만두면 null.
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn capture_pick(
        pick: Option<crate::capture::Pick>,
        state: State<'_, crate::capture::CaptureState>,
    ) -> Result<(), AppError> {
        crate::capture::pick(&state, pick)
    }

    /// 빠른 질문 창의 📷. 화면 일부를 잘라 data URL 로, 그만두면 None.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn quick_capture(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
        crate::quick::capture(&app)
    }

    /// 빠른 질문 창 높이. 고른 글을 풀어 본 칸이 붙을 때 늘린다.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn quick_fit(app: tauri::AppHandle, height: f64) -> Result<(), AppError> {
        crate::quick::fit(&app, height.clamp(100.0, 600.0))
    }

    /// macOS URL 스킴 또는 앱을 엽니다 (권한 설정 페이지 열기 등에 사용).
    /// 내부 신뢰 호출 전용(x-apple.systempreferences: 등). 미신뢰 링크는 open_external_url.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn open_url(url: String) -> Result<(), AppError> {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 채팅 마크다운의 링크를 기본 브라우저로 연다.
    /// 링크 출처가 LLM·웹 스크랩(미신뢰)이라 http/https 스킴만 허용한다.
    /// file://·x-apple.systempreferences:·app 스킴 등으로 `open` 이 로컬 리소스를
    /// 실행하는 것을 막는다. arg 는 데이터로 전달돼 셸 해석은 없음.
    /// 폰은 사파리 등 기본 앱으로(UIApplication openURL).
    #[cfg(any(desktop, target_os = "ios"))]
    #[tauri::command(async)]
    pub fn open_external_url(#[allow(unused)] app: tauri::AppHandle, url: String) -> Result<(), AppError> {
        let lower = url.trim_start().to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err("http/https 링크만 열 수 있습니다".into());
        }
        #[cfg(target_os = "ios")]
        let opened = crate::perm_ios::open_url(&app, url.trim_start());
        #[cfg(desktop)]
        let opened = std::process::Command::new("open")
            .arg("--")
            .arg(&url)
            .spawn()
            .map(drop)
            .map_err(|e| AppError::msg(e.to_string()));
        opened
    }

    // ── 그림판 저장 ───────────────────────────────────────────────────────────

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn save_canvas_image(data_url: String) -> Result<String, AppError> {
        use base64::Engine;
        let b64 = data_url.split(',').nth(1).ok_or("invalid data URL")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| e.to_string())?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let path = dirs::desktop_dir()
            .ok_or("데스크탑 경로를 찾을 수 없습니다")?
            .join(format!("nekodesk_{}.png", now));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    }

    // ── 뷰어 ──────────────────────────────────────────────────────────────────

    /// 그림·파일을 뷰어 창에 띄운다. 창은 하나 — 떠 있으면 내용만 바꾸고 앞으로 가져온다.
    /// 창 만들기를 main thread 에서 기다리면 굳을 수 있어 async 로 둔다.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn viewer_open(
        app: tauri::AppHandle,
        state: State<'_, crate::ViewerState>,
        item: crate::ViewerItem,
    ) -> Result<(), AppError> {
        use tauri::Emitter;
        let title = item.name.clone();
        let is_image = item.data_url.is_some();
        *state.0.lock()? = Some(item);
        if let Some(win) = app.get_webview_window("viewer") {
            win.set_title(&title)?;
            let _ = app.emit_to("viewer", "viewer-open", ());
            let _ = win.unminimize();
            bring_popup(&app, &win)?;
            return Ok(());
        }
        let (w, h) = if is_image { (960.0, 680.0) } else { (780.0, 600.0) };
        let win = tauri::WebviewWindowBuilder::new(&app, "viewer", tauri::WebviewUrl::App("index.html".into()))
            .title(&title)
            .inner_size(w, h)
            .min_inner_size(360.0, 260.0)
            .visible(false)
            .build()?;
        bring_popup(&app, &win)?;
        Ok(())
    }

    /// 설정에서 따로 띄우는 창(네코 꾸미기·선물함). 떠 있으면 앞으로 가져온다. 내용은 같은 번들이 창 이름을 보고 그린다(main.tsx).
    #[cfg(desktop)]
    #[tauri::command]
    pub fn panel_open(app: tauri::AppHandle, kind: String) -> Result<(), AppError> {
        let (title, w, h, min_w, min_h) = match kind.as_str() {
            "neko-customize" => ("네코 꾸미기", 780.0, 720.0, 520.0, 520.0),
            "neko-gifts" => ("선물함", 600.0, 640.0, 380.0, 360.0),
            _ => return Err(format!("모르는 창: {kind}").into()),
        };
        if let Some(win) = app.get_webview_window(&kind) {
            let _ = win.unminimize();
            return bring_popup(&app, &win);
        }
        let win = tauri::WebviewWindowBuilder::new(&app, &kind, tauri::WebviewUrl::App("index.html".into()))
            .title(title)
            .inner_size(w, h)
            .min_inner_size(min_w, min_h)
            .visible(false)
            .build()?;
        bring_popup(&app, &win)
    }

    /// 팝업을 메인 창이 있는 모니터에 보인다. 이미 그 모니터에 있으면 사용자가 둔 자리 그대로,
    /// 다른 모니터(또는 처음 띄워 주 모니터 자리)면 그 모니터 가운데로.
    #[cfg(desktop)]
    fn bring_popup(app: &tauri::AppHandle, win: &tauri::WebviewWindow) -> Result<(), AppError> {
        let main = app.get_webview_window("main");
        let on = main.as_ref().map_or(crate::place::Screen::Cursor, crate::place::Screen::Of);
        crate::place::center(win, on, true);
        win.show()?;
        win.set_focus()?;
        Ok(())
    }

    /// 뷰어 창이 띄울 것을 가져간다.
    #[cfg(desktop)]
    #[tauri::command]
    pub fn viewer_item(state: State<'_, crate::ViewerState>) -> Result<Option<crate::ViewerItem>, AppError> {
        Ok(state.0.lock()?.clone())
    }

    /// 뷰어의 "다운로드". 그림은 data URL, 글은 text 로 받아 ~/Downloads 에 쓰고 경로를 돌려준다.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn save_download(name: String, data_url: Option<String>, text: Option<String>) -> Result<String, AppError> {
        use base64::Engine;
        let bytes = match (data_url, text) {
            (Some(url), _) => {
                let b64 = url.split(',').nth(1).ok_or("invalid data URL")?;
                base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?
            }
            (None, Some(t)) => t.into_bytes(),
            (None, None) => return Err("저장할 내용이 없어.".into()),
        };
        let dir = dirs::download_dir().ok_or("다운로드 폴더를 찾을 수 없어.")?;
        let path = crate::unique_download_path(&dir, &name);
        std::fs::write(&path, bytes)?;
        Ok(path.to_string_lossy().into_owned())
    }

    /// Finder 에서 그 파일을 골라 보여준다.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn reveal_in_finder(path: String) -> Result<(), AppError> {
        std::process::Command::new("open").arg("-R").arg(&path).spawn()?;
        Ok(())
    }

    /// 뷰어의 그림 "복사". 프런트가 PNG 로 바꿔 보낸다 — 다른 앱에 붙일 때 가장 잘 받는 형식.
    /// NSPasteboard 는 AppKit 이라 동기 커맨드(main thread)로 둔다.
    #[cfg(desktop)]
    #[tauri::command]
    pub fn copy_image(data_url: String) -> Result<(), AppError> {
        use base64::Engine;
        let b64 = data_url.split(',').nth(1).ok_or("invalid data URL")?;
        let png = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        if !unsafe { crate::copy_png_to_pasteboard(&png) } {
            return Err("클립보드에 못 넣었어.".into());
        }
        #[cfg(not(target_os = "macos"))]
        let _ = png;
        Ok(())
    }

    // ── 파일 (files 모듈 위임) ────────────────────────────────────────────────
    // 정책 판정과 실제 I/O 는 crate::files 안에 있고 거기서 단위 테스트된다.
    // 여기서는 승인된 쓰기 루트를 DB 에서 꺼내 넘겨주는 역할만 한다.

    /// 사용자가 "항상 허용" 한 쓰기 루트 목록(JSON 배열 문자열).
    #[cfg(desktop)]
    fn write_roots(db: &State<'_, DbState>) -> Result<String, AppError> {
        let conn = db.0.lock()?;
        Ok(crate::db::settings::get(&conn, "fs_write_roots")?.unwrap_or_else(|| "[]".to_string()))
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn fs_read(
        path: String,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Result<crate::files::FsReadResult, AppError> {
        crate::files::read(&path, offset, limit)
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn fs_write(
        db: State<'_, DbState>,
        path: String,
        content: String,
        approved: bool,
    ) -> Result<crate::files::FsWriteResult, AppError> {
        let roots = write_roots(&db)?;
        crate::files::write(&path, &content, &roots, approved)
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn fs_edit(
        db: State<'_, DbState>,
        path: String,
        old_string: String,
        new_string: String,
        replace_all: Option<bool>,
        approved: bool,
    ) -> Result<crate::files::FsEditResult, AppError> {
        let roots = write_roots(&db)?;
        crate::files::edit(
            &path,
            &old_string,
            &new_string,
            replace_all.unwrap_or(false),
            &roots,
            approved,
        )
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn fs_list(path: String) -> Result<Vec<crate::files::FsEntry>, AppError> {
        crate::files::list(&path)
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn fs_glob(pattern: String, base: Option<String>) -> Result<Vec<String>, AppError> {
        crate::files::glob(&pattern, base.as_deref())
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn fs_grep(
        pattern: String,
        base: Option<String>,
        glob: Option<String>,
        max_results: Option<usize>,
    ) -> Result<Vec<crate::files::FsGrepHit>, AppError> {
        crate::files::grep(&pattern, base.as_deref(), glob.as_deref(), max_results)
    }

    /// 실제로 건드리기 전에 정책만 물어본다. 프런트엔드가 확인 창을 띄울지 판단한다.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn fs_check(
        db: State<'_, DbState>,
        path: String,
        write: bool,
    ) -> Result<crate::files::FsDecision, AppError> {
        let roots = write_roots(&db)?;
        crate::files::check(&path, write, &roots)
    }

    // ── MCP stdio (mcp 모듈 위임) ─────────────────────────────────────────────
    // HTTP(SSE) 서버는 프런트엔드가 직접 붙는다. stdio 는 로컬 프로세스를 띄워야
    // 하므로 여기를 거친다. 프로토콜 자체는 crate::mcp 안에서 단위 테스트된다.

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn mcp_stdio_start(
        state: State<'_, crate::mcp::McpRegistry>,
        id: String,
        command: String,
        env: Option<std::collections::HashMap<String, String>>,
    ) -> Result<crate::mcp::McpStartResult, AppError> {
        crate::mcp::start(&state, &id, &command, &env.unwrap_or_default())
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn mcp_stdio_rpc(
        state: State<'_, crate::mcp::McpRegistry>,
        id: String,
        method: String,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, AppError> {
        crate::mcp::rpc(&state, &id, &method, params)
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn mcp_stdio_stop(
        state: State<'_, crate::mcp::McpRegistry>,
        id: String,
    ) -> Result<(), AppError> {
        crate::mcp::stop(&state, &id)
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn mcp_stdio_is_running(
        state: State<'_, crate::mcp::McpRegistry>,
        id: String,
    ) -> Result<bool, AppError> {
        crate::mcp::is_running(&state, &id)
    }

    // ── 기억 (db::memories 위임) ───────────────────────────────────────────────
    // 세션을 넘어 남는다. 검색어 추출·랭킹은 db 모듈 안에서 단위 테스트된다.

    #[tauri::command(async)]
    pub fn memory_save(
        db: State<'_, DbState>,
        kind: Option<String>,
        content: String,
    ) -> Result<crate::db::memories::Memory, AppError> {
        if content.trim().is_empty() {
            return Err(AppError::msg("저장할 내용이 비어 있어"));
        }
        let conn = db.0.lock()?;
        crate::db::memories::save(&conn, kind.as_deref().unwrap_or("fact"), &content)
    }

    /// 자유 문장으로 검색한다. 검색어 분해는 백엔드가 한다 — 조사 처리 규칙을
    /// 프런트엔드와 나눠 가지면 둘이 어긋난다.
    #[tauri::command(async)]
    pub fn memory_search(
        db: State<'_, DbState>,
        query: String,
        limit: Option<usize>,
    ) -> Result<Vec<crate::db::memories::Memory>, AppError> {
        let terms = crate::db::terms::extract(&query);
        let conn = db.0.lock()?;
        let found = crate::db::memories::search(
            &conn,
            &terms,
            limit.unwrap_or(crate::db::memories::RECALL_LIMIT),
        )?;
        // 떠올린 것에 표시해 다음 검색에서 우선순위를 올린다.
        let ids: Vec<i64> = found.iter().map(|m| m.id).collect();
        crate::db::memories::mark_used(&conn, &ids)?;
        Ok(found)
    }

    #[tauri::command(async)]
    pub fn memory_list(db: State<'_, DbState>) -> Result<Vec<crate::db::memories::Memory>, AppError> {
        let conn = db.0.lock()?;
        crate::db::memories::list(&conn)
    }

    #[tauri::command(async)]
    pub fn memory_delete(db: State<'_, DbState>, id: i64) -> Result<bool, AppError> {
        let conn = db.0.lock()?;
        crate::db::memories::delete(&conn, id)
    }

    // ── 보안 점검 (security 모듈 위임) ────────────────────────────────────────

    /// 읽기 전용(`remember` 면 자동 실행 목록만 기억). 명령은 DB 잠금 밖에서 돌리고, 목록을 견줄 때만 잠근다.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn security_check(db: State<'_, DbState>, remember: bool) -> Result<crate::security::Report, AppError> {
        let checks = crate::security::checks();
        let autostart = crate::security::autostart();
        let conn = db.0.lock()?;
        let new_autostart = crate::security::new_autostart(&conn, &autostart, remember)?;
        Ok(crate::security::Report { checks, autostart, new_autostart })
    }

    /// 일정 알림 때 커서가 있는 화면 테두리를 빛낸다.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn glow_alert(app: tauri::AppHandle) -> Result<(), AppError> {
        crate::glow::alert(&app)
    }

    /// 빛 창이 띄울 자리를 가져간다. 한 번 가져가면 비운다.
    #[cfg(desktop)]
    #[tauri::command]
    pub fn glow_take() -> Option<crate::glow::GlowAt> {
        crate::glow::take()
    }

    /// 네코 '모니터 화면' 자리 켜고 끄기. 메인 창이 자리·산책·'항상 위에 두기'가 바뀔 때 부른다.
    #[cfg(target_os = "macos")]
    #[tauri::command(async)]
    pub fn neko_screen_show(app: tauri::AppHandle, on: bool, on_top: bool) -> Result<(), AppError> {
        crate::neko_screen::show(&app, on, on_top)
    }

    /// 화면 창: 커서가 고양이·마당 선물 위다(위에 있는 동안 계속 알린다). `cat` 은 고양이 위일 때.
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn neko_screen_catch(on: bool, cat: Option<bool>) -> Result<(), AppError> {
        crate::neko_screen::set_catch(on, cat.unwrap_or(false))
    }

    /// 화면 창: 아치에서 파일을 끌어내기 시작했다 — 버튼을 놓을 때까지 클릭을 흘린다(아래 Finder 에 놓이게).
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn neko_screen_drag_out() -> Result<(), AppError> {
        crate::neko_screen::set_drag_out()
    }

    /// 마당 선물 창: 그린 선물 칸(창 좌표 x, y, w, h). 커서가 이 안일 때만 그 창이 클릭을 받는다.
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn neko_decor_boxes(window: tauri::Window, boxes: Vec<[f64; 4]>) -> Result<(), AppError> {
        crate::neko_screen::set_boxes(window.label(), boxes)
    }

    /// 화면 창: 고양이 자리(창 좌표, 크게 움직였을 때만)와 올라탄 창 번호(캣타워 — 그 창만 30Hz 로 따라 읽는다).
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn neko_screen_cat(at: Option<[f64; 2]>, perch: Option<u32>) -> Result<(), AppError> {
        crate::neko_screen::set_cat(at, perch)
    }

    /// 개발 빌드 '개발자' 칸: 캣타워 표시 켜기·끄기(배포 빌드에선 늘 꺼짐).
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn neko_screen_perch_debug(app: tauri::AppHandle, on: bool) -> Result<(), AppError> {
        crate::neko_screen::set_perch_debug(&app, on)
    }

    /// 화면 창이 처음 뜰 때: 지금 발판·벽(캣타워). 아직 없으면 null.
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn neko_screen_perches() -> Option<crate::neko_perch::Perches> {
        crate::neko_screen::perches_now()
    }

    /// 화면 창: 잡힌 고양이 목덜미 자리(창 좌표, 놓으면 null). 끌어 건너갈 때 창은 고양이가 다른 모니터에 들어갈 때 옮긴다.
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn neko_screen_held(at: Option<[f64; 2]>) -> Result<(), AppError> {
        crate::neko_screen::set_held(at)
    }

    /// 화면 창 고양이 메뉴 '숨기기': 마당을 숨긴다. 이 앱이 맨 앞으로 오면 다시 보인다.
    #[cfg(target_os = "macos")]
    #[tauri::command(async)]
    pub fn neko_screen_hide(app: tauri::AppHandle) -> Result<(), AppError> {
        crate::neko_screen::hide(&app)
    }

    /// 메인 창: 모니터 목록·고양이가 있는 모니터·선물 창 라벨(마당 선물을 모니터마다 나눈다). 화면 창이 없으면 null.
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn neko_screen_screens() -> Option<crate::neko_screen::Screens> {
        crate::neko_screen::screens()
    }

    /// 화면 창: 판 크기와 바닥. 아직 모르면 null.
    #[cfg(target_os = "macos")]
    #[tauri::command]
    pub fn neko_screen_layout() -> Option<crate::neko_screen::Layout> {
        crate::neko_screen::layout()
    }

    /// 다른 앱 따라 하기: 맨 앞 앱과 마지막으로 키를 누른 뒤 지난 초.
    #[cfg(target_os = "macos")]
    #[tauri::command(async)]
    pub fn ambient_probe(app: tauri::AppHandle) -> Result<crate::ambient::Probe, AppError> {
        crate::ambient::probe(&app)
    }

    /// 다른 앱 따라 하기: 켜져 있는 음악 앱이 재생 중인가(처음 한 번 '자동화' 권한 창).
    #[cfg(target_os = "macos")]
    #[tauri::command(async)]
    pub fn ambient_music(app: tauri::AppHandle) -> Result<bool, AppError> {
        crate::ambient::music(&app)
    }

    /// 폰: 가로로 돌려 네코만 볼 때 홈 막대(화면 아래 가운데 줄)를 숨긴다. iOS 는 손을 대지 않는 동안만 숨겨 준다 —
    /// 화면을 건드리면 잠깐 다시 나온다. tao 의 뷰 컨트롤러가 이 설정을 받는다.
    #[cfg(target_os = "ios")]
    #[tauri::command]
    pub fn phone_standby(window: tauri::WebviewWindow, on: bool) -> Result<(), AppError> {
        window.with_webview(move |webview| unsafe {
            use objc2::msg_send;
            use objc2::runtime::{AnyObject, Bool};
            let controller = webview.view_controller() as *mut AnyObject;
            if !controller.is_null() {
                let _: () = msg_send![controller, setPrefersHomeIndicatorAutoHidden: Bool::new(on)];
            }
        })?;
        Ok(())
    }

    /// 폰: 테마를 창에 건다(style 0 시스템·1 밝게·2 어둡게, UIWindow overrideUserInterfaceStyle) — 상태 막대 글자·키보드·
    /// 웹뷰의 prefers-color-scheme 가 따라온다. 웹뷰·창 바탕은 앱 바탕색 bg(0–1 RGB)로. iOS 가 어두운지(창에 건 값과 상관없이)를
    /// 돌려준다. 동기 커맨드라 main thread 에서 돈다.
    #[cfg(target_os = "ios")]
    #[tauri::command]
    pub fn phone_theme(window: tauri::WebviewWindow, style: isize, bg: [f64; 3]) -> Result<bool, AppError> {
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject};
        window.with_webview(move |webview| unsafe {
            let view = webview.inner() as *mut AnyObject;
            let Some(color_cls) = AnyClass::get(c"UIColor") else { return };
            let color: *mut AnyObject = msg_send![color_cls, colorWithRed: bg[0], green: bg[1], blue: bg[2], alpha: 1.0f64];
            let scroll: *mut AnyObject = msg_send![view, scrollView];
            crate::ios_paint(view, scroll, color);
            let win: *mut AnyObject = msg_send![view, window];
            if !win.is_null() {
                let _: () = msg_send![win, setOverrideUserInterfaceStyle: style];
            }
            let controller = webview.view_controller() as *mut AnyObject;
            if !controller.is_null() {
                let _: () = msg_send![controller, setNeedsStatusBarAppearanceUpdate];
            }
        })?;
        // UIUserInterfaceStyle: 2 = 어둡게. 화면(UIScreen)의 값은 창에 건 값을 타지 않는다
        let dark = unsafe {
            AnyClass::get(c"UIScreen").is_some_and(|cls| {
                let screen: *mut AnyObject = msg_send![cls, mainScreen];
                if screen.is_null() {
                    return false;
                }
                let traits: *mut AnyObject = msg_send![screen, traitCollection];
                let style: isize = if traits.is_null() { 0 } else { msg_send![traits, userInterfaceStyle] };
                style == 2
            })
        };
        Ok(dark)
    }

    /// 폰: 클립보드의 글(기기 연결 코드 붙여넣기 버튼). 동기 커맨드라 main thread 에서 돈다.
    #[cfg(target_os = "ios")]
    #[tauri::command]
    pub fn paste_text() -> Option<String> {
        crate::ios_pasteboard_text()
    }

    /// 폰: 다른 앱에서 소리가 나오는 중인가(네코가 헤드폰을 낀다).
    #[cfg(target_os = "ios")]
    #[tauri::command(async)]
    pub fn ambient_music() -> bool {
        crate::ios_other_audio_playing()
    }

    /// 폰: 음악 앱 다루기(도구 music.control). action = play·pause·next·previous·now·search
    #[cfg(target_os = "ios")]
    #[tauri::command(async)]
    pub fn music_control(app: tauri::AppHandle, action: String, query: Option<String>, kind: Option<String>) -> Result<String, AppError> {
        crate::music_ios::control(&app, &action, query, kind)
    }

    /// 폰: 화면 밝기·소리 크기(도구 device.level). what = brightness·volume, set(0~100) 또는 by(±), 둘 다 없으면 읽기만
    #[cfg(target_os = "ios")]
    #[tauri::command(async)]
    pub fn device_level(app: tauri::AppHandle, what: String, set: Option<f64>, by: Option<f64>) -> Result<String, AppError> {
        match what.as_str() {
            "brightness" => crate::device_ios::brightness(&app, set, by),
            "volume" => crate::device_ios::volume(&app, set, by),
            _ => Err(AppError::msg(format!("모르는 항목: {what}"))),
        }
    }

    /// 폰: 권한 상태(위치·음악 보관함·카메라·붙여넣기)
    #[cfg(target_os = "ios")]
    #[tauri::command(async)]
    pub fn phone_permissions() -> crate::perm_ios::Permissions {
        crate::perm_ios::status()
    }

    /// 폰: 아직 안 물은 권한을 묻는다(iOS 권한 창). 새 상태
    #[cfg(target_os = "ios")]
    #[tauri::command]
    pub async fn phone_permission_ask(app: tauri::AppHandle, kind: String) -> Result<crate::perm_ios::Permissions, AppError> {
        crate::perm_ios::ask(&app, &kind).await
    }

    /// 폰: 설정 앱의 이 앱 화면
    #[cfg(target_os = "ios")]
    #[tauri::command]
    pub fn phone_open_settings(app: tauri::AppHandle) -> Result<(), AppError> {
        crate::perm_ios::open_settings(&app)
    }

    /// 폰: 지금 듣는 곡(음악 앱, 권한이 있을 때만). 산책이 출발 전 상태로 가져간다
    #[cfg(target_os = "ios")]
    #[tauri::command(async)]
    pub fn ambient_track(app: tauri::AppHandle) -> Option<crate::music_ios::Track> {
        crate::music_ios::track(&app)
    }

    /// 지금 듣는 곡 제목·가수(재생 중인 첫 음악 앱). 재생 중이 아니거나 권한이 없으면 null.
    #[cfg(target_os = "macos")]
    #[tauri::command(async)]
    pub fn ambient_track(app: tauri::AppHandle) -> Result<Option<crate::ambient::Track>, AppError> {
        crate::ambient::track(&app)
    }

    /// 화면 창: 고양이가 그쪽 끝을 넘어갔다 — 커서가 있는 모니터로 창을 옮긴다. 안 옮겼으면 false.
    #[cfg(target_os = "macos")]
    #[tauri::command(async)]
    pub fn neko_screen_cross(app: tauri::AppHandle, side: crate::neko_screen::Side) -> Result<bool, AppError> {
        crate::neko_screen::cross(&app, side)
    }

    /// 화면 창: 옮긴 모니터에서 다시 그렸다 — 숨겼던 창을 보인다.
    #[cfg(target_os = "macos")]
    #[tauri::command(async)]
    pub fn neko_screen_reveal(app: tauri::AppHandle) -> Result<(), AppError> {
        crate::neko_screen::reveal(&app)
    }

    /// 열린 포트를 쓰는 프로세스와 CPU·메모리를 많이 쓰는 프로세스. 읽기 전용.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn process_list(port: Option<u16>) -> crate::procs::Snapshot {
        crate::procs::snapshot(port)
    }

    // ── llama-server (llama 모듈 위임) ────────────────────────────────────────

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn llama_scan_models() -> Result<Vec<String>, AppError> {
        crate::llama::scan_models()
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn llama_start(
        config: crate::llama::LlamaConfig,
        server_state: State<'_, LlamaServerState>,
    ) -> Result<(), AppError> {
        crate::llama::start(config, &server_state)
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn llama_stop(port: i32, server_state: State<'_, LlamaServerState>) -> Result<(), AppError> {
        crate::llama::stop(port, &server_state)
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn llama_adopt(port: i32, server_state: State<'_, LlamaServerState>) -> Result<(), AppError> {
        crate::llama::adopt(port, &server_state)
    }

    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn llama_is_running(server_state: State<'_, LlamaServerState>) -> Result<bool, AppError> {
        crate::llama::is_running(&server_state)
    }

    /// 사용자가 `~/.nekodesk/skills/*.md` 에 넣어둔 지식.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn skills_load() -> Result<Vec<crate::skills::Skill>, AppError> {
        crate::skills::load()
    }

    /// AirDrop 선택 시트를 연다. 받는 사람은 사용자가 고른다 — 그게 곧 확인이다.
    #[cfg(desktop)]
    #[tauri::command(async)]
    pub fn airdrop_send(app: tauri::AppHandle, paths: Vec<String>) -> Result<usize, AppError> {
        let files = crate::airdrop::resolve_files(&paths)?;
        let count = files.len();
        // AppKit 은 메인 스레드에서만 만질 수 있다. 커맨드는 워커에서 돈다.
        app.run_on_main_thread(move || unsafe {
            crate::airdrop::open_share_sheet(&files);
        })?;
        Ok(count)
    }

    /// macOS 알림.
    ///
    /// dev 실행(`tauri dev`)에서는 앱 번들이 없어 알림 플러그인이 "터미널" 이름으로
    /// 보낸다. 터미널이 알림 권한을 받은 적이 없으면 macOS 가 **조용히** 버린다 —
    /// 실제로 이 맥에서 그래서 개발 중엔 알림이 한 번도 안 왔다. dev 에서만
    /// osascript 로 보낸다(스크립트 편집기 이름으로 뜬다). 빌드한 앱은 제 번들 ID 로
    /// 플러그인이 보낸다 — osascript 로 보내면 빌드한 앱에서도 스크립트 편집기
    /// 아이콘으로 뜬다.
    ///
    /// `sound` 는 일정·타이머처럼 놓치면 안 되는 알림에만 켠다.
    #[tauri::command(async)]
    pub fn notify_user(
        app: tauri::AppHandle,
        title: String,
        body: String,
        sound: Option<bool>,
    ) -> Result<(), AppError> {
        let sound = sound.unwrap_or(false).then_some("Glass");
        #[cfg(target_os = "macos")]
        if tauri::is_dev() {
            use std::process::{Command, Stdio};
            // 본문은 모델이 쓴 글이다. 스크립트 문자열에 이어 붙이면 따옴표 하나로
            // 임의 AppleScript 가 실행된다. 코드는 고정하고 글은 argv 로만 넘긴다.
            let line = match sound {
                Some(s) => format!("display notification (item 2 of argv) with title (item 1 of argv) sound name \"{s}\""),
                None => "display notification (item 2 of argv) with title (item 1 of argv)".into(),
            };
            Command::new("osascript")
                .args(["-e", "on run argv", "-e", &line, "-e", "end run"])
                .arg(&title)
                .arg(&body)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| AppError::msg(format!("알림 실패: {e}")))?;
            return Ok(());
        }
        use tauri_plugin_notification::NotificationExt;
        let mut builder = app.notification().builder().title(title).body(body);
        if let Some(s) = sound {
            builder = builder.sound(s);
        }
        builder
            .show()
            .map_err(|e| AppError::msg(format!("알림 실패: {e}")))
    }

    // ── 업데이트 ──────────────────────────────────────────────────────────────

    #[cfg(desktop)]
    #[derive(serde::Serialize)]
    pub struct UpdateInfo {
        version: String,
        /// Release 본문. 변경 내역과 설치 안내가 `---` 로 나뉘어 있다.
        notes: Option<String>,
    }

    /// 깃헙 Release 에 더 새 버전이 있으면 그 정보. dev 실행은 늘 없음 —
    /// 손으로 띄운 개발본을 배포본으로 덮어쓰면 안 된다.
    #[cfg(desktop)]
    #[tauri::command]
    pub async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, AppError> {
        if tauri::is_dev() {
            return Ok(None);
        }
        use tauri_plugin_updater::UpdaterExt;
        let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
        Ok(update.map(|u| UpdateInfo { version: u.version, notes: u.body }))
    }

    /// 받아서 설치하고 다시 켠다. 확인한 뒤 더 새 버전이 나왔으면 그걸 받는다.
    ///
    /// `restart` 가 아니라 `request_restart` 다. 이벤트 루프를 정상으로 빠져나가야
    /// `RunEvent::Exit` 가 돌아 앱이 띄운 llama-server 를 정리한다.
    #[cfg(desktop)]
    #[tauri::command]
    pub async fn update_install(app: tauri::AppHandle) -> Result<(), AppError> {
        use tauri_plugin_updater::UpdaterExt;
        let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
        let Some(update) = update else { return Ok(()) };
        update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
        app.request_restart();
        Ok(())
    }

    // ── 실행 이력 ─────────────────────────────────────────────────────────────
    // ExecHistoryItem 은 db::models 로 이동(상단 재노출).

    #[tauri::command(async)]
    pub fn exec_history_save(
        db: State<'_, DbState>,
        language: String,
        code: String,
        stdout: String,
        stderr: String,
        exit_code: i64,
    ) -> Result<(), AppError> {
        let conn = db.0.lock()?;
        crate::db::exec_history::save(&conn, &language, &code, &stdout, &stderr, exit_code)
    }

    #[tauri::command(async)]
    pub fn exec_history_list(db: State<'_, DbState>) -> Result<Vec<ExecHistoryItem>, AppError> {
        let conn = db.0.lock()?;
        crate::db::exec_history::list(&conn)
    }

    #[tauri::command(async)]
    pub fn exec_history_clear(db: State<'_, DbState>) -> Result<(), AppError> {
        let conn = db.0.lock()?;
        crate::db::exec_history::clear(&conn)
    }


    // 가속도계(macimu Python subprocess)는 제거됨. M4 실증 결과 non-root 로는
    // HID 데이터를 못 받고 root 데몬이 필요해, 트랙패드 쓰다듬기 + haptic_feedback 으로 대체.

}


#[allow(dead_code)]
fn percent_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '%' {
            let h1 = chars.next().unwrap_or('0');
            let h2 = chars.next().unwrap_or('0');
            if let Ok(byte) = u8::from_str_radix(&format!("{}{}", h1, h2), 16) {
                result.push(byte as char);
            }
        } else if c == '+' {
            result.push(' ');
        } else {
            result.push(c);
        }
    }
    result
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 창 크기·위치를 기억하던 window-state 플러그인은 뺐다. 메인 창은 부팅 화면 크기로
    // 작게 떴다가 window_boot_done 에서 본 크기로 커지고, 빠른 질문 창은 늘 가운데다.
    // 지난 크기(어쩌다 줄여 둔 889×593)를 되살리면 켤 때마다 작게 떴다.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init());
    // 자동 업데이트와, 보관함에서 파일을 끌어내 다른 앱에 놓기(macOS 드래그 세션)는 데스크탑만.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_drag::init());
    builder
        .on_window_event(|window, event| {
            // 앱이 앞으로 오면 곧 맞춘다(다른 기기에서 쓴 것을 바로 보게)
            if let ("main", tauri::WindowEvent::Focused(true)) = (window.label(), event) {
                crate::sync::run::kick();
            }
            match (window.label(), event) {
            // 메인 창을 닫아도 앱은 남는다. ⌃⇧N 으로 물어본 답이 도착할 곳이 있어야
            // 하고, 알림도 이 창의 웹뷰가 보낸다. 완전히 끝내려면 ⌘Q.
            ("main", tauri::WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            // 메인 창이 앞으로 왔다(Dock·⌘Tab·클릭): 고양이 메뉴로 숨긴 마당을 다시 보인다
            // (unhide 는 main thread 일을 기다리니 여기 main thread 에서 바로 부르면 멈춘다 — 따로 돌린다)
            #[cfg(target_os = "macos")]
            ("main", tauri::WindowEvent::Focused(true)) if crate::neko_screen::user_hidden() => {
                let app = window.app_handle().clone();
                std::thread::spawn(move || crate::neko_screen::unhide(&app));
            }
            // 마당 네코 몸·입에 파일을 놓았다(§7). 경로는 웹뷰가 아니라 macOS 놓기 이벤트에서만 받는다 — 웹뷰가 준
            // 경로를 믿으면 아무 파일이나 보관함으로 복사할 수 있다. 받는 자리에서만 클릭을 받으니 거기서만 온다.
            // 복사는 오래 걸릴 수 있어 따로 돌린다. 2GB 넘는 등 실패면 화면 창이 고개를 돌린다
            #[cfg(target_os = "macos")]
            ("neko-screen", tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. })) if !paths.is_empty() => {
                let (app, paths) = (window.app_handle().clone(), paths.clone());
                std::thread::spawn(move || {
                    use tauri::Emitter;
                    match crate::shelf::dir(&app).and_then(|d| crate::shelf::add_paths(&d, &paths)) {
                        Ok(_) => commands::shelf_changed(&app),
                        Err(e) => {
                            log::warn!("마당 네코 입에 못 넣었어: {e}");
                            let _ = app.emit_to("neko-screen", "neko-screen-drop-refused", e.to_string());
                        }
                    }
                });
            }
            // 빠른 질문 창은 다른 곳을 누르면 사라진다(Spotlight 처럼).
            ("quick", tauri::WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            _ => {}
        }})
        .setup(|app| {
            // 앱 데이터 디렉토리 기준으로 DB 경로 결정
            // dev: ~/Library/Application Support/nekodesk
            // 빌드: ~/Library/Application Support/com.nekodesk.desktop
            let data_dir = app.path().app_data_dir()
                .expect("Failed to resolve app data dir");
            let conn = match open_db(data_dir) {
                Ok(conn) => conn,
                Err(message) => {
                    fatal_alert(&message);
                    std::process::exit(1);
                }
            };
            db::init_schema(&conn).expect("Failed to initialize schema");
            // 예전 버전이 표에 적어 둔 API 키를 키체인으로 옮긴다.
            secrets::migrate(&conn);
            app.manage(DbState(Mutex::new(conn)));
            // 기기 이름을 main thread 에서 한 번 읽어 둔다(폰은 UIKit)
            let _ = sync::run::device_name();
            sync::run::start(app.handle().clone());
            #[cfg(target_os = "ios")]
            if let Some(main) = app.get_webview_window("main") {
                ios_full_screen(&main);
            }
            #[cfg(desktop)]
            {
                app.manage(LlamaServerState(Mutex::new(LlamaProc::default())));
                app.manage(crate::mcp::McpRegistry::new());
                app.manage(ViewerState::default());
            }
            #[cfg(target_os = "macos")]
            app.manage(crate::capture::CaptureState::default());

            // ⌃⇧N — 어느 앱에서든 빠른 질문 창. 다른 앱이 이미 쓰고 있으면 등록이
            // 실패하는데, 그렇다고 앱이 안 뜨면 안 된다.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }
                            if shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyN) {
                                quick::toggle(app);
                            }
                            // 캡처하는 동안만 등록된다(capture.rs).
                            #[cfg(target_os = "macos")]
                            if shortcut.matches(Modifiers::empty(), Code::Escape) {
                                capture::cancel(app);
                            }
                        })
                        .build(),
                )?;
                if let Some(win) = app.get_webview_window("quick") {
                    quick::install_panel(&win);
                }
                // 메인 창은 보이기 전에 마우스가 있는 모니터 가운데로(설정의 center 는 주 모니터)
                if let Some(win) = app.get_webview_window("main") {
                    place::center(&win, place::Screen::Cursor, false);
                    // 부팅 화면이 끝나야(window_boot_done) 최소 크기가 걸린다. 끝내 안 오면 여기서라도 건다 —
                    // 안 걸리면 창이 부팅 크기로 남고 사용자가 줄여도 막지 못해 좁은 배치가 나온다.
                    std::thread::spawn(move || {
                        std::thread::sleep(BOOT_GRACE);
                        if !BOOT_SETTLED.load(std::sync::atomic::Ordering::SeqCst) {
                            log::warn!("부팅 화면이 {}초 안에 안 끝나 메인 창 최소 크기를 먼저 건다", BOOT_GRACE.as_secs());
                            settle_main_window(&win, true);
                        }
                    });
                }
                if let Err(e) = app
                    .global_shortcut()
                    .register(Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyN))
                {
                    log::warn!("⌃⇧N 단축키 등록 실패: {e}");
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::todo_list,
            commands::todo_list_done,
            commands::todo_add,
            commands::todo_complete,
            commands::schedule_list,
            commands::schedule_add,
            commands::schedule_delete,
            #[cfg(desktop)]
            commands::code_exec,
            commands::web_search,
            commands::web_scrape,
            commands::web_image,
            #[cfg(desktop)]
            commands::trace_save,
            commands::image_generate,
            commands::settings_set,
            commands::settings_get,
            commands::secret_set,
            commands::secret_has,
            commands::secret_dev_get,
            claude::claude_proxy,
            claude::claude_cancel,
            commands::conversation_save,
            commands::conversation_load,
            commands::conversation_delete,
            commands::conversation_prune,
            sync::run::sync_status,
            sync::run::sync_enable,
            sync::run::sync_now,
            sync::run::sync_setup,
            sync::run::sync_pair_make,
            sync::run::sync_pair_join,
            sync::run::sync_pair_check,
            sync::run::walk_shared,
            sync::run::walk_claim,
            sync::run::walk_end,
            #[cfg(desktop)]
            sync::run::sync_pair_qr,
            #[cfg(target_os = "ios")]
            sync::run::sync_pair_linked,
            sync::run::session_list,
            sync::run::session_put,
            sync::run::session_import,
            sync::run::session_read,
            sync::run::session_delete,
            sync::run::session_compact,
            sync::run::sync_devices,
            sync::run::sync_revoke,
            sync::run::sync_rekey,
            sync::run::gift_add,
            sync::run::gift_patch,
            sync::run::gift_remove,
            commands::weather_get,
            commands::weather_now,
            #[cfg(desktop)]
            commands::window_boot_done,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            commands::location_current,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            commands::location_permission,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            map::map_snapshot,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            map::map_places,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            map::map_walk_route,
            #[cfg(desktop)]
            commands::shelf_list,
            #[cfg(desktop)]
            commands::shelf_add,
            #[cfg(desktop)]
            commands::shelf_remove,
            #[cfg(desktop)]
            commands::shelf_take,
            #[cfg(target_os = "macos")]
            commands::file_icon,
            commands::haptic_feedback,
            #[cfg(desktop)]
            commands::viewer_open,
            #[cfg(desktop)]
            commands::panel_open,
            #[cfg(desktop)]
            commands::viewer_item,
            #[cfg(desktop)]
            commands::save_download,
            #[cfg(desktop)]
            commands::reveal_in_finder,
            #[cfg(desktop)]
            commands::copy_image,
            #[cfg(desktop)]
            commands::quick_capture,
            #[cfg(desktop)]
            commands::quick_fit,
            #[cfg(target_os = "macos")]
            commands::capture_targets,
            #[cfg(target_os = "macos")]
            commands::capture_pick,
            #[cfg(desktop)]
            commands::open_url,
            #[cfg(any(desktop, target_os = "ios"))]
            commands::open_external_url,
            #[cfg(desktop)]
            commands::save_canvas_image,
            commands::exec_history_save,
            commands::exec_history_list,
            commands::exec_history_clear,
            #[cfg(desktop)]
            commands::fs_read,
            #[cfg(desktop)]
            commands::fs_write,
            #[cfg(desktop)]
            commands::fs_edit,
            #[cfg(desktop)]
            commands::fs_list,
            #[cfg(desktop)]
            commands::fs_glob,
            #[cfg(desktop)]
            commands::fs_grep,
            #[cfg(desktop)]
            commands::fs_check,
            #[cfg(desktop)]
            commands::airdrop_send,
            commands::notify_user,
            #[cfg(desktop)]
            commands::update_check,
            #[cfg(desktop)]
            commands::update_install,
            #[cfg(desktop)]
            commands::skills_load,
            commands::memory_save,
            commands::memory_search,
            commands::memory_list,
            commands::memory_delete,
            #[cfg(desktop)]
            commands::security_check,
            #[cfg(desktop)]
            commands::process_list,
            #[cfg(desktop)]
            commands::glow_alert,
            #[cfg(desktop)]
            commands::glow_take,
            #[cfg(target_os = "macos")]
            commands::neko_screen_show,
            #[cfg(target_os = "macos")]
            commands::neko_screen_catch,
            #[cfg(target_os = "macos")]
            commands::neko_screen_drag_out,
            #[cfg(target_os = "macos")]
            commands::neko_screen_layout,
            #[cfg(target_os = "macos")]
            commands::ambient_probe,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            commands::ambient_music,
            #[cfg(target_os = "ios")]
            commands::paste_text,
            #[cfg(target_os = "ios")]
            commands::phone_standby,
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            commands::ambient_track,
            #[cfg(target_os = "ios")]
            commands::music_control,
            #[cfg(target_os = "ios")]
            commands::device_level,
            #[cfg(target_os = "ios")]
            commands::phone_permissions,
            #[cfg(target_os = "ios")]
            commands::phone_permission_ask,
            #[cfg(target_os = "ios")]
            commands::phone_open_settings,
            #[cfg(target_os = "ios")]
            commands::phone_theme,
            #[cfg(target_os = "macos")]
            commands::neko_screen_cross,
            #[cfg(target_os = "macos")]
            commands::neko_screen_reveal,
            #[cfg(target_os = "macos")]
            commands::neko_screen_hide,
            #[cfg(target_os = "macos")]
            commands::neko_screen_screens,
            #[cfg(target_os = "macos")]
            commands::neko_decor_boxes,
            #[cfg(target_os = "macos")]
            commands::neko_screen_held,
            #[cfg(target_os = "macos")]
            commands::neko_screen_cat,
            #[cfg(target_os = "macos")]
            commands::neko_screen_perches,
            #[cfg(target_os = "macos")]
            commands::neko_screen_perch_debug,
            #[cfg(desktop)]
            commands::mcp_stdio_start,
            #[cfg(desktop)]
            commands::mcp_stdio_rpc,
            #[cfg(desktop)]
            commands::mcp_stdio_stop,
            #[cfg(desktop)]
            commands::mcp_stdio_is_running,
            #[cfg(desktop)]
            commands::llama_scan_models,
            #[cfg(desktop)]
            commands::llama_start,
            #[cfg(desktop)]
            commands::llama_stop,
            #[cfg(desktop)]
            commands::llama_adopt,
            #[cfg(desktop)]
            commands::llama_is_running,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 폰에는 다시 열기·끝낼 때 치울 자식 프로세스가 없다
            let _ = (&app_handle, &event);
            // 폰: 맥의 QR 을 카메라로 찍으면 nekodesk://pair?d=… 로 앱이 열린다
            #[cfg(target_os = "ios")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    crate::sync::run::link_opened(app_handle, url.as_str());
                }
            }
            // Dock 아이콘을 누르면 숨겨둔 메인 창을 다시 보인다.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<LlamaServerState>() {
                    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(ref mut child) = guard.child {
                        child.kill().ok();
                        child.wait().ok();
                    }
                    // 자식 핸들이 stale/None 이어도(spawn 조용히 실패, 고아 재사용 등)
                    // 우리가 띄운 포트를 점유 중이면 확실히 죽인다.
                    if let Some(port) = guard.port {
                        kill_port(port);
                    }
                    *guard = LlamaProc::default();
                }
                // MCP stdio 서버들도 우리가 띄운 자식이다. 안 죽이면 고아로 남는다.
                if let Some(registry) = app_handle.try_state::<crate::mcp::McpRegistry>() {
                    crate::mcp::shutdown_all(&registry);
                }
            }
        });
}

#[cfg(all(test, desktop))]
mod download_tests {
    use super::unique_download_path;

    #[test]
    fn numbers_duplicates_and_drops_directories() {
        let dir = std::env::temp_dir().join(format!("neko-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(unique_download_path(&dir, "그림.png"), dir.join("그림.png"));
        std::fs::write(dir.join("그림.png"), b"x").unwrap();
        std::fs::write(dir.join("그림 (2).png"), b"x").unwrap();
        assert_eq!(unique_download_path(&dir, "그림.png"), dir.join("그림 (3).png"));
        // 화면에서 온 이름에 경로가 섞여도 다운로드 폴더 밖으로 나가지 않는다.
        assert_eq!(unique_download_path(&dir, "../../etc/passwd"), dir.join("passwd"));
        assert_eq!(unique_download_path(&dir, ".."), dir.join("nekodesk"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
