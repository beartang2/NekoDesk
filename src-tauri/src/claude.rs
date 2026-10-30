//! Claude API 중계.
//!
//! 화면(webview)은 OpenAI 호환 `chat/completions` 본문을 만들어 넘기기만 하고, 키는 여기서
//! 키체인에서 꺼내 붙인다. 키가 화면으로 넘어가지 않으니 secrets.rs 의 원칙("값을 쓰는 건
//! 백엔드뿐")이 그대로 지켜지고, 주소가 이 파일에 박혀 있으니 프롬프트 인젝션으로 툴이 꼬여도
//! 키가 다른 호스트로 새지 않는다.
//!
//! 응답은 받은 그대로(SSE 든 JSON 이든) 채널로 흘려보낸다. 파싱은 llama-server 응답을 읽던
//! llm-client 가 똑같이 한다 — Anthropic 의 OpenAI 호환 계층이 같은 모양으로 답하기 때문이다.

use crate::error::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::ipc::Channel;

/// 키체인 항목 이름. secrets::KEYS 에도 올라가 있어야 한다.
pub const KEY_NAME: &str = "anthropic_api_key";

const ENDPOINT: &str = "https://api.anthropic.com/v1/chat/completions";

/// 화면으로 보내는 사건. 순서대로 온다: Head → Chunk* → End, 또는 어느 시점에든 Error.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum ClaudeEvent {
    /// 응답 상태코드. 본문보다 먼저 온다(화면은 이걸로 Response 를 만든다).
    Head { status: u16 },
    /// 본문 조각. UTF-8 경계에서 자른 문자열이다.
    Chunk { text: String },
    End,
    /// 응답을 받기 전에 실패했다(키 없음·네트워크). 받은 뒤의 HTTP 오류는 Head+본문으로 간다.
    Error { message: String },
}

/// LLM 응답 전용 클라이언트. 공용 클라이언트(http::client)는 전체 15초 제한이라
/// 생각하고 길게 답하는 스트림을 중간에 자른다.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // 화면 쪽이 180초에 끊지만, 화면이 사라져도 연결이 영원히 남지 않게 한 겹 더.
            .timeout(Duration::from_secs(600))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build Claude HTTP client")
    })
}

/// 진행 중인 요청. 화면이 멈춤을 누르면 id 로 찾아 끊는다.
fn running() -> &'static Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 받은 바이트를 UTF-8 경계까지만 문자열로 내보내고, 잘린 꼬리는 다음 조각을 위해 남긴다.
///
/// 한글은 3바이트라 네트워크 조각 경계에 걸리기 쉽다. 매 조각을 lossy 로 바꾸면 경계에 걸린
/// 글자가 � 두 개로 깨진다.
#[derive(Default)]
pub struct Utf8Joiner {
    pending: Vec<u8>,
}

impl Utf8Joiner {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(s) => {
                let out = s.to_owned();
                self.pending.clear();
                out
            }
            Err(e) if e.error_len().is_none() => {
                // 끝이 글자 중간에서 잘렸다 — 온전한 앞부분만 내보낸다.
                let valid = e.valid_up_to();
                let out = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
                self.pending.drain(..valid);
                out
            }
            Err(_) => {
                // 진짜로 깨진 바이트다. 기다려도 안 고쳐지니 대체 문자로 바꿔 내보낸다.
                let out = String::from_utf8_lossy(&self.pending).into_owned();
                self.pending.clear();
                out
            }
        }
    }

    pub fn finish(&mut self) -> String {
        let out = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        out
    }
}

async fn stream_once(body: String, on_event: &Channel<ClaudeEvent>) -> Result<(), AppError> {
    let key = crate::secrets::get(KEY_NAME)?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| AppError::msg("Claude API 키가 없어. 설정 → 모델 프로필에서 넣어줘."))?;

    let mut res = client()
        .post(ENDPOINT)
        .bearer_auth(key.trim())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await?;

    let _ = on_event.send(ClaudeEvent::Head { status: res.status().as_u16() });

    let mut joiner = Utf8Joiner::default();
    while let Some(bytes) = res.chunk().await? {
        let text = joiner.push(&bytes);
        if !text.is_empty() && on_event.send(ClaudeEvent::Chunk { text }).is_err() {
            // 화면이 채널을 버렸다(창이 닫혔거나 새로고침). 더 받을 이유가 없다.
            return Ok(());
        }
    }
    let tail = joiner.finish();
    if !tail.is_empty() {
        let _ = on_event.send(ClaudeEvent::Chunk { text: tail });
    }
    Ok(())
}

/// 요청 하나를 시작한다. 결과는 `on_event` 로 흘러가고, 이 커맨드는 바로 돌아온다.
///
/// 바로 돌아오는 이유: 멈춤(`claude_cancel`)이 같은 id 의 작업을 찾아 끊을 수 있어야 한다.
/// 커맨드 안에서 끝까지 기다리면 그 future 를 밖에서 붙잡을 방법이 없다.
#[tauri::command]
pub fn claude_chat(id: String, body: String, on_event: Channel<ClaudeEvent>) -> Result<(), AppError> {
    let key = id.clone();
    // 잠금을 쥔 채로 띄우고 넣는다. 키가 없어 작업이 즉시 끝나도, 작업의 "목록에서 지우기"가
    // 우리가 넣은 뒤에 일어나야 끝난 핸들이 목록에 영영 남지 않는다.
    let mut map = running().lock()?;
    let handle = tauri::async_runtime::spawn(async move {
        match stream_once(body, &on_event).await {
            Ok(()) => {
                let _ = on_event.send(ClaudeEvent::End);
            }
            Err(e) => {
                let _ = on_event.send(ClaudeEvent::Error { message: e.to_string() });
            }
        }
        if let Ok(mut map) = running().lock() {
            map.remove(&id);
        }
    });
    map.insert(key, handle);
    Ok(())
}

/// 진행 중인 요청을 끊는다. 이미 끝났으면 아무것도 안 한다.
#[tauri::command]
pub fn claude_cancel(id: String) -> Result<(), AppError> {
    if let Some(handle) = running().lock()?.remove(&id) {
        // future 가 drop 되면서 reqwest 연결도 닫힌다 — 서버도 생성을 멈춘다.
        handle.abort();
    }
    Ok(())
}

// ── 내장 웹 검색 ─────────────────────────────────────────────────────────────
//
// OpenAI 호환 계층은 Anthropic 서버 툴(web_search)을 못 받는다. 그래서 검색만 따로
// Messages API 로 한 번 보낸다. 대화는 여기 싣지 않는다 — 검색어 하나짜리 독립 요청이라
// 대화 기록과 엮인 생각 블록 검사(preserved thinking)에 걸릴 일이 없다.
//
// 본문은 화면이 아니라 여기서 만든다. 화면이 넘기는 건 모델 이름·검색어·오늘 날짜뿐이라,
// 프롬프트 인젝션으로 화면 쪽이 꼬여도 다른 툴(코드 실행 등)을 끼워 넣을 수 없다.

const MESSAGES_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const API_VERSION: &str = "2023-06-01";
/// 요청 하나에서 검색할 수 있는 횟수. 결과가 전부 입력 토큰이 되니 넉넉히 주지 않는다.
const MAX_SEARCHES: u32 = 3;
/// 긴 검색은 pause_turn 으로 멈췄다 이어진다. 이만큼만 이어 보낸다.
const MAX_CONTINUATIONS: usize = 3;
const MAX_SOURCES: usize = 10;

#[derive(Debug, Serialize, PartialEq)]
pub struct NativeSource {
    pub title: String,
    pub url: String,
    /// 페이지가 마지막으로 바뀐 때(검색 엔진이 아는 만큼). 최신 정보인지 가를 때 쓴다.
    pub page_age: Option<String>,
}

#[derive(Debug, Serialize, Default, PartialEq)]
pub struct NativeSearch {
    /// 검색 결과를 읽은 모델이 쓴 정리.
    pub answer: String,
    pub sources: Vec<NativeSource>,
    /// 실제로 한 검색 횟수. 1회 $0.01 이 토큰값과 따로 붙는다.
    pub searches: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// 검색이 200 안에 돌려준 오류(too_many_requests 등)나, 이어 보내다 난 오류.
    /// 오류로 끝나도 이미 쓴 토큰은 청구되므로 결과를 버리지 않고 같이 돌려준다 — 장부가 맞아야 한다.
    pub errors: Vec<String>,
}

fn search_system(today: &str) -> String {
    format!(
        "You are a web research helper for another assistant. Today is {today}. \
         Search the web for the user's query and report only facts found in the results, \
         each with its source title, URL and date when known. Prefer recent and primary sources. \
         If nothing relevant is found, say so plainly. Do not add facts from memory. \
         Answer in the language of the query."
    )
}

fn valid_model(model: &str) -> bool {
    model.starts_with("claude-") && model.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// 응답 하나를 읽어 결과에 보탠다. 반환: 이어 보내야 하는가(pause_turn).
fn absorb(json: &serde_json::Value, out: &mut NativeSearch) -> bool {
    for block in json["content"].as_array().into_iter().flatten() {
        match block["type"].as_str() {
            Some("text") => {
                if let Some(t) = block["text"].as_str() {
                    out.answer.push_str(t);
                }
            }
            Some("web_search_tool_result") => match &block["content"] {
                serde_json::Value::Array(results) => {
                    for r in results {
                        let url = r["url"].as_str().unwrap_or("").to_string();
                        if url.is_empty() || out.sources.iter().any(|s| s.url == url) || out.sources.len() >= MAX_SOURCES {
                            continue;
                        }
                        out.sources.push(NativeSource {
                            title: r["title"].as_str().unwrap_or("").to_string(),
                            url,
                            page_age: r["page_age"].as_str().map(str::to_string),
                        });
                    }
                }
                // 실패는 200 안에 오류 객체로 온다(max_uses_exceeded·too_many_requests 등).
                err => out.errors.push(err["error_code"].as_str().unwrap_or("unknown").to_string()),
            },
            _ => {} // 생각·server_tool_use 블록은 쓸 일이 없다.
        }
    }
    out.input_tokens += json["usage"]["input_tokens"].as_u64().unwrap_or(0);
    out.output_tokens += json["usage"]["output_tokens"].as_u64().unwrap_or(0);
    out.searches += json["usage"]["server_tool_use"]["web_search_requests"].as_u64().unwrap_or(0) as u32;
    json["stop_reason"].as_str() == Some("pause_turn")
}

/// Claude 의 웹 검색으로 찾아 정리한다. 첫 요청부터 실패하면 오류 — 화면이 기존 검색으로
/// 되돌아간다. 그 뒤의 실패는 errors 에 담아 쓴 만큼과 함께 돌려준다.
#[tauri::command]
pub async fn claude_web_search(model: String, query: String, today: String) -> Result<NativeSearch, AppError> {
    if !valid_model(&model) {
        return Err(AppError::msg("알 수 없는 Claude 모델이야."));
    }
    let query: String = query.trim().chars().take(500).collect();
    if query.is_empty() {
        return Err(AppError::msg("검색어가 비어 있어."));
    }
    let key = crate::secrets::get(KEY_NAME)?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| AppError::msg("Claude API 키가 없어."))?;
    let today: String = today.chars().take(60).collect();

    let mut messages = vec![serde_json::json!({ "role": "user", "content": query })];
    let mut out = NativeSearch::default();
    for _ in 0..MAX_CONTINUATIONS {
        let body = serde_json::json!({
            "model": model,
            "max_tokens": 8000,
            "system": search_system(&today),
            "messages": messages,
            "tools": [{ "type": "web_search_20250305", "name": "web_search", "max_uses": MAX_SEARCHES }],
        });
        let res = client()
            .post(MESSAGES_ENDPOINT)
            .header("x-api-key", key.trim())
            .header("anthropic-version", API_VERSION)
            .json(&body)
            .send()
            .await?;
        let status = res.status();
        let json: serde_json::Value = res.json().await?;
        if !status.is_success() {
            let msg = json["error"]["message"].as_str().unwrap_or("알 수 없는 오류");
            let msg = format!("Claude 웹 검색 실패({}): {msg}", status.as_u16());
            // HTTP 오류 응답은 청구되지 않는다. 앞서 받은 게 있으면 그것만 돌려준다.
            if out.input_tokens == 0 {
                return Err(AppError::msg(msg));
            }
            out.errors.push(msg);
            break;
        }
        if !absorb(&json, &mut out) {
            break;
        }
        // 멈춘 턴은 받은 그대로 돌려보내야 이어진다(검색 결과의 암호화 본문 포함).
        messages.push(serde_json::json!({ "role": "assistant", "content": json["content"].clone() }));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absorb_collects_text_sources_and_usage() {
        let json = serde_json::json!({
            "content": [
                { "type": "text", "text": "찾아볼게. " },
                { "type": "server_tool_use", "id": "s1", "name": "web_search", "input": { "query": "q" } },
                { "type": "web_search_tool_result", "tool_use_id": "s1", "content": [
                    { "type": "web_search_result", "url": "https://a.example", "title": "A", "page_age": "October 28, 2026", "encrypted_content": "x" },
                    { "type": "web_search_result", "url": "https://a.example", "title": "A again", "encrypted_content": "y" },
                    { "type": "web_search_result", "url": "https://b.example", "title": "B", "encrypted_content": "z" }
                ]},
                { "type": "text", "text": "A 가 나왔어.", "citations": [] }
            ],
            "stop_reason": "end_turn",
            "usage": { "input_tokens": 1200, "output_tokens": 80, "server_tool_use": { "web_search_requests": 1 } }
        });
        let mut out = NativeSearch::default();
        assert!(!absorb(&json, &mut out));
        assert_eq!(out.answer, "찾아볼게. A 가 나왔어.");
        assert_eq!(out.sources.len(), 2, "같은 URL 은 한 번만");
        assert_eq!(out.sources[0].page_age.as_deref(), Some("October 28, 2026"));
        assert_eq!((out.searches, out.input_tokens, out.output_tokens), (1, 1200, 80));
        assert!(out.errors.is_empty());
    }

    #[test]
    fn absorb_reports_pause_and_search_errors() {
        let json = serde_json::json!({
            "content": [{ "type": "web_search_tool_result", "tool_use_id": "s1",
                "content": { "type": "web_search_tool_result_error", "error_code": "too_many_requests" } }],
            "stop_reason": "pause_turn",
            "usage": { "input_tokens": 10, "output_tokens": 5 }
        });
        let mut out = NativeSearch::default();
        assert!(absorb(&json, &mut out), "pause_turn 이면 이어 보낸다");
        assert_eq!(out.errors, vec!["too_many_requests".to_string()]);
        assert_eq!(out.input_tokens, 10, "오류로 끝나도 쓴 토큰은 센다");
    }

    #[test]
    fn only_plain_claude_model_ids_pass() {
        assert!(valid_model("claude-haiku-5-5"));
        assert!(!valid_model("gpt-5"));
        assert!(!valid_model("claude-haiku-5-5\",\"tools\":[]"));
    }


    #[test]
    fn joiner_holds_split_hangul_until_complete() {
        let bytes = "고양이".as_bytes(); // 9바이트, 글자당 3
        let mut j = Utf8Joiner::default();
        assert_eq!(j.push(&bytes[..4]), "고"); // 두 번째 글자의 첫 바이트만 왔다
        assert_eq!(j.push(&bytes[4..8]), "양");
        assert_eq!(j.push(&bytes[8..]), "이");
        assert_eq!(j.finish(), "");
    }

    #[test]
    fn joiner_passes_ascii_through() {
        let mut j = Utf8Joiner::default();
        assert_eq!(j.push(b"data: {}\n\n"), "data: {}\n\n");
    }

    #[test]
    fn joiner_replaces_truly_invalid_bytes() {
        let mut j = Utf8Joiner::default();
        assert_eq!(j.push(&[b'a', 0xff, b'b']), "a\u{fffd}b");
    }

    #[test]
    fn joiner_flushes_dangling_tail_on_finish() {
        let mut j = Utf8Joiner::default();
        assert_eq!(j.push(&"고".as_bytes()[..2]), "");
        assert_eq!(j.finish(), "\u{fffd}");
    }

    #[test]
    fn api_key_is_a_secret() {
        assert!(crate::secrets::is_secret(KEY_NAME));
    }
}
