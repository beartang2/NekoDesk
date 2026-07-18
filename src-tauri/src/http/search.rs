//! 웹 검색: DuckDuckGo lite(기본) → Brave API(키 있을 때 폴백).

use crate::error::AppError;
use crate::http::{client, urlencode};
use crate::SearchResult;

const DDG_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

pub async fn run(query: &str, brave_key: Option<String>) -> Result<Vec<SearchResult>, AppError> {
    // 1) DuckDuckGo lite — 실패하거나 빈 결과면 폴백으로 넘어간다.
    if let Ok(results) = duckduckgo(query).await {
        if !results.is_empty() {
            return Ok(results);
        }
    }

    // 2) Brave Search API (키가 설정된 경우에만)
    if let Some(key) = brave_key.filter(|k| !k.trim().is_empty()) {
        if let Ok(results) = brave(query, &key).await {
            if !results.is_empty() {
                return Ok(results);
            }
        }
    }

    Ok(vec![])
}

async fn duckduckgo(query: &str) -> Result<Vec<SearchResult>, AppError> {
    let url = format!("https://lite.duckduckgo.com/lite/?q={}", urlencode(query));
    let html = client()
        .get(&url)
        .header("User-Agent", DDG_UA)
        .header("Accept", "text/html,application/xhtml+xml")
        .header("Accept-Language", "en-US,en;q=0.9,ko;q=0.8")
        .send()
        .await?
        .text()
        .await?;
    // 파싱은 동기. scraper::Html 은 !Send 라 절대 await 를 건너선 안 된다.
    Ok(parse_ddg_html(&html))
}

/// scraper::Html 을 여기 안에서만 만들고 소비한다. await 없음 → 미래가 Send 유지.
fn parse_ddg_html(html: &str) -> Vec<SearchResult> {
    let document = scraper::Html::parse_document(html);
    let link_sel = scraper::Selector::parse("a.result-link").unwrap();
    let snippet_sel = scraper::Selector::parse("td.result-snippet").unwrap();
    let links: Vec<_> = document.select(&link_sel).collect();
    let snippets: Vec<_> = document.select(&snippet_sel).collect();

    let mut results = Vec::new();
    for (i, node) in links.iter().enumerate().take(5) {
        let title = node.text().collect::<String>().trim().to_string();
        let href = node.value().attr("href").unwrap_or("").to_string();
        let snippet = snippets
            .get(i)
            .map(|n| n.text().collect::<String>().trim().to_string())
            .unwrap_or_default();
        if !title.is_empty() && !href.is_empty() {
            results.push(SearchResult { title, url: href, snippet });
        }
    }
    results
}

async fn brave(query: &str, key: &str) -> Result<Vec<SearchResult>, AppError> {
    let url = format!(
        "https://api.search.brave.com/res/v1/web/search?q={}&count=5&search_lang=en",
        urlencode(query)
    );
    let resp: serde_json::Value = client()
        .get(&url)
        .header("Accept", "application/json")
        .header("Accept-Encoding", "gzip")
        .header("X-Subscription-Token", key.trim())
        .send()
        .await?
        .json()
        .await?;

    let mut results = Vec::new();
    if let Some(items) = resp["web"]["results"].as_array() {
        for item in items.iter().take(5) {
            let title = item["title"].as_str().unwrap_or("").to_string();
            let url = item["url"].as_str().unwrap_or("").to_string();
            let snippet = item["description"].as_str().unwrap_or("").to_string();
            if !title.is_empty() && !url.is_empty() {
                results.push(SearchResult { title, url, snippet });
            }
        }
    }
    Ok(results)
}
