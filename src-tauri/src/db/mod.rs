//! 데이터베이스 계층.
//!
//! 커맨드는 여기의 순수 함수(`db::todos::list_open(&conn)` 등)에 위임한다.
//! SQL·행 매핑은 전부 이 모듈 안에 있고, 커맨드는 잠금만 잡아 넘긴다.

use rusqlite::Connection;

pub mod cipher;
pub mod models;
pub mod todos;
pub mod events;
pub mod settings;
pub mod conversations;
pub mod exec_history;
pub mod memories;
pub mod terms;

/// 동기화로 맞추는 설정 키(§2.2). 선물(neko_gifts)은 선물 하나씩 따로 맞춘다.
/// 바꾸면 이미 배포된 마이그레이션 4번은 그대로 두고, 트리거를 새 마이그레이션에서 다시 만든다.
/// 비밀(키체인·API 키), 경로·권한·실행 관련 키(fs_write_roots 등), 모델 프로필, 예산·장부는 절대 넣지 않는다 —
/// 연결된 다른 기기가 이 맥의 권한을 넓힐 수 있게 된다. 받을 때도 이 목록 밖은 버린다(crate::sync::apply).
pub const SYNCED_SETTINGS: &[&str] = &["neko_appearance", "neko_name", "neko_persona", "user_profile", "session_retention"];
/// 트리거용 같은 목록(SQL 글). concat! 은 상수를 못 받아 따로 적고, 테스트가 둘이 같은지 본다.
macro_rules! synced_keys { () => { "('neko_appearance', 'neko_name', 'neko_persona', 'user_profile', 'session_retention')" } }

/// 지금 시각(ms). SQLite 의 julianday 는 ms 까지 준다
macro_rules! now_ms { () => { "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)" } }

/// 정수 id 표: 넣으면 새 기록 번호로, 바꾸면(when) 같은 번호로 dirty 를 찍는다
macro_rules! sync_rowid_triggers {
    ($coll:literal, $table:literal, $update:literal, $when:literal) => { concat!(
        "CREATE TRIGGER sync_", $coll, "_ins AFTER INSERT ON ", $table, " BEGIN
             INSERT INTO sync_meta (coll, uid, local_key, ts) VALUES ('", $coll, "', lower(hex(randomblob(16))), CAST(NEW.id AS TEXT), ", now_ms!(), ")
             ON CONFLICT (coll, local_key) DO UPDATE SET ts = MAX(excluded.ts, ts + 1), dirty = 1, deleted = 0; END;
         CREATE TRIGGER sync_", $coll, "_upd ", $update, " ON ", $table, " WHEN ", $when, " BEGIN
             UPDATE sync_meta SET ts = MAX(", now_ms!(), ", ts + 1), dirty = 1 WHERE coll = '", $coll, "' AND local_key = CAST(NEW.id AS TEXT); END;
        ") };
}

/// 이름이 곧 기록 번호인 표(세션 id, 설정 키)
macro_rules! sync_named_triggers {
    ($coll:literal, $table:literal, $key:literal, $when_new:expr, $changed:literal) => { concat!(
        "CREATE TRIGGER sync_", $coll, "_ins AFTER INSERT ON ", $table, " WHEN ", $when_new, " BEGIN
             INSERT INTO sync_meta (coll, uid, local_key, ts) VALUES ('", $coll, "', NEW.", $key, ", NEW.", $key, ", ", now_ms!(), ")
             ON CONFLICT (coll, uid) DO UPDATE SET local_key = excluded.local_key, ts = MAX(excluded.ts, ts + 1), dirty = 1,
                 cut = CASE WHEN deleted = 1 THEN NULL ELSE cut END, deleted = 0; END;
         CREATE TRIGGER sync_", $coll, "_upd AFTER UPDATE ON ", $table, " WHEN ", $when_new, " AND (", $changed, ") BEGIN
             UPDATE sync_meta SET ts = MAX(", now_ms!(), ", ts + 1), dirty = 1 WHERE coll = '", $coll, "' AND uid = NEW.", $key, "; END;
        ") };
}

/// 지우면 지움 표시(사용자가 지운 것: cut 없음. 자동 삭제는 지운 쪽이 cut 을 따로 적는다)
macro_rules! sync_tombstone {
    ($coll:literal, $table:literal, $old:literal, $when:expr) => { concat!(
        "CREATE TRIGGER sync_", $coll, "_del AFTER DELETE ON ", $table, " WHEN ", $when, " BEGIN
             UPDATE sync_meta SET local_key = NULL, deleted = 1, dirty = 1, cut = NULL, ts = MAX(", now_ms!(), ", ts + 1)
             WHERE coll = '", $coll, "' AND local_key = CAST(", $old, " AS TEXT); END;
        ") };
}

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
pub(crate) const MIGRATIONS: &[&str] = &[
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
    // 2 — 대화에 첨부 파일을 함께 보관한다.
    //
    // 예전엔 글만 저장해서, 앱을 껐다 켜면 붙였던 이미지가 본문에 남은 파일명
    // 한 줄로만 남았다. 미리보기는 메모리에만 있었기 때문이다.
    // JSON 배열({ name, type, size, dataUrl })을 그대로 담는다.
    "ALTER TABLE conversation_messages ADD COLUMN attachments TEXT;",
    // 3 — 답변에 딸린 도구 기록·계획·생각·이미지를 함께 보관한다.
    //
    // 예전엔 본문만 저장해서, 다시 열면 "도구 N개 사용" 패널이 통째로 사라졌다.
    // 프런트가 정한 JSON 한 덩이를 그대로 담는다 — 모양이 바뀌어도 스키마는 그대로다.
    "ALTER TABLE conversation_messages ADD COLUMN meta TEXT;",
    // 4 — 기기 간 동기화(docs/neko-sync.md §2.6, crate::sync).
    //
    // sync_meta: 로컬 행 ↔ 기록 번호(uid). 지움 표시(local_key 없음, deleted)와 "아직 안 올림"(dirty)도 여기.
    // 쓰는 곳마다 dirty 를 찍는 대신 트리거가 찍는다 — 새로 생긴 쓰기 경로도 빠지지 않는다. 받은 기록을
    // 적용할 때도 트리거가 돌지만, 적용 쪽이 바로 뒤에 그 행을 받은 값(dirty 0)으로 덮는다.
    // 메시지는 덧붙기만 해서 지울 때 지움 표시 없이 meta 만 지운다(세션의 cut·지움으로 맞춘다).
    // 기억은 use_count·last_used_at 만 바뀌면, 설정은 값이 같으면 안 찍는다. 선물은 settings 의 JSON
    // 배열 하나라 트리거 대신 동기화할 때 하나씩 견준다(sig).
    // sessions: localStorage 에 있던 세션 목록·수동 요약을 옮겨 둔다(화면이 처음 한 번 넣는다).
    concat!(
        "
        CREATE TABLE sync_meta (
            coll      TEXT NOT NULL,
            uid       TEXT NOT NULL,
            local_key TEXT,
            ts        INTEGER NOT NULL,
            device    TEXT NOT NULL DEFAULT '',
            deleted   INTEGER NOT NULL DEFAULT 0,
            dirty     INTEGER NOT NULL DEFAULT 1,
            cut       INTEGER,
            sig       TEXT,
            PRIMARY KEY (coll, uid)
        );
        CREATE UNIQUE INDEX sync_meta_local ON sync_meta (coll, local_key);
        CREATE INDEX sync_meta_dirty ON sync_meta (dirty, coll);
        CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE sessions (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            summary    TEXT
        );
        ",
        sync_rowid_triggers!("msg", "conversation_messages", "AFTER UPDATE", "(SELECT 1)"),
        "CREATE TRIGGER sync_msg_del AFTER DELETE ON conversation_messages BEGIN
             DELETE FROM sync_meta WHERE coll = 'msg' AND local_key = CAST(OLD.id AS TEXT); END;",
        sync_rowid_triggers!("memory", "memories", "AFTER UPDATE OF kind, content", "(OLD.kind IS NOT NEW.kind OR OLD.content IS NOT NEW.content)"),
        sync_rowid_triggers!("todo", "todos", "AFTER UPDATE", "(SELECT 1)"),
        sync_rowid_triggers!("event", "events", "AFTER UPDATE", "(SELECT 1)"),
        sync_tombstone!("memory", "memories", "OLD.id", "1"),
        sync_tombstone!("todo", "todos", "OLD.id", "1"),
        sync_tombstone!("event", "events", "OLD.id", "1"),
        sync_named_triggers!("session", "sessions", "id", "1", "OLD.title IS NOT NEW.title OR OLD.summary IS NOT NEW.summary"),
        sync_named_triggers!("setting", "settings", "key", concat!("NEW.key IN ", synced_keys!()), "OLD.value IS NOT NEW.value"),
        sync_tombstone!("session", "sessions", "OLD.id", "1"),
        sync_tombstone!("setting", "settings", "OLD.key", concat!("OLD.key IN ", synced_keys!())),
        // 지금 있는 것은 전부 올릴 거리로 찍는다(§10.1, 12번). 시각은 만든 때(없으면 지금)
        "
        INSERT INTO sync_meta (coll, uid, local_key, ts)
            SELECT 'msg', lower(hex(randomblob(16))), CAST(id AS TEXT),
                   COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, ", now_ms!(), ") FROM conversation_messages;
        INSERT INTO sync_meta (coll, uid, local_key, ts)
            SELECT 'memory', lower(hex(randomblob(16))), CAST(id AS TEXT),
                   COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, ", now_ms!(), ") FROM memories;
        INSERT INTO sync_meta (coll, uid, local_key, ts)
            SELECT 'todo', lower(hex(randomblob(16))), CAST(id AS TEXT),
                   COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, ", now_ms!(), ") FROM todos;
        INSERT INTO sync_meta (coll, uid, local_key, ts)
            SELECT 'event', lower(hex(randomblob(16))), CAST(id AS TEXT),
                   COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, ", now_ms!(), ") FROM events;
        INSERT INTO sync_meta (coll, uid, local_key, ts)
            SELECT 'setting', key, key, ", now_ms!(), " FROM settings WHERE ", "key IN ", synced_keys!(), ";
        "
    ),
];

/// 스키마를 최신으로 올린다. 앱 시작 시 1회 호출.
pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    run_migrations(conn, MIGRATIONS)
}

/// 실제 실행기. 목록을 인자로 받아 실패 경로까지 테스트할 수 있게 분리했다.
pub(crate) fn run_migrations(conn: &Connection, migrations: &[&str]) -> rusqlite::Result<()> {
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
    fn synced_settings_list_matches_the_trigger_sql() {
        let sql = format!("({})", SYNCED_SETTINGS.iter().map(|k| format!("'{k}'")).collect::<Vec<_>>().join(", "));
        assert_eq!(sql, synced_keys!());
        for bad in ["fs_write_roots", "anthropic_api_key", "db_key", "sync_key", "neko_stage", "neko_gifts"] {
            assert!(!SYNCED_SETTINGS.contains(&bad), "{bad}");
        }
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

