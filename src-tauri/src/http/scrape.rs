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

/// 본문 글자 상한. 모델별로 얼마나 넘길지는 화면 쪽(web.scrape summarize)이 정한다.
const MAX_CHARS: usize = 20_000;
/// 페이지 대표 이미지 주소 몇 개까지 돌려줄지.
const MAX_IMAGES: usize = 3;

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
        .map(|n| own_text(n, &content_sel).trim().to_string())
        .filter(|s| s.len() > 15)
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(MAX_CHARS)
        .collect();

    let images = reqwest::Url::parse(url).map(|base| page_images(&base, &document)).unwrap_or_default();
    ScrapResult { url: url.to_string(), title, content, images }
}

/// 이 태그가 직접 품은 글만 — 안에 든 다른 본문 태그(article 안의 p 등)의 글은 그 태그 몫이다.
/// 통째로 모으면 article 이 본문 전체를 한 번, 그 안의 p 가 또 한 번 담아 같은 글이 두 번 들어갔다.
fn own_text(n: scraper::ElementRef, sel: &scraper::Selector) -> String {
    n.descendants()
        .filter_map(|d| d.value().as_text().map(|t| (d, t)))
        .filter(|(d, _)| {
            d.ancestors()
                .filter_map(scraper::ElementRef::wrap)
                .find(|a| sel.matches(a))
                .is_some_and(|a| a.id() == n.id())
        })
        .map(|(_, t)| &**t)
        .collect()
}

/// 대표 이미지 주소: og:image·twitter:image 먼저, 그다음 본문 img. 아이콘·로고·SVG·작은 그림은 뺀다.
fn page_images(base: &reqwest::Url, doc: &scraper::Html) -> Vec<String> {
    let meta = scraper::Selector::parse(
        r#"meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"]"#,
    )
    .unwrap();
    let img = scraper::Selector::parse("img").unwrap();
    let small = |e: &scraper::ElementRef| {
        ["width", "height"]
            .iter()
            .any(|k| e.value().attr(k).and_then(|v| v.trim_end_matches("px").parse::<u32>().ok()).is_some_and(|v| v < 120))
    };
    let metas = doc.select(&meta).filter_map(|m| m.value().attr("content"));
    let imgs = doc
        .select(&img)
        .filter(|e| !small(e))
        .filter_map(|e| e.value().attr("src").or_else(|| e.value().attr("data-src")));
    let mut out: Vec<String> = Vec::new();
    for raw in metas.chain(imgs) {
        let Ok(u) = base.join(raw.trim()) else { continue };
        let path = u.path().to_ascii_lowercase();
        if !matches!(u.scheme(), "http" | "https")
            || path.ends_with(".svg")
            || ["logo", "icon", "avatar", "sprite", "pixel", "badge", "emoji"].iter().any(|w| path.contains(w))
        {
            continue;
        }
        let s = u.to_string();
        if !out.contains(&s) {
            out.push(s);
        }
        if out.len() == MAX_IMAGES {
            break;
        }
    }
    out
}

/// 이미지 한 장을 data URL 로 받는다 — 모델이 페이지 대표 이미지를 직접 볼 때.
/// 주소는 모델이 고르므로 SSRF 가드를 거치고, 래스터 이미지만·4MB 까지만 받는다.
pub async fn image(url: &str) -> Result<String, AppError> {
    use base64::Engine;
    const MAX_BYTES: usize = 4 * 1024 * 1024;
    validate_public_url(url)?;
    let res = client().get(url).header("User-Agent", SCRAPE_UA).send().await?;
    if !res.status().is_success() {
        return Err(AppError::msg(format!("이미지를 못 받았어({}).", res.status().as_u16())));
    }
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/webp" | "image/gif") {
        return Err(AppError::msg("사진 이미지(png·jpeg·webp·gif)가 아니야."));
    }
    if res.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err(AppError::msg("이미지가 너무 커."));
    }
    let bytes = res.bytes().await?;
    if bytes.len() > MAX_BYTES {
        return Err(AppError::msg("이미지가 너무 커."));
    }
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
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
        images: Vec::new(),
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
        images: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn article_text_is_not_doubled_and_images_are_picked() {
        let html = r#"<html><head><title>T</title>
            <meta property="og:image" content="/hero.jpg"></head><body>
            <article>Article intro text that sits outside paragraphs.
              <p>First paragraph with enough words.</p><p>Second paragraph with enough words.</p></article>
            <img src="/site-logo.png"><img src="https://cdn.example/a.svg"><img src="/tiny.jpg" width="16">
            <img src="photo.webp"><img data-src="/lazy.jpg"><img src="/more.jpg">
            </body></html>"#;
        let r = extract_readable("https://example.com/post/1", html);
        assert_eq!(r.content.matches("First paragraph").count(), 1, "{}", r.content);
        assert!(r.content.contains("Article intro text"), "{}", r.content);
        assert_eq!(
            r.images,
            ["https://example.com/hero.jpg", "https://example.com/post/photo.webp", "https://example.com/lazy.jpg"]
        );
    }
}
