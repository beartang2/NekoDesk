//! conversation_messages 테이블 접근. 세션별 최근 N개만 유지한다.

use crate::db::models::ConversationMessage;
use crate::error::AppResult;
use rusqlite::{params, Connection};

/// 세션당 보관할 최대 메시지 수. 초과분은 저장할 때마다 잘라낸다.
///
/// 예전엔 40개라 스무 번쯤 주고받으면 앞부분이 소리 없이 지워졌다. 글은 주고받기
/// 한 번에 1KB 남짓이라 5000개여도 세션당 5MB 안팎이다. 화면은 최근 것부터 나눠 그리고
/// (ChatMessages), 모델에는 자동 요약 뒤쪽만 가서 길어도 무겁지 않다.
const MAX_PER_SESSION: i64 = 5000;

const COLS: &str = "id, session_id, role, content, created_at, attachments, meta";

pub fn save(
    conn: &Connection,
    session_id: &str,
    role: &str,
    content: &str,
    attachments: Option<&str>,
    meta: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO conversation_messages (session_id, role, content, attachments, meta)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session_id, role, content, attachments, meta],
    )?;
    // 세션당 최근 MAX_PER_SESSION 개만 남기고 오래된 것 삭제
    conn.execute(
        "DELETE FROM conversation_messages WHERE session_id = ?1 AND id NOT IN (
             SELECT id FROM conversation_messages WHERE session_id = ?1
             ORDER BY id DESC LIMIT ?2
         )",
        params![session_id, MAX_PER_SESSION],
    )?;
    Ok(())
}

/// 동기화 순서(ts, 기기, id)로 — 두 기기가 따로 쓴 말은 시각순으로 섞인다(docs/neko-sync.md §2.3).
/// 한 기기 안에선 id 순서와 같다.
pub fn load(conn: &Connection, session_id: &str) -> AppResult<Vec<ConversationMessage>> {
    let cols = COLS.split(", ").map(|c| format!("c.{c}")).collect::<Vec<_>>().join(", ");
    let sql = format!(
        "SELECT {cols} FROM conversation_messages c
         LEFT JOIN sync_meta s ON s.coll = 'msg' AND s.local_key = CAST(c.id AS TEXT)
         WHERE c.session_id = ?1 ORDER BY s.ts, s.device, c.id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![session_id], |r| ConversationMessage::try_from(r))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn delete(conn: &Connection, session_id: &str) -> AppResult<()> {
    conn.execute(
        "DELETE FROM conversation_messages WHERE session_id = ?1",
        params![session_id],
    )?;
    Ok(())
}

/// 마지막 메시지가 `days` 일보다 오래된 세션을 통째로 지우고 그 id 를 돌려준다. `keep`(지금 열린 세션)은
/// 빼고. 메시지가 하나도 없는 세션은 언제 썼는지 몰라서 걸리지 않는다.
pub fn prune(conn: &Connection, days: u32, keep: &[String]) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT session_id FROM conversation_messages GROUP BY session_id
         HAVING MAX(created_at) < datetime('now', ?1)",
    )?;
    let old = stmt.query_map(params![format!("-{days} days")], |r| r.get::<_, String>(0))?;
    let gone: Vec<String> = old.collect::<Result<Vec<_>, _>>()?.into_iter().filter(|id| !keep.contains(id)).collect();
    for id in &gone {
        delete(conn, id)?;
    }
    Ok(gone)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&c).unwrap();
        c
    }

    #[test]
    fn save_load_roundtrip_in_order() {
        let c = setup();
        save(&c, "s1", "user", "안녕", None, None).unwrap();
        save(&c, "s1", "assistant", "반가워 🐱", None, None).unwrap();
        let msgs = load(&c, "s1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content, "안녕"); // id ASC
        assert_eq!(msgs[1].role, "assistant");
    }

    #[test]
    fn keeps_attachments_with_the_message() {
        // 껐다 켠 뒤에도 붙였던 이미지가 미리보기로 남아야 한다.
        let c = setup();
        let json = r#"[{"name":"cat.png","type":"image/png","size":1234,"dataUrl":"data:image/png;base64,AA"}]"#;
        save(&c, "s1", "user", "이거 뭐야", Some(json), None).unwrap();
        save(&c, "s1", "assistant", "고양이야", None, None).unwrap();

        let msgs = load(&c, "s1").unwrap();
        assert_eq!(msgs[0].attachments.as_deref(), Some(json));
        assert_eq!(msgs[1].attachments, None);
    }

    #[test]
    fn trims_to_max_per_session() {
        let c = setup();
        let total = MAX_PER_SESSION + 10;
        for i in 0..total {
            save(&c, "s1", "user", &format!("m{i}"), None, None).unwrap();
        }
        let msgs = load(&c, "s1").unwrap();
        assert_eq!(msgs.len(), MAX_PER_SESSION as usize);
        assert_eq!(msgs.last().unwrap().content, format!("m{}", total - 1)); // 최신은 남는다
    }

    #[test]
    fn keeps_meta_with_the_message() {
        // 다시 열어도 도구 기록이 남아야 한다.
        let c = setup();
        let meta = r#"{"steps":[{"tool":"web.search"}]}"#;
        save(&c, "s1", "assistant", "찾았어", None, Some(meta)).unwrap();
        assert_eq!(load(&c, "s1").unwrap()[0].meta.as_deref(), Some(meta));
    }

    #[test]
    fn prunes_sessions_whose_last_message_is_old() {
        let c = setup();
        let at = |s: &str, ago: &str| {
            c.execute(
                "INSERT INTO conversation_messages (session_id, role, content, created_at) VALUES (?1, 'user', 'x', datetime('now', ?2))",
                params![s, ago],
            )
            .unwrap();
        };
        at("old", "-40 days");
        at("old", "-31 days");
        at("revived", "-60 days"); // 옛날에 시작했어도 어제 썼으면 남는다
        at("revived", "-1 days");
        at("open", "-95 days"); // 지금 열린 세션
        at("fresh", "-0 days");
        let gone = prune(&c, 30, &["open".to_string()]).unwrap();
        assert_eq!(gone, vec!["old".to_string()]);
        assert!(load(&c, "old").unwrap().is_empty());
        assert_eq!(load(&c, "revived").unwrap().len(), 2);
        assert_eq!(load(&c, "open").unwrap().len(), 1);
        assert_eq!(prune(&c, 90, &[]).unwrap(), vec!["open".to_string()]);
    }

    #[test]
    fn sessions_are_isolated() {
        let c = setup();
        save(&c, "a", "user", "x", None, None).unwrap();
        save(&c, "b", "user", "y", None, None).unwrap();
        delete(&c, "a").unwrap();
        assert!(load(&c, "a").unwrap().is_empty());
        assert_eq!(load(&c, "b").unwrap().len(), 1);
    }
}
