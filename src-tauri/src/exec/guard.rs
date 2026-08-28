//! `code.exec` 의 하드 게이트.
//!
//! ## 무엇을 보장하고 무엇을 보장하지 않는가
//!
//! 임의의 코드를 정적으로 검사해 안전을 보장하는 건 불가능하다. 파이썬 한 줄이면
//! 어떤 금지어도 없이 홈 디렉토리를 지울 수 있다. 그래서 여기가 하는 일은 "안전
//! 검사" 가 아니라 **되돌릴 수 없는 소수의 행동을 아예 선택지에서 빼는 것**이다.
//! 실질적인 방어선은 사용자 확인(`danger-patterns.ts` → 확인 다이얼로그)이고,
//! 여기는 그 확인으로도 뚫리면 안 되는 것만 막는다. `files::guard` 의 하드
//! 차단 목록과 같은 역할이다.
//!
//! ## 왜 정규식인가
//!
//! 예전에는 소문자로 바꾼 코드에 `contains("sudo ")` 같은 부분 문자열 8개를
//! 검사했다. 문제가 양쪽으로 있었다:
//!   - 못 잡음: `sudo\t`, `rm  -rf /`, `rm -fr /`
//!   - 헛잡음: 주석에 `id_rsa` 라고 적기만 해도 차단
//! 단어 경계를 쓰는 정규식으로 둘 다 줄인다. 그래도 우회는 가능하다 — 위에 쓴 대로
//! 그게 이 계층의 목표가 아니다.
//!
//! ## 자격증명 경로는 fs 와 목록을 공유한다
//!
//! 파일 툴로는 `~/.ssh` 를 못 읽는데 셸로는 읽힌다면 자물쇠가 한쪽 문에만 달린
//! 셈이다. 그래서 경로 목록을 `files::guard` 에서 그대로 가져온다 — 거기에
//! `.kube` 를 추가하면 여기도 같이 막힌다.

use crate::files::guard::{BLOCKED_DIRS, BLOCKED_FILE_NAMES};
use std::sync::OnceLock;

/// 사용자 확인으로도 풀 수 없는 것들.
fn catastrophic() -> &'static Vec<(regex::Regex, &'static str)> {
    static PATTERNS: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let raw: &[(&str, &'static str)] = &[
            // 권한 상승. 명령어 자리에 온 것만 — 문자열 안의 "sudo" 는 놔둔다.
            (r"(?m)(^|[;&|]\s*|\bdo shell script\s+\x22)\s*(sudo|doas)\b", "관리자 권한 실행"),
            (r"(?i)with\s+administrator\s+privileges", "관리자 권한 실행(AppleScript)"),
            // 루트·홈 통째로 지우기. 플래그 순서와 공백을 가리지 않는다.
            (r"\brm\s+(-\w*\s+)*-\w*[rR]\w*\s+(-\w*\s+)*(/|~|\$HOME)\s*$", "루트/홈 강제 삭제"),
            (r"\brm\s+(-\w*\s+)*--recursive\b.*\s(/|~|\$HOME)\s*$", "루트/홈 강제 삭제"),
            (r"rmtree\s*\(\s*[\x22']?(/|~|\$HOME)[\x22']?\s*\)", "루트/홈 재귀 삭제(Python)"),
            (r"rmtree\s*\(\s*os\.path\.expanduser", "홈 디렉토리 재귀 삭제(Python)"),
            // 디스크 파괴.
            (r"\bmkfs(\.\w+)?\b", "디스크 포맷"),
            (r"\bdiskutil\s+(erase|reformat)", "디스크 초기화"),
            (r"\bdd\b[^\n]*\bof=/dev/", "디스크 직접 쓰기"),
            // 포크 폭탄.
            (r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", "포크 폭탄"),
        ];
        raw.iter()
            .map(|(p, r)| (regex::Regex::new(p).expect("잘못된 차단 정규식"), *r))
            .collect()
    })
}

/// 코드가 자격증명 경로를 건드리는가. 목록은 `files::guard` 와 공유한다.
fn credential_hit(code: &str) -> Option<String> {
    let lower = code.to_lowercase();
    for dir in BLOCKED_DIRS {
        // 경로처럼 쓰인 경우만. 슬래시가 붙어야 디렉토리로 읽는다.
        let needle = format!("{}/", dir.to_lowercase());
        if lower.contains(&needle) {
            return Some(format!("자격증명 경로 접근: {dir}"));
        }
    }
    for name in BLOCKED_FILE_NAMES {
        if lower.contains(&name.to_lowercase()) {
            return Some(format!("민감한 파일 접근: {name}"));
        }
    }
    for key in ["id_rsa", "id_ed25519", "id_ecdsa"] {
        if lower.contains(key) {
            return Some(format!("SSH 개인키 접근: {key}"));
        }
    }
    // 키체인 덤프.
    if lower.contains("security find-generic-password")
        || lower.contains("security find-internet-password")
    {
        return Some("키체인 비밀번호 추출".to_string());
    }
    None
}

/// 차단 사유. 없으면 None.
pub fn hard_blocked(code: &str) -> Option<String> {
    if let Some((_, reason)) = catastrophic().iter().find(|(re, _)| re.is_match(code)) {
        return Some((*reason).to_string());
    }
    credential_hit(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(code: &str) -> bool {
        hard_blocked(code).is_some()
    }

    #[test]
    fn blocks_privilege_escalation_in_command_position() {
        for code in [
            "sudo rm x",
            "ls; sudo reboot",
            "cat a | sudo tee b",
            "doas pkg install",
        ] {
            assert!(blocked(code), "{code:?} 는 막아야 한다");
        }
    }

    #[test]
    fn does_not_trip_on_the_word_sudo_inside_text() {
        // 예전 부분 문자열 검사는 이런 것도 막았다.
        for code in [
            r#"print("sudo 없이 실행하세요")"#,
            "# sudo 를 쓰지 말 것",
            "grep pseudocode notes.txt",
        ] {
            assert!(!blocked(code), "{code:?} 는 막으면 안 된다");
        }
    }

    #[test]
    fn blocks_root_and_home_wipes_regardless_of_flag_spelling() {
        for code in [
            "rm -rf /",
            "rm -fr /",
            "rm  -rf   ~",
            "rm -r -f /",
            "rm --recursive --force $HOME",
            "rm -rf $HOME",
        ] {
            assert!(blocked(code), "{code:?} 는 막아야 한다");
        }
    }

    #[test]
    fn ordinary_deletes_are_allowed_through_to_the_confirm_dialog() {
        // 이건 위험하지만 되돌릴 수 없는 종류는 아니다 — 확인 다이얼로그의 몫이다.
        for code in ["rm -rf ./build", "rm -rf /tmp/neko_cache", "rm notes.txt"] {
            assert!(!blocked(code), "{code:?} 는 확인 단계로 넘겨야 한다");
        }
    }

    #[test]
    fn blocks_python_equivalents_not_just_shell() {
        assert!(blocked(r#"shutil.rmtree("/")"#));
        assert!(blocked("shutil.rmtree(os.path.expanduser('~'))"));
        assert!(!blocked(r#"shutil.rmtree("./tmp")"#));
    }

    #[test]
    fn blocks_applescript_admin_rights() {
        assert!(blocked(r#"do shell script "rm x" with administrator privileges"#));
        assert!(blocked(r#"do shell script "sudo rm x""#));
    }

    #[test]
    fn blocks_disk_destruction_and_fork_bombs() {
        assert!(blocked("mkfs.ext4 /dev/disk2"));
        assert!(blocked("diskutil eraseDisk JHFS+ x disk2"));
        assert!(blocked("dd if=/dev/zero of=/dev/disk2"));
        assert!(blocked(":(){:|:&};:"));
        // 정상적인 dd 는 통과.
        assert!(!blocked("dd if=a.img of=b.img"));
    }

    #[test]
    fn shares_the_credential_list_with_the_file_guard() {
        // files::guard 에 경로를 추가하면 여기도 자동으로 막힌다.
        assert!(blocked("cat ~/.ssh/config"));
        assert!(blocked("cat ~/.aws/credentials"));
        assert!(blocked("ls ~/.kube/"));
        assert!(blocked("cat ~/.ssh/id_rsa"));
        assert!(blocked("security find-generic-password -s github"));
        assert!(blocked("cat .env"));
    }

    #[test]
    fn leaves_normal_code_alone() {
        for code in [
            "print('안녕')",
            "ls -la ~/Desktop",
            r#"tell application "Music" to play"#,
            "git status",
            "import matplotlib.pyplot as plt",
        ] {
            assert!(!blocked(code), "{code:?} 는 막으면 안 된다");
        }
    }
}
