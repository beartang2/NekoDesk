//! conversation_messages 테이블 접근. 세션별 최근 N개만 유지한다.

use crate::db::models::ConversationMessage;
use crate::error::AppResult;
use rusqlite::{params, Connection};

/// 세션당 보관할 최대 메시지 수. 초과분은 저장할 때마다 잘라낸다.
const MAX_PER_SESSION: i64 = 40;

const COLS: &str = "id, session_id, role, content, created_at, attachments";

pub fn save(
    conn: &Connection,
    session_id: &str,
    role: &str,
    content: &str,
    attachments: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO conversation_messages (session_id, role, content, attachments)
         VALUES (?1, ?2, ?3, ?4)",
        params![session_id, role, content, attachments],
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

pub fn load(conn: &Connection, session_id: &str) -> AppResult<Vec<ConversationMessage>> {
    let sql = format!(
        "SELECT {COLS} FROM conversation_messages WHERE session_id = ?1 ORDER BY id ASC"
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
        save(&c, "s1", "user", "안녕", None).unwrap();
        save(&c, "s1", "assistant", "반가워 🐱", None).unwrap();
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
        save(&c, "s1", "user", "이거 뭐야", Some(json)).unwrap();
        save(&c, "s1", "assistant", "고양이야", None).unwrap();

        let msgs = load(&c, "s1").unwrap();
        assert_eq!(msgs[0].attachments.as_deref(), Some(json));
        assert_eq!(msgs[1].attachments, None);
    }

    #[test]
    fn trims_to_max_per_session() {
        let c = setup();
        for i in 0..50 {
            save(&c, "s1", "user", &format!("m{i}"), None).unwrap();
        }
        let msgs = load(&c, "s1").unwrap();
        assert_eq!(msgs.len(), MAX_PER_SESSION as usize);
        assert_eq!(msgs.last().unwrap().content, "m49"); // 최신은 남는다
    }

    #[test]
    fn sessions_are_isolated() {
        let c = setup();
        save(&c, "a", "user", "x", None).unwrap();
        save(&c, "b", "user", "y", None).unwrap();
        delete(&c, "a").unwrap();
        assert!(load(&c, "a").unwrap().is_empty());
        assert_eq!(load(&c, "b").unwrap().len(), 1);
    }
}
