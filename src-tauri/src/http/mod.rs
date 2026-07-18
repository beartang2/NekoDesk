//! HTTP 네트워킹 계층.
//!
//! 예전엔 커맨드마다 `reqwest::blocking::Client` 를 새로 빌드했고, 커맨드가
//! sync 라 네트워크 I/O 가 Tauri 메인 스레드를 최대 수십 초 막았다(UI 프리즈).
//! 여기서는 async 공용 클라이언트 하나를 재사용하고, 커맨드는 `async fn` 이다.

pub mod search;
pub mod scrape;
pub mod weather;

use crate::error::AppError;
use std::net::IpAddr;
use std::sync::OnceLock;
use std::time::Duration;

/// 공용 async HTTP 클라이언트. 한 번만 빌드해 재사용한다.
/// 리다이렉트는 5회로 제한하고, 매 홉마다 내부/사설 호스트를 거부한다(SSRF 방어).
pub fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 || host_is_blocked(attempt.url()) {
                    attempt.stop() // 따라가지 않고 현재 응답을 반환
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .expect("failed to build shared HTTP client")
    })
}

/// SSRF 방어: http/https 만 허용하고 내부/사설/링크로컬 주소를 거부한다.
///
/// LLM(web.scrape 로 스크랩된 페이지가 프롬프트를 조작하는 경우 포함)이
/// `http://127.0.0.1:<llama-port>` 나 `169.254.169.254`(클라우드 메타데이터),
/// 사내망 주소를 노리는 것을 막는다. web.scrape 처럼 URL 을 LLM 이 고르는
/// 경로에서 요청 전에 호출한다.
pub fn validate_public_url(raw: &str) -> Result<(), AppError> {
    let url = reqwest::Url::parse(raw).map_err(|_| AppError::msg("잘못된 URL 이야."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::msg("http/https 주소만 접근할 수 있어."));
    }
    if host_is_blocked(&url) {
        return Err(AppError::msg("내부/사설 주소는 접근할 수 없어."));
    }
    Ok(())
}

fn host_is_blocked(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return true; // 호스트 없는 URL 은 거부
    };
    let h = host.trim_matches(|c| c == '[' || c == ']'); // IPv6 대괄호 제거
    if let Ok(ip) = h.parse::<IpAddr>() {
        return ip_is_blocked(ip);
    }
    let lower = h.to_ascii_lowercase();
    lower == "localhost" || lower.ends_with(".localhost")
}

fn ip_is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.octets()[0] == 0
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        }
    }
}

/// application/x-www-form-urlencoded 인코딩 (쿼리 파라미터용).
pub fn urlencode(s: &str) -> String {
    s.bytes()
        .flat_map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                vec![b as char]
            } else if b == b' ' {
                vec!['+']
            } else {
                format!("%{:02X}", b).chars().collect::<Vec<_>>()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_loopback_and_private() {
        assert!(validate_public_url("http://127.0.0.1:8803/health").is_err());
        assert!(validate_public_url("http://localhost:8803").is_err());
        assert!(validate_public_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_public_url("http://10.0.0.5").is_err());
        assert!(validate_public_url("http://192.168.1.1").is_err());
        assert!(validate_public_url("http://[::1]/").is_err());
    }

    #[test]
    fn blocks_non_http_schemes() {
        assert!(validate_public_url("file:///etc/passwd").is_err());
        assert!(validate_public_url("ftp://example.com").is_err());
    }

    #[test]
    fn allows_public_urls() {
        assert!(validate_public_url("https://example.com/page").is_ok());
        assert!(validate_public_url("https://api.github.com/repos/x/y").is_ok());
    }

    #[test]
    fn urlencode_matches_form_encoding() {
        assert_eq!(urlencode("hello world"), "hello+world");
        assert_eq!(urlencode("날씨"), "%EB%82%A0%EC%94%A8");
        assert_eq!(urlencode("a-b_c.d~e"), "a-b_c.d~e");
    }
}
