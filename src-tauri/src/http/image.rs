//! 이미지 생성 (Cloudflare Workers AI / Google Gemini).
//!
//! 키는 DB settings 에만 있고 커맨드가 거기서 꺼내 넘긴다. 호스트가 고정이라
//! SSRF 검사는 필요 없다. 모델 이름은 설정 화면에서 오지 LLM 이 고르지 않는다.

use super::client;
use crate::error::AppError;
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use std::time::Duration;

/// 그림은 공용 클라이언트의 15초보다 오래 걸린다.
const TIMEOUT: Duration = Duration::from_secs(90);

pub async fn cloudflare(account_id: &str, token: &str, model: &str, prompt: &str) -> Result<String, AppError> {
    if account_id.trim().is_empty() || token.trim().is_empty() {
        return Err(AppError::msg("설정 > 연동에 Cloudflare 계정 ID 와 API 토큰을 넣어줘."));
    }
    let url = format!(
        "https://api.cloudflare.com/client/v4/accounts/{}/ai/run/{}",
        account_id.trim(),
        model.trim()
    );
    let resp = client()
        .post(&url)
        .bearer_auth(token.trim())
        .timeout(TIMEOUT)
        .json(&json!({ "prompt": prompt }))
        .send()
        .await?;
    let status = resp.status();
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.bytes().await?;
    if !status.is_success() {
        return Err(api_error("Cloudflare", status, &body));
    }
    // SDXL 계열은 PNG 바이트를 그대로, FLUX 는 JSON 안에 base64 JPEG 를 준다.
    if mime.starts_with("image/") {
        return Ok(format!("data:{mime};base64,{}", general_purpose::STANDARD.encode(&body)));
    }
    let json: Value = serde_json::from_slice(&body).map_err(|_| AppError::msg("Cloudflare 응답을 읽지 못했어."))?;
    json["result"]["image"]
        .as_str()
        .map(|b64| format!("data:image/jpeg;base64,{b64}"))
        .ok_or_else(|| AppError::msg("Cloudflare 가 이미지를 돌려주지 않았어."))
}

pub async fn google(key: &str, model: &str, prompt: &str) -> Result<String, AppError> {
    if key.trim().is_empty() {
        return Err(AppError::msg("설정 > 연동에 Google API 키를 넣어줘."));
    }
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model.trim()
    );
    let resp = client()
        .post(&url)
        .header("x-goog-api-key", key.trim())
        .timeout(TIMEOUT)
        .json(&json!({
            "contents": [{ "parts": [{ "text": prompt }] }],
            // TEXT 도 받아야 거절할 때 이유가 온다.
            "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] },
        }))
        .send()
        .await?;
    let status = resp.status();
    let body = resp.bytes().await?;
    if !status.is_success() {
        return Err(api_error("Google", status, &body));
    }
    let json: Value = serde_json::from_slice(&body).map_err(|_| AppError::msg("Google 응답을 읽지 못했어."))?;
    pick_gemini_image(&json)
}

/// REST 응답은 camelCase 인데 문서 예시엔 snake_case 도 섞여 있다. 둘 다 받는다.
fn pick_gemini_image(json: &Value) -> Result<String, AppError> {
    let candidate = &json["candidates"][0];
    let mut text = String::new();
    for part in candidate["content"]["parts"].as_array().into_iter().flatten() {
        let inline = if part["inlineData"].is_object() { &part["inlineData"] } else { &part["inline_data"] };
        if let Some(data) = inline["data"].as_str() {
            let mime = inline["mimeType"].as_str().or(inline["mime_type"].as_str()).unwrap_or("image/png");
            return Ok(format!("data:{mime};base64,{data}"));
        }
        if let Some(t) = part["text"].as_str() {
            text.push_str(t);
        }
    }
    // 안전 필터에 걸리면 이미지 없이 설명이나 finishReason 만 온다.
    let reason = if text.trim().is_empty() {
        candidate["finishReason"]
            .as_str()
            .or(json["promptFeedback"]["blockReason"].as_str())
            .unwrap_or("이유 없음")
            .to_string()
    } else {
        text
    };
    Err(AppError::msg(format!("Google 이 그림을 그리지 않았어: {reason}")))
}

fn api_error(who: &str, status: reqwest::StatusCode, body: &[u8]) -> AppError {
    let text: String = String::from_utf8_lossy(body).chars().take(300).collect();
    AppError::msg(format!("{who} 오류 (HTTP {}): {text}", status.as_u16()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_gemini_image_or_reports_refusal() {
        let ok = json!({ "candidates": [{ "content": { "parts": [
            { "text": "여기" },
            { "inlineData": { "mimeType": "image/png", "data": "AAAA" } }
        ] } }] });
        assert_eq!(pick_gemini_image(&ok).unwrap(), "data:image/png;base64,AAAA");

        let snake = json!({ "candidates": [{ "content": { "parts": [
            { "inline_data": { "mime_type": "image/jpeg", "data": "BBBB" } }
        ] } }] });
        assert_eq!(pick_gemini_image(&snake).unwrap(), "data:image/jpeg;base64,BBBB");

        let refused = json!({ "candidates": [{ "finishReason": "IMAGE_SAFETY", "content": { "parts": [] } }] });
        assert!(pick_gemini_image(&refused).unwrap_err().to_string().contains("IMAGE_SAFETY"));
    }
}
