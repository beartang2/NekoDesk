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
    prune_old(&dir, SystemTime::now());
    dir
}

/// 그림 도구 모듈. 코드 실행마다 PYTHONPATH 에 넣어, 그림 스킬 문서가 함수 본문 70줄 대신
/// `from neko_draw import *` 한 줄만 쓰게 한다 — 모델이 매번 읽고 베껴 쓰던 분량이다.
const NEKO_DRAW: &str = include_str!("neko_draw.py");

/// neko_draw.py 가 있는 폴더(~/.nekodesk/lib). 앱에 든 것과 다르면(업데이트·누가 고침) 다시 쓴다.
/// 출력 폴더와 따로 둔다 — 그쪽은 30일 지나면 지운다.
fn lib_dir() -> PathBuf {
    let dir = dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".nekodesk/lib");
    let file = dir.join("neko_draw.py");
    if std::fs::read_to_string(&file).ok().as_deref() != Some(NEKO_DRAW) {
        let _ = std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&file, NEKO_DRAW));
    }
    dir
}

/// lib_dir 을 앞에 둔 PYTHONPATH. 사용자가 원래 쓰던 값은 뒤에 남긴다.
fn python_path() -> std::ffi::OsString {
    let mut paths = vec![lib_dir()];
    if let Some(old) = std::env::var_os("PYTHONPATH") {
        paths.extend(std::env::split_paths(&old));
    }
    std::env::join_paths(paths).unwrap_or_default()
}

/// 출력 폴더에서 이만큼 안 바뀐 파일은 지운다. 채팅은 이미지를 data URL 로 들고 있어서
/// 파일이 없어져도 옛 대화가 안 깨진다.
const OUTPUT_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// ponytail: 한 겹의 파일만 지운다. 하위 폴더와 심볼릭 링크는 그대로 둔다.
fn prune_old(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() { continue; }
        let age = meta.modified().ok().and_then(|m| now.duration_since(m).ok());
        if age.is_some_and(|a| a > OUTPUT_TTL) {
            std::fs::remove_file(entry.path()).ok();
        }
    }
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
/// 실행할 폴더. 없으면 출력 폴더. `~` 는 홈으로 푼다 — 모델은 `~/…` 로 자주 넘기는데, 그대로
/// 두면 없는 폴더라 실행이 시작도 못 하고 "python3 가 없다" 는 엉뚱한 오류가 났다.
fn run_dir(work_dir: Option<&str>) -> Result<PathBuf, AppError> {
    let Some(raw) = work_dir.map(str::trim).filter(|d| !d.is_empty()) else { return Ok(output_dir()) };
    let dir = match raw.strip_prefix("~") {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            dirs::home_dir().unwrap_or_default().join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(raw),
    };
    if dir.is_dir() {
        Ok(dir)
    } else {
        Err(AppError::msg(format!("work_dir 폴더가 없어: {}. 빼면 출력 폴더에서 실행해.", dir.display())))
    }
}

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

        let dir = run_dir(work_dir)?;

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

    let dir = run_dir(work_dir)?;

    let mut child = Command::new(interpreter)
        .arg(flag)
        .arg(&code)
        .current_dir(&dir)
        .env("PYTHONPATH", python_path())
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
    use super::{collect_output_image, prune_old, python_path, run_dir, truncate_chars, OUTPUT_TTL};
    use std::time::{Duration, SystemTime};

    /// 앱에 든 그림 모듈이 실제로 import 되고, 도형 태그 없이 path 만 만든다.
    #[test]
    fn neko_draw_imports_on_python_path() {
        let out = std::process::Command::new("python3")
            // 점 두 개짜리 선도 제어점이 직선(y=0) 밖에 있어야 — 자로 그은 직선은 못 그린다
            .args(["-c", "from neko_draw import *\nimport re\nc = [float(v) for v in re.findall(r'-?[0-9.]+', smooth([(0, 0), (1000, 0)], False))]\nassert c[3] != 0 and c[5] != 0, c\nprint(shape(ring(50, 50, 20), '#fff', dark='#ccc', gaps=[2]) + eye(50, 50, 20))"])
            .env("PYTHONPATH", python_path())
            .output()
            .expect("python3");
        let svg = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert!(svg.contains("<path") && !svg.contains("<circle"), "{svg}");
    }

    #[test]
    fn work_dir_expands_tilde_and_rejects_missing() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(run_dir(Some("~")).unwrap(), home);
        assert_eq!(run_dir(Some(" ~/ ")).unwrap(), home);
        let tmp = std::env::temp_dir();
        assert_eq!(run_dir(Some(tmp.to_str().unwrap())).unwrap(), tmp);
        let err = run_dir(Some("~/no-such-nekodesk-dir")).unwrap_err().to_string();
        assert!(err.contains("work_dir 폴더가 없어"), "{err}");
        assert!(!err.contains('~'), "홈을 푼 경로를 보여 준다: {err}");
        assert!(run_dir(None).unwrap().ends_with(".nekodesk/output"));
    }

    /// 30일 넘은 파일만 지우고, 새 파일과 하위 폴더는 남긴다.
    #[test]
    fn prunes_only_files_older_than_ttl() {
        let dir = std::env::temp_dir().join(format!("neko_prune_test_{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("old.png"), b"old").unwrap();
        std::fs::write(dir.join("new.png"), b"new").unwrap();
        let old = SystemTime::now() - OUTPUT_TTL - Duration::from_secs(60);
        std::fs::File::options().write(true).open(dir.join("old.png")).unwrap().set_modified(old).unwrap();

        prune_old(&dir, SystemTime::now());

        assert!(!dir.join("old.png").exists());
        assert!(dir.join("new.png").exists());
        assert!(dir.join("sub").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

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
