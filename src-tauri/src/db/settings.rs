//! settings 테이블 접근 (key-value). 순수 함수.

use crate::error::AppResult;
use rusqlite::{params, Connection};

/// upsert: 있으면 갱신, 없으면 삽입.
pub fn set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        params![key, value],
    )?;
    Ok(())
}

/// 없으면 None (에러 아님).
pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    match conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    ) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
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
    fn get_missing_is_none() {
        let c = setup();
        assert_eq!(get(&c, "없는키").unwrap(), None);
    }

    #[test]
    fn set_then_get_roundtrip() {
        let c = setup();
        set(&c, "theme", "dark").unwrap();
        assert_eq!(get(&c, "theme").unwrap().as_deref(), Some("dark"));
    }

    #[test]
    fn set_upserts() {
        let c = setup();
        set(&c, "k", "v1").unwrap();
        set(&c, "k", "v2").unwrap();
        assert_eq!(get(&c, "k").unwrap().as_deref(), Some("v2"));
    }
}
