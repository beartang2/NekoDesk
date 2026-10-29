//! 웹뷰 네비게이션 가드.
//!
//! 모델이 쓴 답은 마크다운으로 렌더링된다. 채팅 말풍선의 링크는 가로채서 기본 브라우저로
//! 열지만, 요약 바·업데이트 노트처럼 가로채지 않은 `<a>` 를 누르면 **앱 창 안에서** 외부
//! 페이지가 열렸다 — 그러면 그 페이지의 스크립트가 앱의 IPC 를 가진 창에서 돈다.
//! 창은 앱 자신의 페이지만 보여준다. 나머지는 전부 거부한다(프런트엔드가 `open_external_url`
//! 로 바깥 브라우저에 여는 건 네비게이션이 아니라 영향 없다).

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// 앱 자신의 주소인가. 릴리스는 `tauri://localhost`, 개발은 Vite 의 `http://localhost:1420`.
pub fn is_app_url(scheme: &str, host: Option<&str>, dev: bool) -> bool {
    match scheme {
        "tauri" => true,
        "http" | "https" => dev && matches!(host, Some("localhost") | Some("127.0.0.1")),
        _ => false,
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navguard")
        .on_navigation(|_webview, url| {
            let ok = is_app_url(url.scheme(), url.host_str(), cfg!(dev));
            if !ok {
                log::warn!("창 안 네비게이션 차단: {}", url);
            }
            ok
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::is_app_url;

    #[test]
    fn allows_only_app_origin() {
        assert!(is_app_url("tauri", Some("localhost"), false));
        assert!(is_app_url("http", Some("localhost"), true));
        assert!(!is_app_url("http", Some("localhost"), false));
        assert!(!is_app_url("https", Some("evil.example"), true));
        assert!(!is_app_url("https", Some("evil.example"), false));
        assert!(!is_app_url("file", None, true));
        assert!(!is_app_url("javascript", None, true));
    }
}
