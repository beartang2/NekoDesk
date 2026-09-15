//! 사용자가 직접 쓰는 지식 파일.
//!
//! 내장 지식(`src/agent/knowledge/`)은 빌드에 박혀 있어 사용자가 못 고친다.
//! 여기서는 `~/.nekodesk/skills/` 를 읽어 같은 자리에 합류시킨다. 형식은 Claude Code
//! 의 스킬과 같다 — 앞머리에 YAML 스타일 프론트매터, 그 아래가 본문:
//!
//! ```text
//! ---
//! name: 회사 배포 절차
//! description: 배포·릴리스 절차. "배포해줘", "릴리스 어떻게 해" 같은 요청에 쓴다.
//! ---
//! 1. main 브랜치에서 ...
//! ```
//!
//! 두 가지 모양을 받는다. `skills/이름.md` 한 장짜리, 그리고 `skills/이름/SKILL.md`
//! 폴더짜리(참고 파일을 옆에 둘 수 있게 — Claude 스킬을 그대로 복사해 넣으면 된다).
//!
//! 언제 붙일지는 `keywords` 가 정한다. 안 적었으면 description 안의 따옴표 구절
//! ("배포해줘")을 키워드로 삼는다 — Claude 스킬의 description 이 트리거 문구를
//! 그렇게 적는 관례를 그대로 받는 것이다. 둘 다 없으면 자동으로는 안 붙고
//! 사용자가 "/이름" 으로 부를 때만 붙는다.
//!
//! 잘 쓰는 법은 Anthropic 의 skill-creator 가 말하는 그대로다.
//!  - "언제 쓰는지" 는 전부 description 에. 트리거 문구를 따옴표로 나열하고, 덜
//!    걸리는 것보다 더 걸리는 쪽이 낫다 — "X·Y 를 말하면 명시적 요청이 없어도 써".
//!  - 본문은 500줄 아래로. 큰 참고 자료는 폴더의 references/ 에 두고 본문에서
//!    "언제 읽을지" 를 적어 가리킨다.
//!  - 대문자 명령("절대", "반드시")보다 이유를 적는다. 이유를 알면 모델이 적힌
//!    상황 밖에서도 맞게 움직인다.
//!  - 제 몫을 못 하는 문장은 지운다. 모델을 딴 데로 새게 하면 없느니만 못하다.
//!
//! 파일 하나가 깨져도 나머지는 살아야 한다 — 지식은 부가 기능이지 전제가 아니다.

use crate::error::AppResult;
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Debug, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub keywords: Vec<String>,
    pub content: String,
}

/// description 안의 따옴표 구절을 뽑는다. `"배포해줘", "릴리스 해"` → 두 개.
fn quoted_phrases(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('"') else { break };
        let phrase = after[..end].trim();
        if !phrase.is_empty() {
            out.push(phrase.to_string());
        }
        rest = &after[end + 1..];
    }
    out
}

/// 프론트매터를 갈라 스킬 하나로 만든다. 형식이 아니면 None.
///
/// `fallback_name` 은 name 을 안 적었을 때 쓸 이름(보통 파일·폴더 이름)이다.
pub fn parse_skill(raw: &str, fallback_name: &str) -> Option<Skill> {
    let text = raw.trim_start_matches('\u{feff}');
    let rest = text.strip_prefix("---")?.trim_start_matches(['\r', '\n']);
    let end = rest.find("\n---")?;
    let (front, body) = rest.split_at(end);
    let body = body.trim_start_matches("\n---").trim_start_matches(['\r', '\n']);

    let mut name = fallback_name.to_string();
    let mut description = String::new();
    let mut keywords = Vec::new();
    // description 은 여러 줄일 수 있다(`description: >` 뒤에 들여쓴 줄들).
    let mut in_description = false;
    for line in front.lines() {
        if in_description && line.starts_with([' ', '\t']) {
            if !description.is_empty() {
                description.push(' ');
            }
            description.push_str(line.trim());
            continue;
        }
        in_description = false;
        let Some((key, value)) = line.split_once(':') else { continue };
        match key.trim() {
            "name" => {
                let v = value.trim();
                if !v.is_empty() {
                    name = v.to_string();
                }
            }
            "description" => {
                description = value.trim().trim_start_matches(['>', '|']).trim().to_string();
                in_description = true;
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
    if keywords.is_empty() {
        keywords = quoted_phrases(&description);
    }

    // 본문이 없으면 붙일 게 없다.
    if body.trim().is_empty() {
        return None;
    }
    Some(Skill { name, description, keywords, content: body.trim().to_string() })
}

/// `dir/*.md` 와 `dir/*/SKILL.md` 를 전부 읽는다. 폴더가 없으면 빈 목록.
pub fn load_from(dir: &Path) -> Vec<Skill> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let (file, fallback) = if path.is_dir() {
            let Some(stem) = path.file_name().and_then(|s| s.to_str()) else { continue };
            (path.join("SKILL.md"), stem.to_string())
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("스킬");
            (path.clone(), stem.to_string())
        } else {
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(&file) else { continue };
        if let Some(skill) = parse_skill(&raw, &fallback) {
            out.push(skill);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// `~/.nekodesk/skills/` 전체.
pub fn load() -> AppResult<Vec<Skill>> {
    Ok(dirs::home_dir()
        .map(|h| load_from(&h.join(".nekodesk/skills")))
        .unwrap_or_default())
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
    fn takes_trigger_phrases_from_the_description_when_there_are_no_keywords() {
        // Claude 스킬의 description 관례: 트리거 문구를 따옴표로 나열한다.
        let s = parse_skill(
            "---\nname: x\ndescription: 배포 절차. \"배포해줘\", \"릴리스 어떻게 해\" 같은 요청에 쓴다.\n---\n내용",
            "f",
        )
        .unwrap();
        assert_eq!(s.keywords, ["배포해줘", "릴리스 어떻게 해"]);
        assert!(s.description.starts_with("배포 절차."));
    }

    #[test]
    fn explicit_keywords_win_over_the_description() {
        let s = parse_skill(
            "---\ndescription: \"따옴표\" 구절\nkeywords: 명시\n---\n내용",
            "f",
        )
        .unwrap();
        assert_eq!(s.keywords, ["명시"]);
    }

    #[test]
    fn joins_a_folded_multi_line_description() {
        let s = parse_skill(
            "---\nname: x\ndescription: >\n  첫 줄\n  둘째 줄 \"트리거\"\nkeywords: a\n---\n내용",
            "f",
        )
        .unwrap();
        assert_eq!(s.description, "첫 줄 둘째 줄 \"트리거\"");
    }

    #[test]
    fn a_skill_without_any_trigger_is_kept_for_slash_invocation() {
        // 자동으로는 안 붙지만 "/이름" 으로 부를 수 있다.
        let s = parse_skill("---\nname: x\n---\n내용", "f").unwrap();
        assert!(s.keywords.is_empty());
    }

    #[test]
    fn rejects_an_empty_body() {
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

    #[test]
    fn loads_both_flat_files_and_skill_folders() {
        let dir = std::env::temp_dir().join(format!("neko_skills_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("folder-skill/references")).unwrap();
        std::fs::write(dir.join("flat.md"), "---\nkeywords: a\n---\n평면").unwrap();
        std::fs::write(dir.join("folder-skill/SKILL.md"), "---\ndescription: \"트리거\"\n---\n폴더").unwrap();
        std::fs::write(dir.join("folder-skill/references/extra.md"), "참고 — 스킬로 읽히면 안 됨").unwrap();
        std::fs::write(dir.join("notes.txt"), "무시").unwrap();

        let skills = load_from(&dir);
        let _ = std::fs::remove_dir_all(&dir);

        let names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["flat", "folder-skill"]);
        assert_eq!(skills[1].keywords, ["트리거"]);
        assert_eq!(skills[1].content, "폴더");
    }

    #[test]
    fn missing_directory_is_just_empty() {
        assert!(load_from(Path::new("/definitely/not/here")).is_empty());
    }
}
