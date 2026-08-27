//! MCP stdio 전송의 순수한 부분 — 프레이밍과 응답 라우팅.
//!
//! 프로세스 관리와 분리해 둔다. 여기 있는 것들은 자식 프로세스 없이 테스트된다.

use serde_json::{json, Value};

/// stdio MCP 는 줄 단위 JSON 이다. 한 줄이 정확히 하나의 JSON-RPC 메시지.
pub fn build_request(id: i64, method: &str, params: &Value) -> String {
    format!(
        "{}\n",
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
    )
}

/// 응답 없이 보내는 알림(예: notifications/initialized).
pub fn build_notification(method: &str, params: &Value) -> String {
    format!("{}\n", json!({ "jsonrpc": "2.0", "method": method, "params": params }))
}

#[derive(Debug, PartialEq)]
pub struct RpcResponse {
    pub id: i64,
    /// 성공이면 result, 실패면 에러 메시지.
    pub outcome: Result<Value, String>,
}

/// 한 줄을 응답으로 해석한다.
///
/// 응답이 아닌 줄(서버 알림, 로그, 빈 줄, 깨진 JSON)은 None 이다. 서버가 stdout 에
/// 무엇을 흘리든 클라이언트가 죽으면 안 된다 — 실제로 부팅 배너를 찍는 서버가 있다.
pub fn parse_line(line: &str) -> Option<RpcResponse> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let id = value.get("id")?.as_i64()?;

    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("알 수 없는 MCP 오류");
        let code = error.get("code").and_then(Value::as_i64);
        return Some(RpcResponse {
            id,
            outcome: Err(match code {
                Some(c) => format!("{message} (code {c})"),
                None => message.to_string(),
            }),
        });
    }

    Some(RpcResponse {
        id,
        outcome: Ok(value.get("result").cloned().unwrap_or(Value::Null)),
    })
}

/// 설정에 적힌 명령 문자열을 프로그램 + 인자로 나눈다.
///
/// 따옴표로 묶인 인자를 지킨다 — 경로에 공백이 있는 경우가 흔하다
/// (`npx server-filesystem "/Users/kim/My Documents"`).
pub fn split_command(raw: &str) -> Option<(String, Vec<String>)> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut has_token = false;

    for ch in raw.chars() {
        match (quote, ch) {
            (Some(q), c) if c == q => {
                quote = None;
            }
            (Some(_), c) => current.push(c),
            (None, '"') | (None, '\'') => {
                quote = Some(ch);
                has_token = true;
            }
            (None, c) if c.is_whitespace() => {
                if has_token {
                    tokens.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            (None, c) => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        tokens.push(current);
    }

    let mut it = tokens.into_iter();
    let program = it.next()?;
    if program.is_empty() {
        return None;
    }
    Some((program, it.collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_one_json_object_per_line() {
        let line = build_request(7, "tools/list", &json!({}));
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);

        let parsed: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["jsonrpc"], "2.0");
        assert_eq!(parsed["id"], 7);
        assert_eq!(parsed["method"], "tools/list");
    }

    #[test]
    fn notifications_carry_no_id() {
        let line = build_notification("notifications/initialized", &json!({}));
        let parsed: Value = serde_json::from_str(line.trim()).unwrap();
        assert!(parsed.get("id").is_none());
    }

    #[test]
    fn parses_a_successful_response() {
        let r = parse_line(r#"{"jsonrpc":"2.0","id":3,"result":{"tools":[]}}"#).unwrap();
        assert_eq!(r.id, 3);
        assert_eq!(r.outcome, Ok(json!({"tools": []})));
    }

    #[test]
    fn parses_an_error_response_with_its_code() {
        let r = parse_line(r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"없는 메서드"}}"#).unwrap();
        assert_eq!(r.outcome, Err("없는 메서드 (code -32601)".to_string()));
    }

    #[test]
    fn ignores_lines_that_are_not_responses() {
        // 서버가 stdout 에 배너나 알림을 흘려도 클라이언트가 죽으면 안 된다.
        for line in [
            "",
            "   ",
            "MCP server listening...",
            r#"{"jsonrpc":"2.0","method":"notifications/message","params":{}}"#,
            r#"{"broken": "#,
        ] {
            assert!(parse_line(line).is_none(), "{line:?} 는 무시돼야 한다");
        }
    }

    #[test]
    fn result_missing_means_null_not_failure() {
        let r = parse_line(r#"{"jsonrpc":"2.0","id":1}"#).unwrap();
        assert_eq!(r.outcome, Ok(Value::Null));
    }

    #[test]
    fn splits_a_plain_command() {
        let (program, args) = split_command("npx -y @modelcontextprotocol/server-time").unwrap();
        assert_eq!(program, "npx");
        assert_eq!(args, vec!["-y", "@modelcontextprotocol/server-time"]);
    }

    #[test]
    fn keeps_quoted_paths_with_spaces_together() {
        let (_, args) = split_command(r#"npx server-fs "/Users/kim/My Documents""#).unwrap();
        assert_eq!(args, vec!["server-fs", "/Users/kim/My Documents"]);
    }

    #[test]
    fn handles_single_quotes_and_extra_whitespace() {
        let (program, args) = split_command("  uvx   'my server'  --flag  ").unwrap();
        assert_eq!(program, "uvx");
        assert_eq!(args, vec!["my server", "--flag"]);
    }

    #[test]
    fn empty_command_is_rejected() {
        assert!(split_command("").is_none());
        assert!(split_command("   ").is_none());
    }
}
