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

/// 내용·마감을 고친다. content 가 없으면 그대로, 마감은 clear_due 면 지우고 아니면 due_at 이 있을 때만 바꾼다.
/// 열린 것·완료한 것 모두. 바뀐 행이 있으면 true. 동기화는 트리거가 찍는다(다른 기기도 고친 값을 받는다).
pub fn update(conn: &Connection, id: i64, content: Option<&str>, due_at: Option<&str>, clear_due: bool) -> AppResult<bool> {
    let content = content.map(str::trim);
    if content == Some("") {
        return Err("할 일 내용이 비었어.".into());
    }
    let n = conn.execute(
        "UPDATE todos SET content = COALESCE(?2, content),
             due_at = CASE WHEN ?4 THEN NULL ELSE COALESCE(?3, due_at) END
         WHERE id = ?1",
        params![id, content, due_at, clear_due],
    )?;
    Ok(n > 0)
}

/// 지운다(열린 것·완료한 것). 지운 개수. 트리거가 지움 표시를 올려 다른 기기에서도 지워진다.
pub fn delete(conn: &Connection, ids: &[i64]) -> AppResult<usize> {
    let mut n = 0;
    for id in ids {
        n += conn.execute("DELETE FROM todos WHERE id = ?1", params![id])?;
    }
    Ok(n)
}

/// 완료를 되돌린다(열린 할 일로). 완료한 것이 아니면 false.
pub fn reopen(conn: &Connection, id: i64) -> AppResult<bool> {
    let n = conn.execute(
        "UPDATE todos SET status = 'open', completed_at = NULL WHERE id = ?1 AND status = 'done'",
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
    fn edit_delete_and_reopen() {
        let c = setup();
        let t = add(&c, "우유", Some("2026-07-11")).unwrap();
        // 내용만 → 마감은 그대로
        assert!(update(&c, t.id, Some(" 두유 "), None, false).unwrap());
        assert_eq!(list_open(&c).unwrap()[0].content, "두유");
        assert_eq!(list_open(&c).unwrap()[0].due_at.as_deref(), Some("2026-07-11"));
        // 마감만 바꾸기, 지우기
        assert!(update(&c, t.id, None, Some("2026-08-01"), false).unwrap());
        assert_eq!(list_open(&c).unwrap()[0].due_at.as_deref(), Some("2026-08-01"));
        assert!(update(&c, t.id, None, None, true).unwrap());
        assert_eq!(list_open(&c).unwrap()[0].due_at, None);
        assert!(update(&c, t.id, Some("  "), None, false).is_err(), "빈 내용은 안 된다");
        assert!(!update(&c, 999, Some("x"), None, false).unwrap());

        // 완료 → 되돌리기 → 다시 열림(완료 시각 없음). 열린 걸 되돌리면 false
        complete(&c, t.id).unwrap();
        assert!(reopen(&c, t.id).unwrap());
        let open = list_open(&c).unwrap();
        assert_eq!((open[0].status.as_str(), open[0].completed_at.as_deref()), ("open", None));
        assert!(!reopen(&c, t.id).unwrap());

        let u = add(&c, "청소", None).unwrap();
        complete(&c, u.id).unwrap();
        assert_eq!(delete(&c, &[t.id, u.id, 999]).unwrap(), 2, "열린 것·완료한 것 모두, 없는 id 는 세지 않는다");
        assert!(list_open(&c).unwrap().is_empty() && list_done(&c).unwrap().is_empty());
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
