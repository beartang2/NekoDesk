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
mod exec;
mod llama;
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
    ) -> Result<(), AppError> {
        let conn = db.0.lock()?;
        crate::db::conversations::save(&conn, &session_id, &role, &content)
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

    #[tauri::command]
    pub async fn weather_get(location: String) -> Result<String, AppError> {
        crate::http::weather::run(&location).await
    }

    /// macOS 알림을 띄웁니다.
    ///
    /// title/body 를 AppleScript 소스에 문자열 보간하면 안 된다. 큰따옴표 하나로
    /// 문자열을 탈출해 임의 코드가 실행된다. `on run argv` 로 넘기면 osascript 가
    /// 이 값들을 파싱하지 않고 데이터로만 취급한다.
    #[tauri::command(async)]
    pub fn notify_send(title: String, body: String) -> Result<(), AppError> {
        Command::new("osascript")
            .arg("-e").arg("on run argv")
            .arg("-e").arg("display notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"")
            .arg("-e").arg("end run")
            .arg(title)
            .arg(body)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("알림 표시 실패: {e}"))?;
        Ok(())
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
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            // 앱 데이터 디렉토리 기준으로 DB 경로 결정
            // dev: ~/Library/Application Support/nekodesk
            // 빌드: ~/Library/Application Support/com.nekodesk.app
            let data_dir = app.path().app_data_dir()
                .expect("Failed to resolve app data dir");
            let conn = open_db(data_dir).expect("Failed to open database");
            db::init_schema(&conn).expect("Failed to initialize schema");
            app.manage(DbState(Mutex::new(conn)));
            app.manage(LlamaServerState(Mutex::new(LlamaProc::default())));
            app.manage(crate::mcp::McpRegistry::new());

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
            commands::settings_set,
            commands::settings_get,
            commands::conversation_save,
            commands::conversation_load,
            commands::conversation_delete,
            commands::weather_get,
            commands::notify_send,
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
