//! todos 테이블 접근. 전부 순수 함수(`&Connection` 입력) → 인메모리 DB로
//! 단위 테스트 가능. 커맨드는 이 함수들을 얇게 감싸기만 한다.

use crate::db::models::Todo;
use crate::error::AppResult;
use rusqlite::{params, Connection};

const COLS: &str = "id, content, status, priority, due_at, created_at, completed_at";

/// 열린 할 일 (마감 임박순, 최대 20개).
pub fn list_open(conn: &Connection) -> AppResult<Vec<Todo>> {
    let sql = format!(
        "SELECT {COLS} FROM todos WHERE status = 'open'
         ORDER BY due_at ASC NULLS LAST, created_at DESC LIMIT 20"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| Todo::try_from(r))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 완료된 할 일 (최근 완료순, 최대 20개).
pub fn list_done(conn: &Connection) -> AppResult<Vec<Todo>> {
    let sql = format!(
        "SELECT {COLS} FROM todos WHERE status = 'done'
         ORDER BY completed_at DESC LIMIT 20"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| Todo::try_from(r))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 추가하고 방금 만든 행을 그대로 반환한다.
pub fn add(conn: &Connection, content: &str, due_at: Option<&str>) -> AppResult<Todo> {
    conn.execute(
        "INSERT INTO todos (content, due_at) VALUES (?1, ?2)",
        params![content, due_at],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("SELECT {COLS} FROM todos WHERE id = ?1");
    Ok(conn.query_row(&sql, params![id], |r| Todo::try_from(r))?)
}

/// 완료 처리. 실제로 바뀐 행이 있으면 true.
pub fn complete(conn: &Connection, id: i64) -> AppResult<bool> {
    let n = conn.execute(
        "UPDATE todos SET status = 'done', completed_at = datetime('now') WHERE id = ?1",
        params![id],
    )?;
    Ok(n > 0)
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
    fn add_then_list_roundtrip() {
        let c = setup();
        let t = add(&c, "우유 사기 🥛", Some("2026-07-11")).unwrap();
        assert_eq!(t.content, "우유 사기 🥛");
        assert_eq!(t.status, "open");
        assert_eq!(t.due_at.as_deref(), Some("2026-07-11"));

        let open = list_open(&c).unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].id, t.id);
    }

    #[test]
    fn complete_moves_open_to_done() {
        let c = setup();
        let t = add(&c, "청소", None).unwrap();
        assert!(complete(&c, t.id).unwrap());

        assert!(list_open(&c).unwrap().is_empty());
        let done = list_done(&c).unwrap();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].status, "done");
        assert!(done[0].completed_at.is_some());
    }

    #[test]
    fn complete_unknown_id_is_false() {
        let c = setup();
        assert!(!complete(&c, 999).unwrap());
    }

    #[test]
    fn open_list_orders_by_due_date() {
        let c = setup();
        add(&c, "나중", Some("2026-12-31")).unwrap();
        add(&c, "먼저", Some("2026-07-11")).unwrap();
        let open = list_open(&c).unwrap();
        assert_eq!(open[0].content, "먼저"); // 마감 임박이 위로
    }
}
