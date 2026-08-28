//! 로컬 코드 실행.
//!
//! 실행 자체(프로세스 spawn, 출력 수집, 타임아웃)와 하드 게이트(`guard`)를 함께 둔다.
//! 예전에는 이 전부가 lib.rs 의 커맨드 모듈 안에 인라인으로 있었다.

pub mod guard;

use crate::error::AppError;
use crate::CodeExecResult;
use base64::{engine::general_purpose, Engine as _};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// Python 이 그림을 저장하도록 안내하는 고정 경로. 실행 후 채팅에 실려 나간다.
const NEKO_IMG_PATH: &str = "/tmp/neko_output.png";

fn collect_output_image() -> Option<String> {
    let path = std::path::Path::new(NEKO_IMG_PATH);
    if !path.exists() { return None; }
    let data = std::fs::read(path).ok()?;
    std::fs::remove_file(path).ok();
    Some(format!("data:image/png;base64,{}", general_purpose::STANDARD.encode(&data)))
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

/// `approved` 는 프런트엔드가 승인 절차를 실제로 거쳤다는 뜻이다.
///
/// fs_write/fs_edit 과 같은 계약이다. 확인 다이얼로그를 띄우는 판단은 렌더러가
/// 하지만, **거치지 않은 호출은 백엔드가 거부한다** — 게이트를 빠뜨린 코드 경로가
/// 조용히 실행되는 대신 실패하도록. 하드 차단은 `approved` 와 무관하게 항상 막는다.
pub fn run(
    code: &str,
    language: Option<&str>,
    work_dir: Option<&str>,
    approved: bool,
) -> Result<CodeExecResult, AppError> {
    if let Some(reason) = guard::hard_blocked(code) {
        return Err(AppError::msg(format!("보안상 차단된 명령이야: {reason}. 이건 실행할 수 없어.")));
    }
    if !approved {
        return Err(AppError::msg("승인 절차를 거치지 않은 실행 요청이야."));
    }
    let lang = language.unwrap_or("python");

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
            .map_err(|e| AppError::msg(format!("AppleScript 임시 파일 생성 실패: {e}")))?;

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
            .map_err(|e| AppError::msg(format!("실행 실패: {e}. osascript 가 설치되어 있는지 확인해줘.")))?;

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
            match child.try_wait().map_err(|e| AppError::msg(format!("프로세스 대기 실패: {e}")))? {
                Some(status) => break status.code().unwrap_or(-1),
                None => {
                    if start.elapsed() > timeout {
                        child.kill().ok();
                        std::fs::remove_file(&tmp_path).ok();
                        return Err(AppError::msg("AppleScript 실행 시간 초과 (30초)"));
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
        other => return Err(AppError::msg(format!("지원하지 않는 언어: {other}. python, shell 또는 applescript를 사용해줘."))),
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
        .map_err(|e| AppError::msg(format!("실행 실패: {}. {} 가 설치되어 있는지 확인해줘.", e, interpreter)))?;

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
        match child.try_wait().map_err(|e| AppError::msg(e.to_string()))? {
            Some(status) => break status.code().unwrap_or(-1),
            None => {
                if start.elapsed() > timeout {
                    child.kill().ok();
                    return Err(AppError::msg("실행 시간 초과 (30초)"));
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

#[cfg(test)]
mod tests {
    use super::truncate_chars;

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
