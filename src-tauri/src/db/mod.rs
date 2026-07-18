//! 데이터베이스 계층.
//!
//! 커맨드는 여기의 순수 함수(`db::todos::list_open(&conn)` 등)에 위임한다.
//! SQL·행 매핑은 전부 이 모듈 안에 있고, 커맨드는 잠금만 잡아 넘긴다.

use rusqlite::Connection;

pub mod models;
pub mod todos;
pub mod events;
pub mod settings;
pub mod conversations;
pub mod exec_history;

/// 스키마 초기화. 앱 시작 시 1회 호출.
///
/// (지금은 CREATE TABLE IF NOT EXISTS. 스키마가 진화하면 버전 추적
///  마이그레이션으로 발전시킬 자리다.)
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS todos (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            content      TEXT NOT NULL,
            status       TEXT NOT NULL DEFAULT 'open',
            priority     INTEGER,
            due_at       TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT
        );
        CREATE TABLE IF NOT EXISTS events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            start_at   TEXT NOT NULL,
            end_at     TEXT,
            notes      TEXT,
            all_day    INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS conversation_messages (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role       TEXT NOT NULL,
            content    TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS exec_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            language    TEXT NOT NULL,
            code        TEXT NOT NULL,
            stdout      TEXT NOT NULL DEFAULT '',
            stderr      TEXT NOT NULL DEFAULT '',
            exit_code   INTEGER NOT NULL,
            executed_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        ",
    )
}
