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
pub mod memories;
pub mod terms;

/// 순서대로 적용되는 마이그레이션.
///
/// SQLite 의 `PRAGMA user_version` 에 몇 번까지 적용했는지 적어두고, 그 뒤 것만 실행한다.
///
/// 예전에는 `CREATE TABLE IF NOT EXISTS` 한 덩이가 전부였다. 새 **테이블**을 더하는
/// 데는 문제가 없지만, 기존 테이블에 **컬럼**을 더하는 순간 이미 설치된 사람에게는
/// 아무 일도 일어나지 않는다 — 테이블이 이미 있으니 문장이 통째로 건너뛰어지고,
/// 앱은 없는 컬럼을 읽다가 죽는다. 새 설치에서만 되고 업데이트에서 깨지는,
/// 개발 중에는 가장 눈에 안 띄는 종류의 고장이다.
///
/// 규칙: **이미 배포된 항목은 절대 고치지 않는다.** 바꿀 게 있으면 뒤에 추가한다.
const MIGRATIONS: &[&str] = &[
    // 1 — 최초 스키마.
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
        CREATE TABLE IF NOT EXISTS memories (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            kind         TEXT NOT NULL DEFAULT 'fact',
            content      TEXT NOT NULL UNIQUE,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            last_used_at TEXT,
            use_count    INTEGER NOT NULL DEFAULT 0
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
];

/// 스키마를 최신으로 올린다. 앱 시작 시 1회 호출.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    run_migrations(conn, MIGRATIONS)
}

/// 실제 실행기. 목록을 인자로 받아 실패 경로까지 테스트할 수 있게 분리했다.
fn run_migrations(conn: &Connection, migrations: &[&str]) -> rusqlite::Result<()> {
    let applied: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;

    for (i, sql) in migrations.iter().enumerate() {
        let version = i as i64 + 1;
        if version <= applied {
            continue;
        }
        // 마이그레이션 하나를 통째로 적용하거나 통째로 되돌린다. 중간에 실패한 채
        // 버전만 올라가면 다음 실행부터는 영영 손대지 않는 반쪽 스키마가 남는다.
        conn.execute_batch("BEGIN")?;
        match conn
            .execute_batch(sql)
            .and_then(|_| conn.execute_batch(&format!("PRAGMA user_version = {version}")))
        {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(e) => {
                conn.execute_batch("ROLLBACK").ok();
                return Err(e);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        init_schema(&c).unwrap();
        c
    }

    fn version(c: &Connection) -> i64 {
        c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn fresh_database_lands_on_the_latest_version() {
        let c = fresh();
        assert_eq!(version(&c), MIGRATIONS.len() as i64);
    }

    #[test]
    fn running_again_is_a_no_op() {
        let c = fresh();
        c.execute("INSERT INTO todos (content) VALUES ('남아 있어야 함')", [])
            .unwrap();

        init_schema(&c).unwrap();
        init_schema(&c).unwrap();

        let n: i64 = c
            .query_row("SELECT count(*) FROM todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "재실행이 데이터를 건드렸다");
        assert_eq!(version(&c), MIGRATIONS.len() as i64);
    }

    #[test]
    fn an_old_database_gets_only_the_missing_steps() {
        // 1번까지만 적용된 기존 설치를 흉내낸다.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(MIGRATIONS[0]).unwrap();
        c.execute_batch("PRAGMA user_version = 1").unwrap();
        c.execute("INSERT INTO todos (content) VALUES ('기존 데이터')", [])
            .unwrap();

        init_schema(&c).unwrap();

        assert_eq!(version(&c), MIGRATIONS.len() as i64);
        let kept: String = c
            .query_row("SELECT content FROM todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, "기존 데이터", "업그레이드가 기존 데이터를 지웠다");
    }

    #[test]
    fn an_existing_install_with_no_version_stamp_survives() {
        // 이 코드가 나오기 전에 설치된 DB 는 테이블이 다 있는데 user_version 이 0 이다.
        // 실제 업그레이드 경로가 이것이라, 1번이 IF NOT EXISTS 여야 하는 이유다.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(MIGRATIONS[0]).unwrap();
        // 버전 도장을 찍지 않는다 (= 예전 앱 상태)
        c.execute("INSERT INTO todos (content) VALUES ('예전 데이터')", [])
            .unwrap();
        assert_eq!(version(&c), 0);

        init_schema(&c).unwrap();

        assert_eq!(version(&c), MIGRATIONS.len() as i64);
        let kept: String = c
            .query_row("SELECT content FROM todos", [], |r| r.get(0))
            .unwrap();
        assert_eq!(kept, "예전 데이터");
    }

    #[test]
    fn a_failing_migration_rolls_back_and_leaves_the_version_behind() {
        // 실패했는데 버전이 올라가면, 다음 실행부터는 건너뛰어 반쪽 스키마가 영원히 남는다.
        let c = Connection::open_in_memory().unwrap();
        let migrations = &[
            "CREATE TABLE first (x INTEGER);",
            "CREATE TABLE second (y INTEGER); THIS IS NOT SQL;",
        ];

        assert!(run_migrations(&c, migrations).is_err());

        assert_eq!(version(&c), 1, "실패한 단계인데 버전이 올라갔다");
        let leftover: i64 = c
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'second'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0, "실패한 마이그레이션의 일부가 남았다");

        // 고친 뒤 다시 돌리면 2번부터 이어서 적용된다.
        let fixed = &[migrations[0], "CREATE TABLE second (y INTEGER);"];
        run_migrations(&c, fixed).unwrap();
        assert_eq!(version(&c), 2);
    }
}

