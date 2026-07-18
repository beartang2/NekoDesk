//! 페이지 스크래핑. github.com 은 API 로 특수 처리, 나머지는 일반 HTML 추출.
//! URL 을 LLM 이 고르므로 요청 전에 SSRF 가드를 통과시킨다.

use crate::error::AppError;
use crate::http::{client, urlencode, validate_public_url};
use crate::ScrapResult;

const SCRAPE_UA: &str = "Mozilla/5.0 (Macintosh; Apple Silicon Mac OS X 15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15";

pub async fn run(url: &str) -> Result<ScrapResult, AppError> {
    // github.com 은 공개 API 로 더 깔끔하게 가져온다.
    if let Some(result) = github(url).await {
        return Ok(result);
    }

    validate_public_url(url)?; // 내부/사설 주소·비 http 스킴 차단

    let html = client()
        .get(url)
        .header("User-Agent", SCRAPE_UA)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "en-US,en;q=0.9,ko;q=0.8")
        .send()
        .await?
        .text()
        .await?;

    Ok(extract_readable(url, &html))
}

/// scraper::Html 은 여기 동기 함수 안에서만 산다(await 없음) → 미래가 Send 유지.
fn extract_readable(url: &str, html: &str) -> ScrapResult {
    let document = scraper::Html::parse_document(html);

    let title_sel = scraper::Selector::parse("title").unwrap();
    let title = document
        .select(&title_sel)
        .next()
        .map(|n| n.text().collect::<String>().trim().to_string())
        .unwrap_or_default();

    // nav/footer/script/style 은 건너뛰고 본문 태그의 읽을 만한 텍스트만
    let content_sel =
        scraper::Selector::parse("article, main, p, h1, h2, h3, h4, li, td, th, blockquote")
            .unwrap();
    let content: String = document
        .select(&content_sel)
        .map(|n| n.text().collect::<String>().trim().to_string())
        .filter(|s| s.len() > 15)
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(6000)
        .collect();

    ScrapResult { url: url.to_string(), title, content }
}

/// github.com URL 이면 API 로 가져온다. github 가 아니거나 실패하면 None →
/// 일반 스크랩 경로로 넘어간다. (api.github.com 은 공개라 SSRF 무관)
async fn github(url: &str) -> Option<ScrapResult> {
    let stripped = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/');
    if !stripped.starts_with("github.com/") {
        return None;
    }
    let path = stripped.trim_start_matches("github.com/");
    let parts: Vec<&str> = path.splitn(3, '/').collect();
    if parts.is_empty() || parts[0].is_empty() {
        return None;
    }

    if parts.len() == 1 {
        github_user(url, parts[0]).await
    } else {
        github_repo(url, parts[0], parts[1]).await
    }
}

async fn github_user(url: &str, username: &str) -> Option<ScrapResult> {
    let api = format!(
        "https://api.github.com/users/{}/repos?sort=updated&per_page=30",
        urlencode(username)
    );
    let json: serde_json::Value = client()
        .get(&api)
        .header("User-Agent", "NekoDesk/1.0")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let repos = json.as_array()?;

    let mut lines = vec![format!("GitHub user: {}", username), String::new()];
    for repo in repos.iter().take(20) {
        if repo["fork"].as_bool().unwrap_or(false) {
            continue;
        }
        let name = repo["name"].as_str().unwrap_or("");
        let desc = repo["description"].as_str().unwrap_or("").trim();
        let stars = repo["stargazers_count"].as_u64().unwrap_or(0);
        let lang = repo["language"].as_str().unwrap_or("");
        let desc_part = if desc.is_empty() { String::new() } else { format!(" — {desc}") };
        let meta = if !lang.is_empty() || stars > 0 {
            format!(" [{}{}]", lang, if stars > 0 { format!(", ★{stars}") } else { String::new() })
        } else {
            String::new()
        };
        lines.push(format!("• {name}{desc_part}{meta}"));
    }

    Some(ScrapResult {
        url: url.to_string(),
        title: format!("{username}'s GitHub repositories"),
        content: lines.join("\n"),
    })
}

async fn github_repo(url: &str, username: &str, repo_name: &str) -> Option<ScrapResult> {
    let api = format!("https://api.github.com/repos/{username}/{repo_name}");
    let repo: serde_json::Value = client()
        .get(&api)
        .header("User-Agent", "NekoDesk/1.0")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;

    let desc = repo["description"].as_str().unwrap_or("").trim().to_string();
    let stars = repo["stargazers_count"].as_u64().unwrap_or(0);
    let forks = repo["forks_count"].as_u64().unwrap_or(0);
    let lang = repo["language"].as_str().unwrap_or("");
    let topics: Vec<String> = repo["topics"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let mut lines = vec![
        format!("{username}/{repo_name}"),
        if desc.is_empty() { String::new() } else { desc },
        format!("Language: {lang}  ★{stars}  Forks: {forks}"),
    ];
    if !topics.is_empty() {
        lines.push(format!("Topics: {}", topics.join(", ")));
    }
    lines.push(String::new());

    // README (실패해도 무시)
    let readme_api = format!("https://api.github.com/repos/{username}/{repo_name}/readme");
    if let Ok(resp) = client()
        .get(&readme_api)
        .header("User-Agent", "NekoDesk/1.0")
        .header("Accept", "application/vnd.github.raw+json")
        .send()
        .await
    {
        if let Ok(text) = resp.text().await {
            lines.push("README:".to_string());
            lines.push(text.chars().take(3000).collect());
        }
    }

    Some(ScrapResult {
        url: url.to_string(),
        title: format!("{username}/{repo_name}"),
        content: lines.join("\n"),
    })
}
