use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

mod error;
mod db;
mod http;
// 이름을 `fs` 로 두면 이 파일 곳곳의 `std::fs` 와 헷갈린다.
mod files;
mod airdrop;
mod exec;
mod llama;
mod skills;
mod quick;
mod location;
mod shelf;
// 통합 테스트(tests/mcp_stdio.rs)가 실제 프로세스를 띄워 확인하므로 공개한다.
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
#[derive(Default)]
pub struct LlamaProc {
    pub child: Option<std::process::Child>,
    pub port: Option<i32>,
}
pub struct LlamaServerState(pub Mutex<LlamaProc>);

/// 해당 TCP 포트를 LISTEN 중인 프로세스를 종료한다(고아 llama 청소용).
/// 추적 핸들이 없어도 동작하도록 lsof 로 PID 를 찾아 신호를 보낸다.
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

    let ns = window.ns_window()? as usize;
    let (tx, rx) = mpsc::channel();
    window.run_on_main_thread(move || {
        let _ = tx.send(unsafe { boot_frames(ns as *mut AnyObject, max_w, max_h) });
    })?;
    let Some((from, to)) = rx.recv().ok().flatten() else { return Ok(()) };

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
        let _ = rx.recv();
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

fn open_db(data_dir: PathBuf) -> rusqlite::Result<Connection> {
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
    let conn = Connection::open(&path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    Ok(conn)
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
}

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
    use std::process::{Command, Stdio};
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
    pub async fn web_search(
        db: State<'_, DbState>,
        query: String,
    ) -> Result<Vec<SearchResult>, AppError> {
        // brave 키는 lock 을 await 전에 버리고 owned 로 뽑는다(가드는 !Send).
        let brave_key = {
            let conn = db.0.lock()?;
            crate::db::settings::get(&conn, "brave_search_key")?
        };
        crate::http::search::run(&query, brave_key).await
    }

    /// 설명대로 그림을 그려 data URL 로 돌려준다. 키는 DB 에서 꺼낸다.
    #[tauri::command]
    pub async fn image_generate(
        db: State<'_, DbState>,
        provider: String,
        model: String,
        prompt: String,
    ) -> Result<String, AppError> {
        let (cf_account, cf_token, google_key) = {
            let conn = db.0.lock()?;
            let get = |k: &str| crate::db::settings::get(&conn, k).map(Option::unwrap_or_default);
            (get("cf_account_id")?, get("cf_api_token")?, get("google_api_key")?)
        };
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

    #[tauri::command(async)]
    pub fn settings_set(db: State<'_, DbState>, key: String, value: String) -> Result<(), AppError> {
        let conn = db.0.lock()?;
        crate::db::settings::set(&conn, &key, &value)
    }

    #[tauri::command(async)]
    pub fn settings_get(db: State<'_, DbState>, key: String) -> Result<Option<String>, AppError> {
        let conn = db.0.lock()?;
        crate::db::settings::get(&conn, &key)
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
        )
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

    /// 부팅 화면이 끝나면 프런트가 부른다. 작게 뜬 창이 같은 가운데에서 본 크기로
    /// 부드럽게 커지고, 다 커진 뒤에 돌아온다 — 프런트는 그때 부팅 화면을 걷는다.
    #[tauri::command]
    pub async fn window_boot_done(window: tauri::WebviewWindow) -> Result<(), AppError> {
        // 처음엔 1366×768 이었는데 커지고 나면 크게 느껴졌다. 한 단계 줄였다.
        const W: f64 = 1000.0;
        const H: f64 = 650.0;
        #[cfg(target_os = "macos")]
        {
            let win = window.clone();
            tauri::async_runtime::spawn_blocking(move || grow_boot_window(&win, W, H))
                .await
                .map_err(|e| AppError::msg(e.to_string()))??;
        }
        #[cfg(not(target_os = "macos"))]
        {
            window.set_size(tauri::LogicalSize::new(W, H))?;
            window.center()?;
        }
        // 부팅 창은 작아야 해서 최소 크기는 다 커진 뒤에 건다.
        window.set_min_size(Some(tauri::LogicalSize::new(720.0, 520.0)))?;
        Ok(())
    }

    #[tauri::command(async)]
    pub fn shelf_list(app: tauri::AppHandle) -> Result<Vec<crate::shelf::ShelfItem>, AppError> {
        crate::shelf::list(&crate::shelf::dir(&app)?)
    }

    /// 보관함에 넣는다. 몸통은 파일 바이트 그대로, 이름은 x-name 헤더(encodeURIComponent).
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
        crate::shelf::add(&crate::shelf::dir(&app)?, &name, bytes)
    }

    #[tauri::command(async)]
    pub fn shelf_remove(app: tauri::AppHandle, name: String) -> Result<(), AppError> {
        crate::shelf::remove(&crate::shelf::dir(&app)?, &name)
    }

    #[tauri::command]
    pub async fn weather_get(location: String) -> Result<String, AppError> {
        crate::http::weather::run(&location).await
    }

    /// macOS 위치 서비스로 지금 동네를 찾는다. `"역삼동 (37.5000,127.0364)"` 꼴.
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

    /// macOS URL 스킴 또는 앱을 엽니다 (권한 설정 페이지 열기 등에 사용).
    /// 내부 신뢰 호출 전용(x-apple.systempreferences: 등). 미신뢰 링크는 open_external_url.
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
    #[tauri::command(async)]
    pub fn open_external_url(url: String) -> Result<(), AppError> {
        let lower = url.trim_start().to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err("http/https 링크만 열 수 있습니다".into());
        }
        std::process::Command::new("open")
            .arg("--")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ── 그림판 저장 ───────────────────────────────────────────────────────────

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

    // ── 파일 (files 모듈 위임) ────────────────────────────────────────────────
    // 정책 판정과 실제 I/O 는 crate::files 안에 있고 거기서 단위 테스트된다.
    // 여기서는 승인된 쓰기 루트를 DB 에서 꺼내 넘겨주는 역할만 한다.

    /// 사용자가 "항상 허용" 한 쓰기 루트 목록(JSON 배열 문자열).
    fn write_roots(db: &State<'_, DbState>) -> Result<String, AppError> {
        let conn = db.0.lock()?;
        Ok(crate::db::settings::get(&conn, "fs_write_roots")?.unwrap_or_else(|| "[]".to_string()))
    }

    #[tauri::command(async)]
    pub fn fs_read(
        path: String,
        offset: Option<usize>,
        limit: Option<usize>,
    ) -> Result<crate::files::FsReadResult, AppError> {
        crate::files::read(&path, offset, limit)
    }

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

    #[tauri::command(async)]
    pub fn fs_list(path: String) -> Result<Vec<crate::files::FsEntry>, AppError> {
        crate::files::list(&path)
    }

    #[tauri::command(async)]
    pub fn fs_glob(pattern: String, base: Option<String>) -> Result<Vec<String>, AppError> {
        crate::files::glob(&pattern, base.as_deref())
    }

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

    #[tauri::command(async)]
    pub fn mcp_stdio_start(
        state: State<'_, crate::mcp::McpRegistry>,
        id: String,
        command: String,
        env: Option<std::collections::HashMap<String, String>>,
    ) -> Result<crate::mcp::McpStartResult, AppError> {
        crate::mcp::start(&state, &id, &command, &env.unwrap_or_default())
    }

    #[tauri::command(async)]
    pub fn mcp_stdio_rpc(
        state: State<'_, crate::mcp::McpRegistry>,
        id: String,
        method: String,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, AppError> {
        crate::mcp::rpc(&state, &id, &method, params)
    }

    #[tauri::command(async)]
    pub fn mcp_stdio_stop(
        state: State<'_, crate::mcp::McpRegistry>,
        id: String,
    ) -> Result<(), AppError> {
        crate::mcp::stop(&state, &id)
    }

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

    // ── llama-server (llama 모듈 위임) ────────────────────────────────────────

    #[tauri::command(async)]
    pub fn llama_scan_models() -> Result<Vec<String>, AppError> {
        crate::llama::scan_models()
    }

    #[tauri::command(async)]
    pub fn llama_start(
        config: crate::llama::LlamaConfig,
        server_state: State<'_, LlamaServerState>,
    ) -> Result<(), AppError> {
        crate::llama::start(config, &server_state)
    }

    #[tauri::command(async)]
    pub fn llama_stop(port: i32, server_state: State<'_, LlamaServerState>) -> Result<(), AppError> {
        crate::llama::stop(port, &server_state)
    }

    #[tauri::command(async)]
    pub fn llama_is_running(server_state: State<'_, LlamaServerState>) -> Result<bool, AppError> {
        crate::llama::is_running(&server_state)
    }

    /// 사용자가 `~/.nekodesk/skills/*.md` 에 넣어둔 지식.
    #[tauri::command(async)]
    pub fn skills_load() -> Result<Vec<crate::skills::Skill>, AppError> {
        crate::skills::load()
    }

    /// AirDrop 선택 시트를 연다. 받는 사람은 사용자가 고른다 — 그게 곧 확인이다.
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
        if tauri::is_dev() {
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
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // 보관함에서 파일을 끌어내 다른 앱에 놓는다(macOS 드래그 세션).
        .plugin(tauri_plugin_drag::init())
        .on_window_event(|window, event| match (window.label(), event) {
            // 메인 창을 닫아도 앱은 남는다. ⌃⇧N 으로 물어본 답이 도착할 곳이 있어야
            // 하고, 알림도 이 창의 웹뷰가 보낸다. 완전히 끝내려면 ⌘Q.
            ("main", tauri::WindowEvent::CloseRequested { api, .. }) => {
                api.prevent_close();
                let _ = window.hide();
            }
            // 빠른 질문 창은 다른 곳을 누르면 사라진다(Spotlight 처럼).
            ("quick", tauri::WindowEvent::Focused(false)) => {
                let _ = window.hide();
            }
            _ => {}
        })
        .setup(|app| {
            // 앱 데이터 디렉토리 기준으로 DB 경로 결정
            // dev: ~/Library/Application Support/nekodesk
            // 빌드: ~/Library/Application Support/com.nekodesk.desktop
            let data_dir = app.path().app_data_dir()
                .expect("Failed to resolve app data dir");
            let conn = open_db(data_dir).expect("Failed to open database");
            db::init_schema(&conn).expect("Failed to initialize schema");
            app.manage(DbState(Mutex::new(conn)));
            app.manage(LlamaServerState(Mutex::new(LlamaProc::default())));
            app.manage(crate::mcp::McpRegistry::new());

            // ⌃⇧N — 어느 앱에서든 빠른 질문 창. 다른 앱이 이미 쓰고 있으면 등록이
            // 실패하는데, 그렇다고 앱이 안 뜨면 안 된다.
            {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state() == ShortcutState::Pressed
                                && shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyN)
                            {
                                quick::toggle(app);
                            }
                        })
                        .build(),
                )?;
                if let Some(win) = app.get_webview_window("quick") {
                    quick::install_panel(&win);
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
            commands::code_exec,
            commands::web_search,
            commands::web_scrape,
            commands::image_generate,
            commands::settings_set,
            commands::settings_get,
            commands::conversation_save,
            commands::conversation_load,
            commands::conversation_delete,
            commands::weather_get,
            commands::weather_now,
            commands::window_boot_done,
            commands::location_current,
            commands::shelf_list,
            commands::shelf_add,
            commands::shelf_remove,
            commands::haptic_feedback,
            commands::open_url,
            commands::open_external_url,
            commands::save_canvas_image,
            commands::exec_history_save,
            commands::exec_history_list,
            commands::exec_history_clear,
            commands::fs_read,
            commands::fs_write,
            commands::fs_edit,
            commands::fs_list,
            commands::fs_glob,
            commands::fs_grep,
            commands::fs_check,
            commands::airdrop_send,
            commands::notify_user,
            commands::skills_load,
            commands::memory_save,
            commands::memory_search,
            commands::memory_list,
            commands::memory_delete,
            commands::mcp_stdio_start,
            commands::mcp_stdio_rpc,
            commands::mcp_stdio_stop,
            commands::mcp_stdio_is_running,
            commands::llama_scan_models,
            commands::llama_start,
            commands::llama_stop,
            commands::llama_is_running,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Dock 아이콘을 누르면 숨겨둔 메인 창을 다시 보인다.
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
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
