//! 사용자 입력에서 기억 검색어를 뽑는다.
//!
//! 한국어는 조사가 단어에 붙어 다닌다. "고양이를" 을 그대로 검색하면 "고양이가"
//! 라고 저장된 기억을 못 찾는다. 그래서 어절에서 조사를 떼어낸 형태도 함께 넣는다.
//! 형태소 분석기를 붙일 수도 있지만, 조사 목록 하나로 대부분이 잡히고 의존성이 없다.

/// 붙어 다니는 조사·어미. 긴 것부터 검사해야 "에서" 가 "에" 로 잘리지 않는다.
const PARTICLES: &[&str] = &[
    "에서는", "으로는", "에게서", "이라고", "라고는",
    "에서", "에게", "한테", "으로", "라고", "이나", "부터", "까지", "처럼", "보다", "마다",
    "은", "는", "이", "가", "을", "를", "의", "에", "도", "만", "로", "와", "과", "랑",
];

/// 검색어로서 의미가 없는 말. 이것만 남으면 아무 기억이나 끌려온다.
const STOPWORDS: &[&str] = &[
    "그리고", "그래서", "하지만", "그런데", "저기", "이거", "그거", "저거", "여기", "거기",
    "지금", "오늘", "내일", "어제", "해줘", "알려줘", "보여줘", "부탁", "그럼", "이제",
    "the", "and", "for", "you", "your", "with", "this", "that", "please",
];

/// 한 번에 쓸 검색어 상한. 많으면 관련 없는 기억까지 끌려온다.
const MAX_TERMS: usize = 8;

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
}

/// 어절에서 조사를 뗀 형태. 뗄 게 없거나 너무 짧아지면 None.
fn strip_particle(token: &str) -> Option<String> {
    let chars: Vec<char> = token.chars().collect();
    for particle in PARTICLES {
        let plen = particle.chars().count();
        // 조사를 떼고도 두 글자는 남아야 뜻이 있다 ("이를" → "이" 는 무의미).
        if chars.len() < plen + 2 {
            continue;
        }
        if token.ends_with(particle) {
            return Some(chars[..chars.len() - plen].iter().collect());
        }
    }
    None
}

/// 검색어 목록. 길이 2 이상, 불용어 제외, 중복 제거.
pub fn extract(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    let push = |term: String, out: &mut Vec<String>| {
        if term.chars().count() < 2 {
            return;
        }
        if STOPWORDS.contains(&term.as_str()) {
            return;
        }
        if !out.contains(&term) {
            out.push(term);
        }
    };

    for raw in text.split(|c: char| !is_word_char(c)) {
        if raw.is_empty() {
            continue;
        }
        let token = raw.to_lowercase();
        // 조사를 뗀 형태를 먼저 넣는다 — 저장된 기억과 맞을 가능성이 더 높다.
        if let Some(stem) = strip_particle(&token) {
            push(stem, &mut out);
        }
        push(token, &mut out);
        if out.len() >= MAX_TERMS {
            break;
        }
    }

    out.truncate(MAX_TERMS);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_korean_particles_so_stored_forms_still_match() {
        // "고양이를" 로 물어도 "고양이가 ..." 로 저장된 기억을 찾아야 한다.
        let terms = extract("고양이를 어떻게 돌봐?");
        assert!(terms.contains(&"고양이".to_string()), "{terms:?}");
    }

    #[test]
    fn prefers_the_longest_matching_particle() {
        // "에서" 가 "에" 로 잘리면 "회사" 대신 "회사에" 가 남는다.
        let terms = extract("회사에서 뭐 했지");
        assert!(terms.contains(&"회사".to_string()), "{terms:?}");
    }

    #[test]
    fn keeps_the_original_form_too() {
        let terms = extract("사료를");
        assert!(terms.contains(&"사료를".to_string()), "{terms:?}");
    }

    #[test]
    fn does_not_strip_a_word_down_to_nothing() {
        // "이를" 에서 "를" 을 떼면 "이" 하나만 남아 아무 기억이나 맞는다.
        let terms = extract("이를 닦았다");
        assert!(!terms.contains(&"이".to_string()), "{terms:?}");
    }

    #[test]
    fn single_characters_are_not_search_terms() {
        assert!(extract("a 나 b 다").is_empty());
    }

    #[test]
    fn drops_filler_words() {
        let terms = extract("그래서 오늘 뭐 해줘");
        assert!(!terms.contains(&"그래서".to_string()), "{terms:?}");
        assert!(!terms.contains(&"오늘".to_string()), "{terms:?}");
        assert!(!terms.contains(&"해줘".to_string()), "{terms:?}");
    }

    #[test]
    fn lowercases_ascii_so_case_does_not_matter() {
        assert!(extract("GitHub 계정").contains(&"github".to_string()));
    }

    #[test]
    fn splits_on_punctuation_and_dedupes() {
        let terms = extract("커피, 커피! 커피?");
        assert_eq!(terms, vec!["커피".to_string()]);
    }

    #[test]
    fn caps_the_number_of_terms() {
        let text = (0..30).map(|i| format!("단어{i}")).collect::<Vec<_>>().join(" ");
        assert!(extract(&text).len() <= 8);
    }

    #[test]
    fn empty_input_yields_no_terms() {
        assert!(extract("").is_empty());
        assert!(extract("!!! ??? ...").is_empty());
    }
}
