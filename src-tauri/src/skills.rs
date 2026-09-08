//! 사용자가 직접 쓰는 지식 파일.
//!
//! 내장 지식(`src/agent/knowledge/`)은 빌드에 박혀 있어 사용자가 못 고친다.
//! 여기서는 `~/.nekodesk/skills/*.md` 를 읽어 같은 자리에 합류시킨다. 형식은
//! 앞머리에 YAML 스타일 프론트매터를 두고 그 아래가 본문:
//!
//! ```text
//! ---
//! name: 회사 배포 절차
//! keywords: 배포, deploy, 릴리스
//! ---
//! 1. main 브랜치에서 ...
//! ```
//!
//! 파일 하나가 깨져도 나머지는 살아야 한다 — 지식은 부가 기능이지 전제가 아니다.

use crate::error::AppResult;
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
pub struct Skill {
    pub name: String,
    pub keywords: Vec<String>,
    pub content: String,
}

/// 프론트매터를 갈라 스킬 하나로 만든다. 형식이 아니면 None.
///
/// `fallback_name` 은 name 을 안 적었을 때 쓸 이름(보통 파일 이름)이다.
pub fn parse_skill(raw: &str, fallback_name: &str) -> Option<Skill> {
    let text = raw.trim_start_matches('\u{feff}');
    let rest = text.strip_prefix("---")?.trim_start_matches(['\r', '\n']);
    let end = rest.find("\n---")?;
    let (front, body) = rest.split_at(end);
    let body = body.trim_start_matches("\n---").trim_start_matches(['\r', '\n']);

    let mut name = fallback_name.to_string();
    let mut keywords = Vec::new();
    for line in front.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        match key.trim() {
            "name" => {
                let v = value.trim();
                if !v.is_empty() {
                    name = v.to_string();
                }
            }
            "keywords" => {
                keywords = value
                    .split(',')
                    .map(|k| k.trim().to_string())
                    .filter(|k| !k.is_empty())
                    .collect();
            }
            _ => {}
        }
    }

    // 키워드가 없으면 영원히 안 걸린다. 그런 파일은 없는 것과 같다.
    if keywords.is_empty() || body.trim().is_empty() {
        return None;
    }
    Some(Skill { name, keywords, content: body.trim().to_string() })
}

/// `~/.nekodesk/skills/*.md` 를 전부 읽는다. 폴더가 없으면 빈 목록.
pub fn load() -> AppResult<Vec<Skill>> {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".nekodesk/skills")) else {
        return Ok(Vec::new());
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else { continue };
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("스킬");
        if let Some(skill) = parse_skill(&raw, stem) {
            out.push(skill);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_and_keywords() {
        let s = parse_skill("---\nname: 배포 절차\nkeywords: 배포, deploy, 릴리스\n---\n1. main 에서 태그\n", "파일명").unwrap();
        assert_eq!(s.name, "배포 절차");
        assert_eq!(s.keywords, ["배포", "deploy", "릴리스"]);
        assert_eq!(s.content, "1. main 에서 태그");
    }

    #[test]
    fn falls_back_to_the_file_name() {
        let s = parse_skill("---\nkeywords: 배포\n---\n내용", "deploy-guide").unwrap();
        assert_eq!(s.name, "deploy-guide");
    }

    #[test]
    fn rejects_files_that_could_never_match() {
        // 키워드가 없으면 영원히 안 걸리고, 본문이 없으면 붙일 게 없다.
        assert!(parse_skill("---\nname: x\n---\n내용", "f").is_none());
        assert!(parse_skill("---\nkeywords: a\n---\n   \n", "f").is_none());
    }

    #[test]
    fn rejects_plain_markdown_without_frontmatter() {
        assert!(parse_skill("# 그냥 문서\n내용", "f").is_none());
        assert!(parse_skill("", "f").is_none());
        assert!(parse_skill("---\nkeywords: a\n본문에 닫는 줄이 없음", "f").is_none());
    }

    #[test]
    fn tolerates_crlf_and_a_byte_order_mark() {
        // 윈도우 편집기로 저장한 파일. 여기서 걸리면 원인 찾기가 괴롭다.
        let s = parse_skill("\u{feff}---\r\nkeywords: 배포\r\n---\r\n내용\r\n", "f").unwrap();
        assert_eq!(s.keywords, ["배포"]);
        assert!(s.content.contains("내용"));
    }

    #[test]
    fn keeps_markdown_structure_in_the_body() {
        let s = parse_skill("---\nkeywords: a\n---\n## 제목\n\n- 항목\n- 항목2\n", "f").unwrap();
        assert!(s.content.starts_with("## 제목"));
        assert!(s.content.contains("- 항목2"));
    }

    #[test]
    fn ignores_unknown_frontmatter_keys() {
        let s = parse_skill("---\nauthor: 나\nkeywords: a\nversion: 2\n---\n내용", "f").unwrap();
        assert_eq!(s.keywords, ["a"]);
    }
}
