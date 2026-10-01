//! 웹 검색: DuckDuckGo lite(기본) → Brave API(키 있을 때 폴백).

use crate::error::AppError;
use crate::http::{client, urlencode};
use crate::SearchResult;

const DDG_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

pub async fn run(query: &str, brave_key: Option<String>) -> Result<Vec<SearchResult>, AppError> {
    // 1) DuckDuckGo lite — 요즘은 봇 차단(202 + anomaly 페이지)이 자주 걸리고,
    //    그때는 에러가 아니라 "결과 0개"로 온다. 그래서 빈 결과도 실패로 친다.
    if let Ok(results) = duckduckgo(query).await {
        if !results.is_empty() {
            return Ok(results);
        }
    }

    // 2) Brave Search API. 키가 없으면 여기서 끝이고, 그 사실을 호출자에게 알린다.
    //    빈 벡터를 돌려주면 "검색 결과 없음"과 "검색 자체가 죽음"이 구분되지 않아
    //    에이전트가 이유도 모른 채 답을 포기한다.
    let Some(key) = brave_key.filter(|k| !k.trim().is_empty()) else {
        return Err(AppError::msg(
            "웹 검색 실패: DuckDuckGo 가 결과를 주지 않았고 Brave Search API 키가 설정돼 있지 않다. \
             설정에서 Brave 검색 키를 넣어야 검색이 된다.",
        ));
    };
    brave(query, &key).await // 여기서 빈 벡터는 진짜 "결과 없음"이다.
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
    // Accept-Encoding 을 손으로 붙이면 안 된다. reqwest 를 gzip feature 없이 쓰므로
    // 압축된 바디를 풀지 못하고 .json() 이 "error decoding response body" 로 죽는다
    // (그래서 DDG 가 막힌 동안 검색이 전부 실패했다). 헤더를 빼면 평문으로 온다.
    let resp: serde_json::Value = client()
        .get(&url)
        .header("Accept", "application/json")
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

#[cfg(test)]
mod tests {
    use super::*;

    /// DDG 마크업이 바뀌거나 차단 페이지가 오면 셀렉터가 조용히 0개를 뱉는다.
    /// 이 테스트는 파서가 살아 있는지만 확인한다.
    #[test]
    fn parses_ddg_lite_rows() {
        let html = r#"<table>
            <tr><td class="result-snippet">스니펫</td></tr>
            <tr><td><a class="result-link" href="https://example.com">제목</a></td></tr>
        </table>"#;
        let r = parse_ddg_html(html);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].url, "https://example.com");
        assert_eq!(r[0].snippet, "스니펫");
    }

    /// 차단 페이지(결과 링크 없음)는 0개.
    #[test]
    fn blocked_page_yields_nothing() {
        assert!(parse_ddg_html("<html><body>DuckDuckGo</body></html>").is_empty());
    }
}
