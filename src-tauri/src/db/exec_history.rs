//! exec_history 테이블 접근 (code.exec 실행 이력). 순수 함수.

use crate::db::models::ExecHistoryItem;
use crate::error::AppResult;
use rusqlite::{params, Connection};

const COLS: &str = "id, language, code, stdout, stderr, exit_code, executed_at";

pub fn save(
    conn: &Connection,
    language: &str,
    code: &str,
    stdout: &str,
    stderr: &str,
    exit_code: i64,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO exec_history (language, code, stdout, stderr, exit_code)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![language, code, stdout, stderr, exit_code],
    )?;
    Ok(())
}

pub fn list(conn: &Connection) -> AppResult<Vec<ExecHistoryItem>> {
    let sql = format!("SELECT {COLS} FROM exec_history ORDER BY id DESC LIMIT 20");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| ExecHistoryItem::try_from(r))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn clear(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM exec_history", [])?;
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
    fn save_list_newest_first() {
        let c = setup();
        save(&c, "python", "print(1)", "1\n", "", 0).unwrap();
        save(&c, "shell", "date", "2026\n", "", 0).unwrap();
        let items = list(&c).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].language, "shell"); // id DESC → 최신 먼저
    }

    #[test]
    fn clear_empties() {
        let c = setup();
        save(&c, "python", "x", "", "", 1).unwrap();
        clear(&c).unwrap();
        assert!(list(&c).unwrap().is_empty());
    }
}
