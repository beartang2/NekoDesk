//! 파일 읽기·쓰기·검색.
//!
//! 예전에는 파일 작업이 전부 `code.exec` 로 셸/파이썬을 짜서 나갔다. 정확한 문자열
//! 치환도, 줄 단위 참조도, 안전한 경계도 없었다. 여기서는 각 연산을 툴로 노출하고
//! 경로 정책(`guard`)을 한 곳에서 강제한다.

pub mod guard;

use crate::error::{AppError, AppResult};
use guard::Decision;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 한 번에 읽어 들일 최대 줄 수. 컨텍스트를 통째로 태우는 것을 막는다.
const DEFAULT_READ_LIMIT: usize = 2000;
/// 한 줄이 이보다 길면 자른다 (minified 번들 한 줄이 수 MB 인 경우).
const MAX_LINE_CHARS: usize = 2000;
/// 파일 자체가 이보다 크면 읽지 않는다.
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Serialize, Debug)]
pub struct FsReadResult {
    /// `   12→내용` 형태로 줄번호가 붙은 본문. 모델이 fs.edit 대상을 지목하기 쉽다.
    pub content: String,
    pub total_lines: usize,
    pub truncated: bool,
}

/// 쓰기·수정의 결과.
///
/// `preview` 가 핵심이다. 예전에는 "저장됨" 한 줄만 돌려줘서, 모델이 파일에 실제로
/// 무엇이 남았는지 **한 번도 보지 못한 채** 완료를 보고했다. 되읽은 내용을 증거로
/// 함께 주면 "썼다고 했는데 안 씀" 류가 구조적으로 막힌다. 파일 전체를 되돌리면
/// 컨텍스트를 태우므로 앞뒤 몇 줄만 싣는다.
#[derive(Serialize, Debug)]
pub struct FsWriteResult {
    pub path: String,
    pub bytes: usize,
    pub lines: usize,
    pub preview: String,
}

#[derive(Serialize, Debug)]
pub struct FsEditResult {
    pub replaced: usize,
    /// 바뀐 자리 주변을 줄번호와 함께. 의도대로 바뀌었는지 모델이 직접 본다.
    pub preview: String,
}

#[derive(Serialize)]
pub struct FsGrepHit {
    pub path: String,
    pub line_no: usize,
    pub text: String,
}

#[derive(Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 프런트엔드로 넘기는 접근 판정.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FsDecision {
    Allow { path: String },
    Confirm { path: String },
    Deny { path: String, reason: String },
}

fn home() -> AppResult<PathBuf> {
    dirs::home_dir().ok_or_else(|| AppError::msg("홈 디렉토리를 찾을 수 없어"))
}

fn resolve(raw: &str) -> AppResult<PathBuf> {
    let home = home()?;
    guard::resolve(raw, &home).map_err(|e| AppError::msg(format!("경로를 확인할 수 없어: {e}")))
}

/// 승인된 쓰기 루트 목록.
///
/// 대상 경로는 `resolve` 로 심볼릭 링크가 풀린 상태라, 루트도 같은 방식으로
/// 풀어야 비교가 성립한다. macOS 에서 `/var` 는 `/private/var` 의 링크이므로
/// 정규화를 빼먹으면 승인된 루트가 **한 번도 매칭되지 않아** 매번 확인을 묻게 된다.
fn roots_from(json: &str) -> Vec<PathBuf> {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    serde_json::from_str::<Vec<String>>(json)
        .unwrap_or_default()
        .iter()
        .filter_map(|raw| guard::resolve(raw, &home).ok())
        .collect()
}

/// 판정하고, 통과하지 못하면 에러로 바꾼다.
///
/// `approved` 는 프런트엔드가 사용자 확인을 실제로 받았다는 뜻이다. 하드 차단은
/// `approved` 와 무관하게 항상 거부한다 — 확인 창을 클릭하게 만드는 것 자체가
/// 프롬프트 인젝션의 목표이므로, 자격증명 경로는 애초에 선택지에 없어야 한다.
fn require(path: &Path, write: bool, write_roots_json: &str, approved: bool) -> AppResult<()> {
    match guard::classify(path, write, &roots_from(write_roots_json)) {
        Decision::Allow => Ok(()),
        Decision::Deny(reason) => Err(AppError::msg(reason)),
        Decision::Confirm if approved => Ok(()),
        Decision::Confirm => Err(AppError::msg(
            "승인되지 않은 위치에 쓰려고 했어. 사용자 확인이 필요해.",
        )),
    }
}

/// 줄번호를 붙인다. 폭을 맞춰 모델이 줄 경계를 헷갈리지 않게 한다.
fn number_lines(lines: &[&str], start: usize) -> String {
    lines
        .iter()
        .enumerate()
        .map(|(i, line)| {
            let truncated: String = if line.chars().count() > MAX_LINE_CHARS {
                let head: String = line.chars().take(MAX_LINE_CHARS).collect();
                format!("{head}… (줄 잘림)")
            } else {
                (*line).to_string()
            };
            format!("{:>6}→{}", start + i + 1, truncated)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn read(path: &str, offset: Option<usize>, limit: Option<usize>) -> AppResult<FsReadResult> {
    let resolved = resolve(path)?;
    require(&resolved, false, "[]", false)?;

    let meta = std::fs::metadata(&resolved)
        .map_err(|e| AppError::msg(format!("파일을 열 수 없어: {e}")))?;
    if meta.is_dir() {
        return Err(AppError::msg("디렉토리야. fs.list 를 써."));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::msg(format!(
            "파일이 너무 커 ({} MB). 20MB 까지만 읽을 수 있어.",
            meta.len() / 1024 / 1024
        )));
    }

    let raw = std::fs::read(&resolved).map_err(|e| AppError::msg(format!("읽기 실패: {e}")))?;
    let text = String::from_utf8_lossy(&raw);
    let all: Vec<&str> = text.lines().collect();

    let start = offset.unwrap_or(0).min(all.len());
    let take = limit.unwrap_or(DEFAULT_READ_LIMIT);
    let end = start.saturating_add(take).min(all.len());

    Ok(FsReadResult {
        content: number_lines(&all[start..end], start),
        total_lines: all.len(),
        truncated: end < all.len(),
    })
}

/// 앞 N줄과 마지막 줄을 줄번호와 함께. 가운데는 생략한다.
fn head_tail_preview(text: &str, head: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() <= head + 1 {
        return number_lines(&lines, 0);
    }
    format!(
        "{}\n     …\n{}",
        number_lines(&lines[..head], 0),
        number_lines(&lines[lines.len() - 1..], lines.len() - 1)
    )
}

/// 특정 바이트 오프셋 주변 줄들을 줄번호와 함께.
fn around_offset(text: &str, offset: usize, context: usize) -> String {
    let line_index = text[..offset.min(text.len())].matches('\n').count();
    let lines: Vec<&str> = text.lines().collect();
    let start = line_index.saturating_sub(context);
    let end = (line_index + context + 1).min(lines.len());
    number_lines(&lines[start..end], start)
}

pub fn write(path: &str, content: &str, write_roots: &str, approved: bool) -> AppResult<FsWriteResult> {
    let resolved = resolve(path)?;
    require(&resolved, true, write_roots, approved)?;

    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::msg(format!("디렉토리를 만들 수 없어: {e}")))?;
    }
    std::fs::write(&resolved, content).map_err(|e| AppError::msg(format!("쓰기 실패: {e}")))?;

    // 되읽어 확인한다. write 가 Ok 를 줬다고 디스크에 그게 남았다는 뜻은 아니다
    // (용량 부족, 다른 프로세스와의 경합 등). 여기서 걸러야 모델이 잘못된 완료를
    // 보고하지 않는다.
    let written = std::fs::read(&resolved)
        .map_err(|e| AppError::msg(format!("쓴 내용을 되읽을 수 없어: {e}")))?;
    if written != content.as_bytes() {
        return Err(AppError::msg(format!(
            "쓰기 후 내용이 일치하지 않아 (쓴 크기 {}B, 파일 크기 {}B). 저장에 실패했어.",
            content.len(),
            written.len()
        )));
    }

    Ok(FsWriteResult {
        path: resolved.to_string_lossy().into_owned(),
        bytes: written.len(),
        lines: content.lines().count(),
        preview: head_tail_preview(content, 5),
    })
}

/// 정확히 일치하는 문자열을 바꾼다.
///
/// 유일하지 않으면 **거부한다**. 모델이 "두 번째 것" 을 노렸는데 첫 번째가 바뀌는
/// 사고를 막는다. 여러 개를 정말 바꾸려면 replace_all 을 명시해야 한다.
pub fn edit(
    path: &str,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    write_roots: &str,
    approved: bool,
) -> AppResult<FsEditResult> {
    if old_string.is_empty() {
        return Err(AppError::msg("바꿀 문자열이 비어 있어"));
    }
    if old_string == new_string {
        return Err(AppError::msg("바꿀 문자열과 새 문자열이 같아"));
    }

    let resolved = resolve(path)?;
    require(&resolved, true, write_roots, approved)?;

    let text = std::fs::read_to_string(&resolved)
        .map_err(|e| AppError::msg(format!("읽기 실패: {e}")))?;
    let count = text.matches(old_string).count();

    match count {
        0 => Err(AppError::msg(
            "그 문자열을 찾을 수 없어. fs.read 로 실제 내용을 다시 확인해.",
        )),
        _ if count > 1 && !replace_all => Err(AppError::msg(format!(
            "{count}군데에서 일치해. 앞뒤 줄을 더 붙여 유일하게 만들거나 replace_all 을 써."
        ))),
        _ => {
            let updated = if replace_all {
                text.replace(old_string, new_string)
            } else {
                text.replacen(old_string, new_string, 1)
            };
            std::fs::write(&resolved, &updated)
                .map_err(|e| AppError::msg(format!("쓰기 실패: {e}")))?;

            // 되읽어 확인. 의도한 문자열이 실제로 들어갔는지 본다.
            let after = std::fs::read_to_string(&resolved)
                .map_err(|e| AppError::msg(format!("수정한 내용을 되읽을 수 없어: {e}")))?;
            if after != updated {
                return Err(AppError::msg("수정 후 내용이 일치하지 않아. 저장에 실패했어."));
            }
            let offset = after.find(new_string).ok_or_else(|| {
                AppError::msg("수정했는데 새 문자열이 파일에 없어. 저장에 실패했어.")
            })?;

            Ok(FsEditResult {
                replaced: if replace_all { count } else { 1 },
                preview: around_offset(&after, offset, 3),
            })
        }
    }
}

pub fn list(path: &str) -> AppResult<Vec<FsEntry>> {
    let resolved = resolve(path)?;
    require(&resolved, false, "[]", false)?;

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&resolved)
        .map_err(|e| AppError::msg(format!("디렉토리를 열 수 없어: {e}")))?
    {
        let Ok(entry) = entry else { continue };
        let meta = entry.metadata().ok();
        let full = entry.path();
        // 목록에서도 민감 경로는 숨긴다 — 존재 여부 자체가 힌트가 된다.
        if guard::blocked_reason(&full).is_some() {
            continue;
        }
        out.push(FsEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: full.to_string_lossy().into_owned(),
            is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
        });
    }
    out.sort_by(|a, b| (b.is_dir, a.name.to_lowercase()).cmp(&(a.is_dir, b.name.to_lowercase())));
    Ok(out)
}

pub fn check(path: &str, write: bool, write_roots: &str) -> AppResult<FsDecision> {
    let resolved = resolve(path)?;
    let shown = resolved.to_string_lossy().into_owned();
    Ok(match guard::classify(&resolved, write, &roots_from(write_roots)) {
        Decision::Allow => FsDecision::Allow { path: shown },
        Decision::Confirm => FsDecision::Confirm { path: shown },
        Decision::Deny(reason) => FsDecision::Deny { path: shown, reason },
    })
}

// ── glob / grep ───────────────────────────────────────────────────────────────

/// 최대 결과 수. 넘치면 잘라서 돌려준다 (모델 컨텍스트 보호).
const MAX_MATCHES: usize = 200;

fn walker(base: &Path) -> ignore::Walk {
    // .gitignore 를 존중해 node_modules·target 같은 잡음을 자동으로 뺀다.
    ignore::WalkBuilder::new(base)
        .hidden(false) // 숨김 파일도 본다 (.github 등). 민감 경로는 guard 가 막는다.
        .follow_links(false) // 링크를 따라가면 차단 경로로 새어 나갈 수 있다.
        .build()
}

pub fn glob(pattern: &str, base: Option<&str>) -> AppResult<Vec<String>> {
    let root = resolve(base.unwrap_or("."))?;
    require(&root, false, "[]", false)?;

    let matcher = globset::Glob::new(pattern)
        .map_err(|e| AppError::msg(format!("잘못된 glob 패턴이야: {e}")))?
        .compile_matcher();

    let mut hits: Vec<(std::time::SystemTime, String)> = Vec::new();
    for entry in walker(&root) {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if guard::blocked_reason(path).is_some() {
            continue;
        }
        // 절대경로와 base 상대경로 둘 다에 매칭시킨다. 모델이 "*.png" 처럼
        // 파일명만 주는 경우와 "src/**/*.ts" 처럼 상대경로를 주는 경우가 섞인다.
        let relative = path.strip_prefix(&root).unwrap_or(path);
        if !(matcher.is_match(path) || matcher.is_match(relative)) {
            continue;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .unwrap_or(std::time::UNIX_EPOCH);
        hits.push((mtime, path.to_string_lossy().into_owned()));
        if hits.len() >= MAX_MATCHES * 4 {
            break;
        }
    }

    // 최근 수정 순 — 찾는 파일은 보통 최근에 건드린 것이다.
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(hits.into_iter().take(MAX_MATCHES).map(|(_, p)| p).collect())
}

pub fn grep(
    pattern: &str,
    base: Option<&str>,
    file_glob: Option<&str>,
    max_results: Option<usize>,
) -> AppResult<Vec<FsGrepHit>> {
    let root = resolve(base.unwrap_or("."))?;
    require(&root, false, "[]", false)?;

    let re = regex::Regex::new(pattern)
        .map_err(|e| AppError::msg(format!("잘못된 정규식이야: {e}")))?;
    let file_matcher = match file_glob {
        Some(g) => Some(
            globset::Glob::new(g)
                .map_err(|e| AppError::msg(format!("잘못된 glob 패턴이야: {e}")))?
                .compile_matcher(),
        ),
        None => None,
    };
    let limit = max_results.unwrap_or(MAX_MATCHES).min(MAX_MATCHES);

    let mut hits = Vec::new();
    for entry in walker(&root) {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if guard::blocked_reason(path).is_some() {
            continue;
        }
        if let Some(m) = &file_matcher {
            let relative = path.strip_prefix(&root).unwrap_or(path);
            if !(m.is_match(path) || m.is_match(relative)) {
                continue;
            }
        }
        if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(false) {
            continue;
        }
        let Ok(raw) = std::fs::read(path) else { continue };
        // 바이너리는 건너뛴다 — NUL 이 있으면 텍스트가 아니다.
        if raw.iter().take(8000).any(|b| *b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&raw);
        for (i, line) in text.lines().enumerate() {
            if !re.is_match(line) {
                continue;
            }
            hits.push(FsGrepHit {
                path: path.to_string_lossy().into_owned(),
                line_no: i + 1,
                text: line.chars().take(MAX_LINE_CHARS).collect(),
            });
            if hits.len() >= limit {
                return Ok(hits);
            }
        }
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트용 임시 디렉토리. 이름에 테스트명을 넣어 병렬 실행에서 안 겹치게 한다.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neko_fs_{}_{}", std::process::id(), tag));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn roots_json(dir: &Path) -> String {
        serde_json::to_string(&vec![dir.to_string_lossy().into_owned()]).unwrap()
    }

    #[test]
    fn read_numbers_lines_and_reports_total() {
        let dir = temp_dir("read");
        let file = dir.join("a.txt");
        std::fs::write(&file, "첫줄\n둘째줄\n셋째줄\n").unwrap();

        let r = read(file.to_str().unwrap(), None, None).unwrap();
        assert_eq!(r.total_lines, 3);
        assert!(!r.truncated);
        assert!(r.content.starts_with("     1→첫줄"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_respects_offset_and_limit() {
        let dir = temp_dir("offset");
        let file = dir.join("b.txt");
        std::fs::write(&file, (1..=10).map(|i| i.to_string()).collect::<Vec<_>>().join("\n")).unwrap();

        let r = read(file.to_str().unwrap(), Some(2), Some(3)).unwrap();
        assert!(r.truncated);
        // offset 2 → 3번째 줄부터. 줄번호는 1-기반으로 이어져야 한다.
        assert!(r.content.starts_with("     3→3"), "{}", r.content);
        assert_eq!(r.content.lines().count(), 3);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn edit_refuses_ambiguous_matches() {
        let dir = temp_dir("ambiguous");
        let file = dir.join("c.txt");
        std::fs::write(&file, "x = 1\nx = 1\n").unwrap();
        let roots = roots_json(&dir);

        let err = edit(file.to_str().unwrap(), "x = 1", "x = 2", false, &roots, false)
            .unwrap_err()
            .to_string();
        assert!(err.contains("2군데"), "{err}");
        // 거부됐으면 파일은 그대로여야 한다.
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "x = 1\nx = 1\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_returns_proof_of_what_landed() {
        let dir = temp_dir("writeproof");
        let file = dir.join("p.txt");
        let body = (1..=20).map(|i| format!("줄 {i}")).collect::<Vec<_>>().join("\n");

        let r = write(file.to_str().unwrap(), &body, &roots_json(&dir), false).unwrap();

        assert_eq!(r.lines, 20);
        assert_eq!(r.bytes, body.len());
        // 앞부분과 마지막 줄이 줄번호와 함께 실려야 모델이 실제 결과를 볼 수 있다.
        assert!(r.preview.contains("     1→줄 1"), "{}", r.preview);
        assert!(r.preview.contains("줄 20"), "{}", r.preview);
        // 가운데는 생략 — 파일 전체를 되돌리면 컨텍스트를 태운다.
        assert!(r.preview.contains('…'));
        assert!(!r.preview.contains("줄 10"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn short_writes_come_back_whole() {
        let dir = temp_dir("shortwrite");
        let file = dir.join("s.txt");
        let r = write(file.to_str().unwrap(), "한 줄", &roots_json(&dir), false).unwrap();
        assert!(r.preview.contains("한 줄"));
        assert!(!r.preview.contains('…'));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn edit_shows_the_changed_line_in_place() {
        let dir = temp_dir("editproof");
        let file = dir.join("e2.txt");
        let body = (1..=20).map(|i| format!("줄 {i}")).collect::<Vec<_>>().join("\n");
        std::fs::write(&file, &body).unwrap();

        let r = edit(file.to_str().unwrap(), "줄 12", "바뀐 줄", false, &roots_json(&dir), false)
            .unwrap();

        assert_eq!(r.replaced, 1);
        // 바뀐 줄과 앞뒤 맥락이 줄번호와 함께 보여야 한다.
        assert!(r.preview.contains("바뀐 줄"), "{}", r.preview);
        assert!(r.preview.contains("줄 11"), "{}", r.preview);
        assert!(r.preview.contains("줄 13"), "{}", r.preview);
        // 파일 전체는 아니다.
        assert!(!r.preview.contains("줄 3"), "{}", r.preview);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn edit_at_the_first_line_does_not_underflow() {
        let dir = temp_dir("editfirst");
        let file = dir.join("e3.txt");
        std::fs::write(&file, "첫 줄\n둘째 줄\n").unwrap();

        let r = edit(file.to_str().unwrap(), "첫 줄", "바뀜", false, &roots_json(&dir), false)
            .unwrap();
        assert!(r.preview.contains("     1→바뀜"), "{}", r.preview);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn edit_replaces_all_when_asked() {
        let dir = temp_dir("replaceall");
        let file = dir.join("d.txt");
        std::fs::write(&file, "a\na\na\n").unwrap();
        let roots = roots_json(&dir);

        let r = edit(file.to_str().unwrap(), "a", "b", true, &roots, false).unwrap();
        assert_eq!(r.replaced, 3);
        assert!(r.preview.contains('b'));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "b\nb\nb\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn edit_reports_missing_string_without_touching_the_file() {
        let dir = temp_dir("missing");
        let file = dir.join("e.txt");
        std::fs::write(&file, "hello\n").unwrap();
        let roots = roots_json(&dir);

        assert!(edit(file.to_str().unwrap(), "없는문자열", "x", false, &roots, false).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_outside_approved_roots_is_refused_without_approval() {
        let dir = temp_dir("unapproved");
        let file = dir.join("f.txt");

        assert!(write(file.to_str().unwrap(), "x", "[]", false).is_err());
        assert!(!file.exists());
        // 사용자 확인을 받았으면 통과한다.
        write(file.to_str().unwrap(), "x", "[]", true).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "x");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn approval_cannot_unlock_a_blocked_path() {
        let dir = temp_dir("blocked");
        let file = dir.join(".env");
        assert!(write(file.to_str().unwrap(), "SECRET=1", "[]", true).is_err());
        assert!(!file.exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn write_creates_missing_parent_directories() {
        let dir = temp_dir("mkdirp");
        let file = dir.join("deep/nested/g.txt");
        write(file.to_str().unwrap(), "ok", &roots_json(&dir), false).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "ok");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn glob_finds_by_extension_and_skips_secrets() {
        let dir = temp_dir("glob");
        std::fs::write(dir.join("one.png"), "x").unwrap();
        std::fs::write(dir.join("two.png"), "x").unwrap();
        std::fs::write(dir.join("note.txt"), "x").unwrap();
        std::fs::write(dir.join("key.pem"), "x").unwrap();

        let hits = glob("*.png", Some(dir.to_str().unwrap())).unwrap();
        assert_eq!(hits.len(), 2);

        // 비밀 파일은 패턴이 맞아도 결과에 없다.
        let secrets = glob("*.pem", Some(dir.to_str().unwrap())).unwrap();
        assert!(secrets.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grep_reports_line_numbers_and_honors_file_glob() {
        let dir = temp_dir("grep");
        std::fs::write(dir.join("a.rs"), "fn main() {}\nlet target = 1;\n").unwrap();
        std::fs::write(dir.join("b.txt"), "target here\n").unwrap();

        let all = grep("target", Some(dir.to_str().unwrap()), None, None).unwrap();
        assert_eq!(all.len(), 2);

        let only_rs = grep("target", Some(dir.to_str().unwrap()), Some("*.rs"), None).unwrap();
        assert_eq!(only_rs.len(), 1);
        assert_eq!(only_rs[0].line_no, 2);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grep_skips_binary_files() {
        let dir = temp_dir("binary");
        std::fs::write(dir.join("bin.dat"), b"needle\0\0\0needle").unwrap();
        let hits = grep("needle", Some(dir.to_str().unwrap()), None, None).unwrap();
        assert!(hits.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}
