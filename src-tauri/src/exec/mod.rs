//! 로컬 코드 실행.
//!
//! 실행 자체(프로세스 spawn, 출력 수집, 타임아웃)와 하드 게이트(`guard`)를 함께 둔다.
//! 예전에는 이 전부가 lib.rs 의 커맨드 모듈 안에 인라인으로 있었다.

pub mod guard;

use crate::error::AppError;
use crate::CodeExecResult;
use base64::{engine::general_purpose, Engine as _};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

/// 실행 결과물이 모이는 네코 전용 디렉터리. work_dir 을 안 주면 여기서 실행한다.
/// 상대 경로로 저장한 파일이 전부 여기로 모여서, 홈이 잡동사니로 더러워지지 않고
/// /tmp 처럼 OS 가 언제 비울지 모르는 곳에 결과물이 남지도 않는다.
fn output_dir() -> PathBuf {
    let dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".nekodesk/output");
    std::fs::create_dir_all(&dir).ok();
    dir
}

/// svg 도 그대로 `<img>` 로 렌더된다. 작은 모델은 PIL 도형 조합보다 SVG 를 훨씬
/// 잘 쓰므로(곡선·대칭·그라디언트) 그림 품질이 여기서 갈린다.
const IMG_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "svg"];

/// 디렉터리 한 겹에서 `since` 이후에 쓰인 이미지 중 가장 최신 것.
fn newest_image_in(dir: &Path, since: SystemTime) -> Option<(SystemTime, PathBuf)> {
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
        if !ext.as_deref().is_some_and(|e| IMG_EXTS.contains(&e)) { continue; }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else { continue };
        if modified < since { continue; }
        if newest.as_ref().map_or(true, |(t, _)| modified > *t) {
            newest = Some((modified, path));
        }
    }
    newest
}

/// 이번 실행 중에 새로 생긴 이미지를 줍는다.
///
/// 예전에는 `/tmp/neko_output.png` 한 경로만 봤다. 작은 모델은 그 파일명 계약을
/// 자주 어겨서(실제로 `/tmp/bunsen.png` 에 저장했다) 그림을 그려놓고도 채팅에
/// 안 실렸다. 파일명 대신 "실행 중에 생긴 이미지"로 조건을 바꿔 계약을 없앴다.
///
/// 작업 디렉터리뿐 아니라 `/tmp` 도 훑는다. 4B 급 모델은 출력 폴더를 쓰라고 해도
/// `/tmp/...` 절대 경로를 하드코딩한다(실측). 프롬프트로는 못 이기는 습관이라
/// 주워오는 쪽에서 받는다. `/tmp` 에서 주운 건 출력 폴더로 옮긴다 — OS 가 /tmp 를
/// 언제 비울지 모른다.
///
/// ponytail: 두 디렉터리의 한 겹씩만 본다. 하위 폴더나 제3의 경로는 여전히 못 줍는다.
/// 실행 창 안에 다른 프로세스가 /tmp 에 이미지를 쓰면 그걸 집을 수 있다(희박).
fn collect_output_image(dir: &Path, since: SystemTime) -> Option<String> {
    let tmp = std::env::temp_dir();
    let mut best = newest_image_in(dir, since);
    if tmp != dir {
        if let Some(found) = newest_image_in(&tmp, since) {
            if best.as_ref().map_or(true, |(t, _)| found.0 > *t) { best = Some(found); }
        }
    }
    let (_, mut path) = best?;

    if path.parent() != Some(dir) {
        if let Some(name) = path.file_name() {
            let dest = dir.join(name);
            if std::fs::rename(&path, &dest).is_ok() { path = dest; }
        }
    }

    let data = std::fs::read(&path).ok()?;
    let mime = match path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "image/png",
    };
    Some(format!("data:{mime};base64,{}", general_purpose::STANDARD.encode(&data)))
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
    // 실행 전에 찍어둔다. 이 시각 이후에 생긴 이미지만 이번 실행의 결과물이다.
    let started = SystemTime::now();

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
            .unwrap_or_else(output_dir);

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
        let image_data_url = collect_output_image(&dir, started);
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
        .unwrap_or_else(output_dir);

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

    let image_data_url = collect_output_image(&dir, started);
    Ok(CodeExecResult { stdout, stderr, exit_code, truncated, image_data_url })
}

#[cfg(test)]
mod tests {
    use super::{collect_output_image, truncate_chars};
    use std::time::{Duration, SystemTime};

    /// 파일명 계약을 없앤 게 핵심이다. 아무 이름이어도 줍고, 실행 전부터 있던
    /// 이미지는 안 줍고, 이미지가 아닌 파일은 무시해야 한다.
    #[test]
    fn picks_newest_image_created_during_run() {
        let dir = std::env::temp_dir().join(format!("neko_img_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(dir.join("stale.png"), b"old").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        let since = SystemTime::now();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(dir.join("notes.txt"), b"ignore me").unwrap();
        std::fs::write(dir.join("bunsen.jpg"), b"new").unwrap();

        let got = collect_output_image(&dir, since).expect("이번 실행에 생긴 이미지를 주워야 한다");
        assert!(got.starts_with("data:image/jpeg;base64,"), "got {got}");

        // 실행 전에 있던 이미지만 남은 경우엔 아무것도 안 줍는다.
        std::fs::remove_file(dir.join("bunsen.jpg")).unwrap();
        assert!(collect_output_image(&dir, since).is_none());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 모델이 출력 폴더를 무시하고 /tmp 에 절대 경로로 저장하는 실제 사례.
    /// 주워오기도 해야 하고, 결과물이 출력 폴더로 옮겨져 있어야 한다.
    #[test]
    fn rescues_image_the_model_dropped_in_tmp() {
        let dir = std::env::temp_dir().join(format!("neko_tmp_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stray = std::env::temp_dir().join(format!("nekodesk_selfportrait_{}.png", std::process::id()));

        let since = SystemTime::now();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&stray, b"drawn").unwrap();

        let got = collect_output_image(&dir, since).expect("/tmp 에 떨어진 것도 주워야 한다");
        assert!(got.starts_with("data:image/png;base64,"), "got {got}");
        assert!(!stray.exists(), "/tmp 원본은 출력 폴더로 옮겨져야 한다");
        assert!(dir.join(stray.file_name().unwrap()).exists());

        std::fs::remove_file(&stray).ok();
        std::fs::remove_dir_all(&dir).ok();
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
