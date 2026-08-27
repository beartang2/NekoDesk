//! 파일 접근 정책.
//!
//! 여기 있는 판정은 전부 순수 함수다 — 파일시스템을 만지는 건 `resolve` 하나뿐이고,
//! 나머지는 경로만 보고 결정하므로 단위 테스트로 전부 덮을 수 있다.
//!
//! 위협 모델: `web.scrape` 로 읽은 페이지가 모델을 조종해 자격증명을 읽어 어딘가로
//! 보내려는 경우. 따라서 민감 경로는 **사용자 승인으로도 뚫리지 않는** 하드 차단이고,
//! 쓰기는 승인된 루트 밖이면 매번 사용자 확인을 요구한다(fail-safe).

use std::path::{Component, Path, PathBuf};

/// 자격증명·개인 데이터가 사는 디렉토리. 조상 중 하나라도 걸리면 읽기·쓰기 모두 거부.
const BLOCKED_DIRS: &[&str] = &[
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".config/gcloud",
    "Library/Keychains",
    "Library/Cookies",
    "Library/Messages",
    "Library/Containers/com.apple.Safari",
    "Library/Application Support/AddressBook",
];

/// 이름만으로 비밀임을 알 수 있는 파일.
const BLOCKED_FILE_NAMES: &[&str] = &[
    ".env", ".netrc", ".npmrc", ".pgpass", "credentials", ".git-credentials",
];

/// 비밀 키 파일의 확장자.
const BLOCKED_EXTENSIONS: &[&str] = &["pem", "key", "p12", "pfx", "keystore", "jks"];

/// 접근 판정 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// 그대로 진행.
    Allow,
    /// 사용자 확인을 받아야 한다 (승인된 쓰기 루트 밖).
    Confirm,
    /// 무조건 거부. 사용자 승인으로도 뚫을 수 없다.
    Deny(String),
}

/// 이름만으로 비밀인 파일인가.
fn is_secret_file_name(name: &str) -> bool {
    if BLOCKED_FILE_NAMES.contains(&name) {
        return true;
    }
    // .env.local, .env.production ...
    if name.starts_with(".env.") {
        return true;
    }
    // id_rsa, id_ed25519, id_ecdsa (.pub 포함 — 짝을 노출할 이유가 없다)
    if name.starts_with("id_") {
        return true;
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    matches!(ext.as_deref(), Some(e) if BLOCKED_EXTENSIONS.contains(&e))
}

/// 하드 차단 사유. 없으면 None.
pub fn blocked_reason(path: &Path) -> Option<String> {
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if is_secret_file_name(name) {
            return Some(format!("민감한 파일이라 접근할 수 없어: {name}"));
        }
    }

    let text = path.to_string_lossy().replace('\\', "/");
    for dir in BLOCKED_DIRS {
        // 경로 중간에 있거나(`/.ssh/`), 대상 자체가 그 디렉토리인 경우(`/.ssh`).
        if text.contains(&format!("/{dir}/")) || text.ends_with(&format!("/{dir}")) {
            return Some(format!("민감한 디렉토리라 접근할 수 없어: {dir}"));
        }
    }
    None
}

/// 이 경로에 이 방식으로 접근해도 되는가.
///
/// 읽기는 하드 차단 목록만 피하면 어디든 허용한다 — 사용자의 프로젝트가 홈 밖
/// (외장 볼륨 등)에 있는 경우가 흔해서, 홈으로 가두면 툴이 쓸모없어진다.
/// 쓰기는 승인된 루트 안에서만 무확인이고, 그 밖은 매번 확인을 받는다.
pub fn classify(path: &Path, write: bool, write_roots: &[PathBuf]) -> Decision {
    if let Some(reason) = blocked_reason(path) {
        return Decision::Deny(reason);
    }
    if !write {
        return Decision::Allow;
    }
    if write_roots.iter().any(|root| path.starts_with(root)) {
        return Decision::Allow;
    }
    Decision::Confirm
}

/// `.` 과 `..` 을 문자열 수준에서 걷어낸다. 파일시스템을 만지지 않는다.
///
/// canonicalize 는 존재하는 경로에만 쓸 수 있어서, 아직 없는 파일을 쓰려는 경우
/// 먼저 이걸로 `..` 을 접어야 `~/docs/../.ssh/id_rsa` 같은 우회를 잡을 수 있다.
pub fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                // 루트 위로는 못 올라간다.
                if out.parent().is_some() {
                    out.pop();
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 앞머리 `~` 를 홈으로 바꾼다.
pub fn expand_tilde(raw: &str, home: &Path) -> PathBuf {
    if raw == "~" {
        return home.to_path_buf();
    }
    match raw.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(raw),
    }
}

/// 실제 경로로 확정한다.
///
/// 존재하는 가장 가까운 조상을 canonicalize 해 심볼릭 링크를 풀고, 아직 없는
/// 나머지 구간을 그 위에 붙인다. 그래야 없는 파일을 쓰려는 경우에도 링크를 통한
/// 우회(`~/safe -> ~/.ssh`)를 막을 수 있다.
pub fn resolve(raw: &str, home: &Path) -> std::io::Result<PathBuf> {
    let expanded = expand_tilde(raw, home);
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        home.join(expanded)
    };
    let normalized = lexical_normalize(&absolute);

    let mut missing: Vec<&std::ffi::OsStr> = Vec::new();
    let mut existing: &Path = &normalized;
    loop {
        if existing.exists() {
            break;
        }
        let Some(name) = existing.file_name() else {
            // 루트까지 올라갔는데도 없다 — 그대로 돌려준다.
            return Ok(normalized);
        };
        missing.push(name);
        match existing.parent() {
            Some(parent) => existing = parent,
            None => return Ok(normalized),
        }
    }

    let mut out = existing.canonicalize()?;
    for name in missing.iter().rev() {
        out.push(name);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roots(paths: &[&str]) -> Vec<PathBuf> {
        paths.iter().map(PathBuf::from).collect()
    }

    #[test]
    fn reads_are_allowed_outside_home() {
        // 사용자의 프로젝트가 외장 볼륨에 있는 흔한 경우.
        let p = Path::new("/Volumes/BREAD/project/src/main.rs");
        assert_eq!(classify(p, false, &[]), Decision::Allow);
    }

    #[test]
    fn ssh_directory_is_denied_for_read() {
        let p = Path::new("/Users/kim/.ssh/id_rsa");
        assert!(matches!(classify(p, false, &[]), Decision::Deny(_)));
    }

    #[test]
    fn approving_a_root_cannot_unlock_a_blocked_path() {
        // 승인 루트가 민감 경로를 감싸도 하드 차단이 이긴다.
        let p = Path::new("/Users/kim/.aws/credentials");
        assert!(matches!(
            classify(p, true, &roots(&["/Users/kim"])),
            Decision::Deny(_)
        ));
    }

    #[test]
    fn secret_file_names_are_denied_anywhere() {
        for name in [
            "/tmp/.env",
            "/tmp/.env.production",
            "/tmp/id_ed25519",
            "/tmp/server.pem",
            "/tmp/store.p12",
            "/home/x/.netrc",
        ] {
            assert!(
                matches!(classify(Path::new(name), false, &[]), Decision::Deny(_)),
                "{name} 은 차단돼야 한다"
            );
        }
    }

    #[test]
    fn ordinary_dotfiles_are_not_secrets() {
        for name in ["/tmp/.gitignore", "/tmp/.prettierrc", "/tmp/environment.ts"] {
            assert_eq!(classify(Path::new(name), false, &[]), Decision::Allow, "{name}");
        }
    }

    #[test]
    fn writes_outside_approved_roots_need_confirmation() {
        let p = Path::new("/Users/kim/Desktop/memo.txt");
        assert_eq!(classify(p, true, &[]), Decision::Confirm);
        assert_eq!(
            classify(p, true, &roots(&["/Users/kim/Desktop"])),
            Decision::Allow
        );
    }

    #[test]
    fn a_sibling_root_with_a_shared_prefix_does_not_grant_access() {
        // "/Users/kim/work" 승인이 "/Users/kim/workspace" 까지 열어주면 안 된다.
        // starts_with 는 경로 컴포넌트 단위라 문자열 접두사와 다르다.
        let p = Path::new("/Users/kim/workspace/secret.txt");
        assert_eq!(classify(p, true, &roots(&["/Users/kim/work"])), Decision::Confirm);
    }

    #[test]
    fn parent_traversal_is_folded_before_judging() {
        let p = lexical_normalize(Path::new("/Users/kim/docs/../.ssh/id_rsa"));
        assert_eq!(p, Path::new("/Users/kim/.ssh/id_rsa"));
        assert!(matches!(classify(&p, false, &[]), Decision::Deny(_)));
    }

    #[test]
    fn traversal_cannot_climb_above_root() {
        assert_eq!(
            lexical_normalize(Path::new("/../../etc/hosts")),
            Path::new("/etc/hosts")
        );
    }

    #[test]
    fn tilde_expands_to_home() {
        let home = Path::new("/Users/kim");
        assert_eq!(expand_tilde("~", home), home);
        assert_eq!(expand_tilde("~/docs/a.txt", home), Path::new("/Users/kim/docs/a.txt"));
        // 중간의 ~ 는 확장하지 않는다.
        assert_eq!(expand_tilde("/tmp/~x", home), Path::new("/tmp/~x"));
    }

    #[test]
    fn resolve_follows_symlinks_before_judging() {
        let temp = std::env::temp_dir().join(format!("neko_guard_{}", std::process::id()));
        let secret = temp.join(".ssh");
        std::fs::create_dir_all(&secret).unwrap();
        let link = temp.join("innocent");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        // 링크를 통해 아직 없는 파일을 쓰려는 시도도 실제 경로로 풀려야 한다.
        let resolved = resolve(link.join("id_rsa").to_str().unwrap(), Path::new("/")).unwrap();
        assert!(
            matches!(classify(&resolved, true, &[temp.clone()]), Decision::Deny(_)),
            "심볼릭 링크로 .ssh 우회가 뚫렸다: {resolved:?}"
        );

        std::fs::remove_dir_all(&temp).ok();
    }
}
