//! API 키 같은 비밀은 macOS 키체인에 둔다. 예전엔 SQLite settings 표(와 localStorage)에 그대로
//! 적혀 있어, 같은 사용자로 도는 프로그램은 물론 네코 자신의 파일 도구로도 읽혔다.
//!
//! 키체인 항목은 만든 앱(코드 서명)만 묻지 않고 꺼낸다. 다른 프로그램이 꺼내려 하면 macOS 가
//! 사용자에게 묻는다. 서명이 고정 인증서라 업데이트해도 같은 앱으로 친다.
//!
//! 화면(webview)에는 값을 돌려주지 않는다 — 저장했는지만 알려 준다. 값을 쓰는 건 백엔드뿐이다
//! (검색·그림 그리기·Claude 중계). dev 빌드만 복사 버튼용으로 값을 꺼내 준다.

use crate::error::AppError;
use rusqlite::Connection;

/// 키체인에 두는 설정 이름. 이 밖의 이름은 비밀로 다루지 않는다.
pub const KEYS: &[&str] = &["brave_search_key", "cf_api_token", "google_api_key", "anthropic_api_key"];

#[cfg(target_os = "macos")]
const SERVICE: &str = "com.nekodesk.desktop";

pub fn is_secret(key: &str) -> bool {
    KEYS.contains(&key)
}

fn check(key: &str) -> Result<(), AppError> {
    if is_secret(key) {
        Ok(())
    } else {
        Err(AppError::msg(format!("비밀로 다루는 설정이 아니야: {key}")))
    }
}

/// 한 번 꺼낸 값. 키체인을 매번 읽으면 서명이 바뀌는 dev 빌드(다시 빌드할 때마다 새 바이너리)에선
/// Claude 요청·검색마다 macOS 가 비밀번호를 물었다. 이제 실행당 항목마다 한 번만 묻는다.
/// 값은 이 프로세스 메모리에만 있다 — 같은 사용자의 다른 프로그램이 읽을 수 있는 곳이 아니다.
#[cfg(target_os = "macos")]
fn cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, Option<String>>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Option<String>>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// 꺼낸다. 없으면 None.
#[cfg(target_os = "macos")]
pub fn get(key: &str) -> Result<Option<String>, AppError> {
    check(key)?;
    if let Some(hit) = cache().lock()?.get(key) {
        return Ok(hit.clone());
    }
    // 실패(사용자가 거부)는 담지 않는다 — 다음에 다시 물을 수 있어야 한다.
    let value = keychain_get(SERVICE, key)?;
    cache().lock()?.insert(key.to_owned(), value.clone());
    Ok(value)
}

/// 넣는다. 빈 값이면 지운다.
#[cfg(target_os = "macos")]
pub fn set(key: &str, value: &str) -> Result<(), AppError> {
    check(key)?;
    keychain_set(SERVICE, key, value)?;
    let value = value.trim();
    cache().lock()?.insert(key.to_owned(), (!value.is_empty()).then(|| value.to_owned()));
    Ok(())
}

#[cfg(target_os = "macos")]
fn keychain_get(service: &str, key: &str) -> Result<Option<String>, AppError> {
    match security_framework::passwords::get_generic_password(service, key) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        // errSecItemNotFound
        Err(e) if e.code() == -25300 => Ok(None),
        Err(e) => Err(AppError::msg(format!("키체인에서 못 꺼냈어: {e}"))),
    }
}

#[cfg(target_os = "macos")]
fn keychain_set(service: &str, key: &str, value: &str) -> Result<(), AppError> {
    let value = value.trim();
    if value.is_empty() {
        return match security_framework::passwords::delete_generic_password(service, key) {
            Err(e) if e.code() != -25300 => Err(AppError::msg(format!("키체인에서 못 지웠어: {e}"))),
            _ => Ok(()),
        };
    }
    security_framework::passwords::set_generic_password(service, key, value.as_bytes())
        .map_err(|e| AppError::msg(format!("키체인에 못 넣었어: {e}")))
}

#[cfg(not(target_os = "macos"))]
pub fn get(key: &str) -> Result<Option<String>, AppError> {
    check(key)?;
    Err(AppError::msg("키체인은 macOS 에서만 쓸 수 있어."))
}

#[cfg(not(target_os = "macos"))]
pub fn set(key: &str, _value: &str) -> Result<(), AppError> {
    check(key)?;
    Err(AppError::msg("키체인은 macOS 에서만 쓸 수 있어."))
}

/// 예전 버전이 settings 표에 적어 둔 비밀을 키체인으로 옮기고 표에서 지운다. 켤 때마다 불러도
/// 된다 — 옮길 게 없으면 아무것도 안 한다. 키체인에 못 넣으면 표에 그대로 둔다(잃지 않게).
pub fn migrate(conn: &Connection) {
    for key in KEYS {
        let Ok(Some(value)) = crate::db::settings::get(conn, key) else { continue };
        if !value.trim().is_empty() && set(key, &value).is_err() {
            continue;
        }
        let _ = conn.execute("DELETE FROM settings WHERE key = ?1", [key]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_names_are_secrets() {
        assert!(is_secret("brave_search_key"));
        assert!(is_secret("google_api_key"));
        assert!(is_secret("anthropic_api_key"));
        assert!(!is_secret("cf_account_id"));
        assert!(!is_secret("memo"));
        assert!(get("memo").is_err());
    }

    /// 진짜 키체인에 넣고 꺼내고 지운다(테스트 전용 서비스 이름). 키체인이 잠긴 CI 에선 못 돌아
    /// 손으로 돌린다: cargo test --lib secrets -- --ignored
    #[test]
    #[ignore]
    #[cfg(target_os = "macos")]
    fn keychain_round_trip() {
        let service = "com.nekodesk.desktop.test";
        keychain_set(service, "k", "  비밀 값 ").unwrap();
        assert_eq!(keychain_get(service, "k").unwrap().as_deref(), Some("비밀 값"));
        keychain_set(service, "k", "바뀐 값").unwrap();
        assert_eq!(keychain_get(service, "k").unwrap().as_deref(), Some("바뀐 값"));
        keychain_set(service, "k", "").unwrap();
        assert_eq!(keychain_get(service, "k").unwrap(), None);
        // 없는 걸 또 지워도 괜찮다.
        keychain_set(service, "k", "").unwrap();
    }
}
