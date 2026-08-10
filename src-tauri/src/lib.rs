use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::io::Read;
use tauri::Manager;
use base64::{Engine as _, engine::general_purpose};

mod error;
mod db;
mod http;
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

const NEKO_IMG_PATH: &str = "/tmp/neko_output.png";

fn collect_output_image() -> Option<String> {
    let path = std::path::Path::new(NEKO_IMG_PATH);
    if !path.exists() { return None; }
    let data = std::fs::read(path).ok()?;
    std::fs::remove_file(path).ok();
    Some(format!("data:image/png;base64,{}", general_purpose::STANDARD.encode(&data)))
}


// ── Commands module ───────────────────────────────────────────────────────────
// Tauri 2 requires commands to be in their own module when using generate_handler!
// with multiple commands to avoid macro namespace collisions.

mod commands {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use std::thread;
    use std::sync::mpsc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::State;

    // todos 커맨드는 DB 잠금만 잡고 db::todos 순수 함수에 위임한다.
    // SQL·행 매핑은 db/todos.rs 에 있고 거기서 단위 테스트된다.

    #[tauri::command]
    pub fn todo_list(db: State<DbState>) -> Result<Vec<Todo>, AppError> {
        let conn = db.0.lock()?;
        crate::db::todos::list_open(&conn)
    }

    #[tauri::command]
    pub fn todo_add(
        db: State<DbState>,
        content: String,
        due_at: Option<String>,
    ) -> Result<Todo, AppError> {
        let conn = db.0.lock()?;
        crate::db::todos::add(&conn, &content, due_at.as_deref())
    }

    #[tauri::command]
    pub fn todo_list_done(db: State<DbState>) -> Result<Vec<Todo>, AppError> {
        let conn = db.0.lock()?;
        crate::db::todos::list_done(&conn)
    }

    #[tauri::command]
    pub fn todo_complete(db: State<DbState>, id: i64) -> Result<bool, AppError> {
        let conn = db.0.lock()?;
        crate::db::todos::complete(&conn, id)
    }

    #[tauri::command]
    pub fn schedule_list(db: State<DbState>, range: String) -> Result<Vec<ScheduleEvent>, AppError> {
        let conn = db.0.lock()?;
        crate::db::events::list(&conn, crate::db::events::Range::parse(&range))
    }

    #[tauri::command]
    pub fn schedule_add(
        db: State<DbState>,
        title: String,
        start_at: String,
        end_at: Option<String>,
    ) -> Result<ScheduleEvent, AppError> {
        let conn = db.0.lock()?;
        crate::db::events::add(&conn, &title, &start_at, end_at.as_deref())
    }

    #[tauri::command]
    pub fn schedule_delete(db: State<DbState>, ids: Vec<i64>) -> Result<usize, AppError> {
        let conn = db.0.lock()?;
        crate::db::events::delete(&conn, &ids)
    }

    /// 바이트 인덱스로 String을 자르면 멀티바이트 문자(한글 3바이트, 이모지 4바이트)
    /// 경계에서 패닉한다. 항상 문자 단위로 자른다.
    fn truncate_chars(s: String, max_chars: usize) -> (String, bool) {
        if s.chars().count() <= max_chars {
            return (s, false);
        }
        let mut out: String = s.chars().take(max_chars).collect();
        out.push_str("…(잘림)");
        (out, true)
    }

    /// 프런트엔드의 확인 다이얼로그를 우회한 호출(예: webview 스크립트가 직접
    /// invoke)에 대한 Rust 측 최종 방어선. 신뢰 경계를 렌더러에만 두지 않는다.
    /// 여기서는 되돌릴 수 없는 최악의 명령만 하드 차단한다.
    fn hard_blocked(code: &str) -> Option<&'static str> {
        const BLOCK: &[(&str, &str)] = &[
            ("sudo ", "관리자 권한 실행"),
            ("rm -rf /", "루트 경로 강제 삭제"),
            ("rm -rf ~", "홈 디렉토리 강제 삭제"),
            ("mkfs", "디스크 포맷"),
            ("diskutil erase", "디스크 초기화"),
            ("with administrator privileges", "관리자 권한 실행(AppleScript)"),
            ("id_rsa", "SSH 개인키 접근"),
            ("id_ed25519", "SSH 개인키 접근"),
        ];
        let lower = code.to_lowercase();
        BLOCK.iter().find(|(p, _)| lower.contains(p)).map(|(_, r)| *r)
    }

    #[tauri::command]
    pub fn code_exec(code: String, language: Option<String>, work_dir: Option<String>) -> Result<CodeExecResult, String> {
        if let Some(reason) = hard_blocked(&code) {
            return Err(format!("보안상 차단된 명령이야: {reason}. 이건 실행할 수 없어."));
        }
        let lang = language.as_deref().unwrap_or("python");

        // AppleScript는 임시 파일로 실행 (-e 플래그는 멀티라인/한글에서 불안정)
        if lang == "applescript" || lang == "osascript" {
            // 고정 경로는 심볼릭 링크 공격과 동시 호출 레이스에 노출된다.
            // 호출마다 고유 경로를 쓰고 실행 후 지운다.
            static SCRIPT_SEQ: AtomicUsize = AtomicUsize::new(0);
            let tmp_path = std::env::temp_dir().join(format!(
                "nekodesk_{}_{}.applescript",
                std::process::id(),
                SCRIPT_SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::write(&tmp_path, code.as_bytes())
                .map_err(|e| format!("AppleScript 임시 파일 생성 실패: {e}"))?;

            let dir = work_dir
                .filter(|d| !d.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));

            let mut child = Command::new("osascript")
                .arg(&tmp_path)
                .current_dir(&dir)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("실행 실패: {e}. osascript 가 설치되어 있는지 확인해줘."))?;

            let stdout_pipe = child.stdout.take().unwrap();
            let stderr_pipe = child.stderr.take().unwrap();
            let (tx_out, rx_out) = mpsc::channel::<String>();
            let (tx_err, rx_err) = mpsc::channel::<String>();
            thread::spawn(move || {
                let mut buf = String::new();
                let mut reader = std::io::BufReader::new(stdout_pipe);
                reader.read_to_string(&mut buf).ok();
                tx_out.send(buf).ok();
            });
            thread::spawn(move || {
                let mut buf = String::new();
                let mut reader = std::io::BufReader::new(stderr_pipe);
                reader.read_to_string(&mut buf).ok();
                tx_err.send(buf).ok();
            });
            // python/shell 분기와 동일한 30초 상한. 예전에는 child.wait() 무한대기라
            // `repeat`나 `display dialog` 하나로 앱이 영구 정지했다.
            let timeout = Duration::from_secs(30);
            let start = Instant::now();
            let exit_code = loop {
                match child.try_wait().map_err(|e| format!("프로세스 대기 실패: {e}"))? {
                    Some(status) => break status.code().unwrap_or(-1),
                    None => {
                        if start.elapsed() > timeout {
                            child.kill().ok();
                            std::fs::remove_file(&tmp_path).ok();
                            return Err("AppleScript 실행 시간 초과 (30초)".to_string());
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            };
            std::fs::remove_file(&tmp_path).ok();

            let stdout_raw = rx_out.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
            let stderr_raw = rx_err.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
            let (stdout, stdout_trunc) = truncate_chars(stdout_raw, 4000);
            let (stderr, stderr_trunc) = truncate_chars(stderr_raw, 2000);
            let truncated = stdout_trunc || stderr_trunc;
            let image_data_url = collect_output_image();
            return Ok(CodeExecResult { stdout, stderr, exit_code, truncated, image_data_url });
        }

        let (interpreter, flag) = match lang {
            "python" | "python3" => ("python3", "-c"),
            "shell" | "sh" | "bash" => ("sh", "-c"),
            other => return Err(format!("지원하지 않는 언어: {}. python, shell 또는 applescript를 사용해줘.", other)),
        };

        let dir = work_dir
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));

        let mut child = Command::new(interpreter)
            .arg(flag)
            .arg(&code)
            .current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("실행 실패: {}. {} 가 설치되어 있는지 확인해줘.", e, interpreter))?;

        // Collect stdout/stderr in background threads
        let stdout_pipe = child.stdout.take().unwrap();
        let stderr_pipe = child.stderr.take().unwrap();

        let (tx_out, rx_out) = mpsc::channel::<String>();
        let (tx_err, rx_err) = mpsc::channel::<String>();

        thread::spawn(move || {
            let mut buf = String::new();
            let mut reader = std::io::BufReader::new(stdout_pipe);
            reader.read_to_string(&mut buf).ok();
            tx_out.send(buf).ok();
        });

        thread::spawn(move || {
            let mut buf = String::new();
            let mut reader = std::io::BufReader::new(stderr_pipe);
            reader.read_to_string(&mut buf).ok();
            tx_err.send(buf).ok();
        });

        // Poll for completion with 30s timeout
        let timeout = Duration::from_secs(30);
        let start = Instant::now();
        let exit_code = loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => break status.code().unwrap_or(-1),
                None => {
                    if start.elapsed() > timeout {
                        child.kill().ok();
                        return Err("실행 시간 초과 (30초)".to_string());
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }
        };

        let stdout_raw = rx_out.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
        let stderr_raw = rx_err.recv_timeout(Duration::from_secs(5)).unwrap_or_default();

        const MAX_OUTPUT: usize = 4000;
        let (stdout, stdout_trunc) = truncate_chars(stdout_raw, MAX_OUTPUT);
        let (stderr, stderr_trunc) = truncate_chars(stderr_raw, MAX_OUTPUT);
        let truncated = stdout_trunc || stderr_trunc;

        let image_data_url = collect_output_image();
        Ok(CodeExecResult { stdout, stderr, exit_code, truncated, image_data_url })
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

    #[tauri::command]
    pub fn settings_set(db: State<DbState>, key: String, value: String) -> Result<(), AppError> {
        let conn = db.0.lock()?;
        crate::db::settings::set(&conn, &key, &value)
    }

    #[tauri::command]
    pub fn settings_get(db: State<DbState>, key: String) -> Result<Option<String>, AppError> {
        let conn = db.0.lock()?;
        crate::db::settings::get(&conn, &key)
    }

    #[tauri::command]
    pub fn conversation_save(
        db: State<DbState>,
        session_id: String,
        role: String,
        content: String,
    ) -> Result<(), AppError> {
        let conn = db.0.lock()?;
        crate::db::conversations::save(&conn, &session_id, &role, &content)
    }

    #[tauri::command]
    pub fn conversation_load(
        db: State<DbState>,
        session_id: String,
    ) -> Result<Vec<ConversationMessage>, AppError> {
        let conn = db.0.lock()?;
        crate::db::conversations::load(&conn, &session_id)
    }

    #[tauri::command]
    pub fn conversation_delete(db: State<DbState>, session_id: String) -> Result<(), AppError> {
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
    #[tauri::command]
    pub fn notify_send(title: String, body: String) -> Result<(), String> {
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
    #[tauri::command]
    pub fn haptic_feedback(app: tauri::AppHandle, pattern: Option<i64>) -> Result<(), String> {
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
    #[tauri::command]
    pub fn open_url(url: String) -> Result<(), String> {
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
    #[tauri::command]
    pub fn open_external_url(url: String) -> Result<(), String> {
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

    #[tauri::command]
    pub fn save_canvas_image(data_url: String) -> Result<String, String> {
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

    // ── 실행 이력 ─────────────────────────────────────────────────────────────
    // ExecHistoryItem 은 db::models 로 이동(상단 재노출).

    #[tauri::command]
    pub fn exec_history_save(
        db: State<DbState>,
        language: String,
        code: String,
        stdout: String,
        stderr: String,
        exit_code: i64,
    ) -> Result<(), AppError> {
        let conn = db.0.lock()?;
        crate::db::exec_history::save(&conn, &language, &code, &stdout, &stderr, exit_code)
    }

    #[tauri::command]
    pub fn exec_history_list(db: State<DbState>) -> Result<Vec<ExecHistoryItem>, AppError> {
        let conn = db.0.lock()?;
        crate::db::exec_history::list(&conn)
    }

    #[tauri::command]
    pub fn exec_history_clear(db: State<DbState>) -> Result<(), AppError> {
        let conn = db.0.lock()?;
        crate::db::exec_history::clear(&conn)
    }

    // ── llama-server 관련 ─────────────────────────────────────────────────────

    #[derive(Debug, Serialize, Deserialize)]
    pub struct LlamaConfig {
        pub model: String,
        pub mmproj: Option<String>,
        pub model_draft: Option<String>,
        pub ngl: i32,
        pub flash_attn: bool,
        pub jinja: bool,
        pub ctk: String,
        pub ctv: String,
        pub context: i32,
        pub temp: f32,
        pub top_k: i32,
        pub top_p: f32,
        pub min_p: f32,
        pub port: i32,
        pub host: String,
        pub reasoning: String,
        pub reasoning_format: String,
        pub mtp_n_draft: Option<i32>,
    }

    #[tauri::command]
    pub fn llama_scan_models() -> Result<Vec<String>, String> {
        let home = dirs::home_dir().ok_or("홈 디렉토리를 찾을 수 없습니다")?;
        let mut files = vec![];

        // ~/models (flat)
        let models_dir = home.join("models");
        if models_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&models_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("gguf") {
                        files.push(path.to_string_lossy().to_string());
                    }
                }
            }
        }

        files.sort();
        Ok(files)
    }

    #[tauri::command]
    pub fn llama_start(
        config: LlamaConfig,
        server_state: State<LlamaServerState>,
    ) -> Result<(), String> {
        // 기존 서버 종료: 추적 중인 자식 + 포트를 선점 중인 고아(이전 앱이 SIGKILL 로
        // 죽어 남은 프로세스)까지 청소해야, 포트 충돌로 새 서버가 조용히 즉사하는 것을 막는다.
        {
            let mut guard = server_state.0.lock().map_err(|e| e.to_string())?;
            if let Some(ref mut child) = guard.child {
                child.kill().ok();
                child.wait().ok();
            }
            *guard = LlamaProc::default();
        }
        super::kill_port(config.port);

        let home = dirs::home_dir().ok_or("홈 디렉토리를 찾을 수 없습니다")?;
        let models_dir = home.join("models");
        let model_path = if std::path::Path::new(&config.model).is_absolute() {
            std::path::PathBuf::from(&config.model)
        } else {
            models_dir.join(&config.model)
        };

        // llama-server 바이너리 찾기 (brew 경로 포함)
        let binary = ["llama-server", "/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"]
            .iter()
            .find(|&&b| Command::new(b).arg("--version").output().is_ok())
            .map(|&b| b.to_string())
            .ok_or_else(|| "llama-server 바이너리를 찾을 수 없습니다. PATH나 Homebrew 설치를 확인해주세요.".to_string())?;

        let mut args: Vec<String> = vec![
            "--model".to_string(), model_path.to_string_lossy().to_string(),
            "-ngl".to_string(), config.ngl.to_string(),
            "-c".to_string(), config.context.to_string(),
            "--port".to_string(), config.port.to_string(),
            "--host".to_string(), config.host.clone(),
            "--temp".to_string(), config.temp.to_string(),
            "--top-k".to_string(), config.top_k.to_string(),
            "--top-p".to_string(), config.top_p.to_string(),
            "--min-p".to_string(), config.min_p.to_string(),
            "-ctk".to_string(), config.ctk.clone(),
            "-ctv".to_string(), config.ctv.clone(),
            "--reasoning".to_string(), config.reasoning.clone(),
            "--reasoning-format".to_string(), config.reasoning_format.clone(),
        ];

        if config.flash_attn {
            args.push("-fa".to_string());
            args.push("on".to_string());
        }
        if config.jinja {
            args.push("--jinja".to_string());
        }
        if let Some(n) = config.mtp_n_draft {
            if n > 0 {
                args.push("--spec-type".to_string());
                args.push("draft-mtp".to_string());
                args.push("--spec-draft-n-max".to_string());
                args.push(n.to_string());
            }
        }

        if let Some(draft) = &config.model_draft {
            if !draft.is_empty() {
                let draft_path = if std::path::Path::new(draft).is_absolute() {
                    std::path::PathBuf::from(draft)
                } else {
                    models_dir.join(draft)
                };
                if !draft_path.exists() {
                    return Err(format!("MTP 드래프트 모델 파일을 찾을 수 없습니다: {}\n설정에서 MTP 모델을 '없음'으로 변경해주세요.", draft));
                }
                args.push("--model-draft".to_string());
                args.push(draft_path.to_string_lossy().to_string());
            }
        }

        if let Some(mmproj) = &config.mmproj {
            if !mmproj.is_empty() {
                let mmproj_path = if std::path::Path::new(mmproj).is_absolute() {
                    std::path::PathBuf::from(mmproj)
                } else {
                    models_dir.join(mmproj)
                };
                if !mmproj_path.exists() {
                    return Err(format!("mmproj 파일을 찾을 수 없습니다: {}\n설정에서 mmproj를 '없음'으로 변경해주세요.", mmproj));
                }
                args.push("--mmproj".to_string());
                args.push(mmproj_path.to_string_lossy().to_string());
            }
        }

        let log_path = std::env::temp_dir().join("nekodesk_llama.log");
        let log_file = std::fs::File::create(&log_path)
            .map_err(|e| format!("로그 파일 생성 실패: {}", e))?;

        let mut child = Command::new(&binary)
            .args(&args)
            .stdout(Stdio::null())
            .stderr(log_file)
            .spawn()
            .map_err(|e| format!("서버 시작 실패: {}", e))?;

        // 800ms 후 즉시 종료 여부 확인
        thread::sleep(Duration::from_millis(800));
        if let Ok(Some(status)) = child.try_wait() {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            let excerpt: String = log.lines().rev().take(10).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(format!("서버가 즉시 종료됨 (exit {})\n{}", status.code().unwrap_or(-1), excerpt));
        }

        let mut guard = server_state.0.lock().map_err(|e| e.to_string())?;
        *guard = LlamaProc { child: Some(child), port: Some(config.port) };
        Ok(())
    }

    #[tauri::command]
    pub fn llama_stop(port: i32, server_state: State<LlamaServerState>) -> Result<(), String> {
        {
            let mut guard = server_state.0.lock().map_err(|e| e.to_string())?;
            if let Some(ref mut child) = guard.child {
                child.kill().ok();
                child.wait().ok();
            }
            *guard = LlamaProc::default();
        }
        // child handle이 없어도(고아·stale) 해당 포트를 점유 중인 프로세스 강제 종료
        kill_port(port);
        Ok(())
    }

    #[tauri::command]
    pub fn llama_is_running(server_state: State<LlamaServerState>) -> Result<bool, String> {
        let mut guard = server_state.0.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut child) = guard.child {
            match child.try_wait() {
                Ok(None) => Ok(true),   // 아직 실행 중
                _ => {
                    *guard = LlamaProc::default();
                    Ok(false)
                }
            }
        } else {
            Ok(false)
        }
    }

    // 가속도계(macimu Python subprocess)는 제거됨. M4 실증 결과 non-root 로는
    // HID 데이터를 못 받고 root 데몬이 필요해, 트랙패드 쓰다듬기 + haptic_feedback 으로 대체.

    #[cfg(test)]
    mod tests {
        use super::{truncate_chars, hard_blocked};

        #[test]
        fn hard_block_stops_worst_commands() {
            assert!(hard_blocked("sudo rm -rf /").is_some());
            assert!(hard_blocked("SUDO echo hi").is_some());          // 대소문자 무시
            assert!(hard_blocked("diskutil eraseDisk ...").is_some());
            assert!(hard_blocked("cat ~/.ssh/id_rsa").is_some());
            assert!(hard_blocked("display dialog \"x\" with administrator privileges").is_some());
        }

        #[test]
        fn hard_block_allows_normal_code() {
            assert!(hard_blocked("print('hello')").is_none());
            assert!(hard_blocked("date +%Y-%m-%d").is_none());
            assert!(hard_blocked("display notification \"회의 5분 전\"").is_none());
        }

        /// 한글은 UTF-8에서 3바이트다. 이전 구현은 `&s[..4000]`로 바이트 슬라이스를
        /// 했기 때문에 4000번째 바이트가 글자 중간이면 패닉했다.
        #[test]
        fn korean_output_truncates_without_panic() {
            let s = "가".repeat(2000); // 6000 bytes, 2000 chars
            let (out, truncated) = truncate_chars(s, 1500);
            assert!(truncated);
            assert_eq!(out.chars().count(), 1500 + "…(잘림)".chars().count());
        }

        #[test]
        fn emoji_truncates_on_char_boundary() {
            let (out, truncated) = truncate_chars("🐱".repeat(10), 5);
            assert!(truncated);
            assert!(out.starts_with(&"🐱".repeat(5)));
            assert!(!out.contains("\u{FFFD}")); // 깨진 문자 없음
        }

        #[test]
        fn short_output_passes_through_untouched() {
            let (out, truncated) = truncate_chars("안녕 🐱".to_string(), 100);
            assert!(!truncated);
            assert_eq!(out, "안녕 🐱");
        }

        /// 경계값: 정확히 max_chars 면 자르지 않는다.
        #[test]
        fn exact_length_is_not_truncated() {
            let (out, truncated) = truncate_chars("가나다".to_string(), 3);
            assert!(!truncated);
            assert_eq!(out, "가나다");
        }
    }
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
            }
        });
}
