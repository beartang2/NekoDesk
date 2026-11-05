//! 대화 DB 를 SQLCipher 로 암호화해 연다. 열쇠는 키체인에 있다(secrets::db_key).
//!
//! FileVault 는 맥이 꺼져 있을 때만 지킨다. 켜져 있을 때 같은 사용자의 다른 프로그램이나
//! 백업·복사본이 파일을 그대로 읽던 것을 막는다. 열쇠 없이는 파일이 무작위 바이트다.

use rusqlite::Connection;
use std::path::Path;

/// 평문 SQLite 파일 머리. 암호화된 파일은 첫 16바이트부터 무작위다.
const PLAIN_HEADER: &[u8; 16] = b"SQLite format 3\0";

/// 열쇠(32바이트 hex)로 연다. 예전 평문 DB 면 먼저 암호화한 사본으로 바꿔 끼운다.
pub fn open(path: &Path, key: &str) -> rusqlite::Result<Connection> {
    check_key(key)?;
    if is_plain(path) {
        encrypt_in_place(path, key)?;
    }
    let conn = Connection::open(path)?;
    apply_key(&conn, key)?;
    // 열쇠가 틀리면 여기서 처음 실패한다("file is not a database"). 파일은 건드리지 않는다.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))?;
    Ok(conn)
}

/// PRAGMA 에 끼워 넣는 값이라 hex 64자만 받는다.
fn check_key(key: &str) -> rusqlite::Result<()> {
    if key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(rusqlite::Error::InvalidParameterName("DB 열쇠 모양이 이상해".into()))
    }
}

/// raw 열쇠(x'..')라 비밀번호 유도(KDF)를 건너뛴다 — 이미 무작위 32바이트다.
fn apply_key(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))
}

fn is_plain(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 16];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut head)).is_ok() && &head == PLAIN_HEADER
}

/// 평문 DB 를 옆에 암호화해 내보내고, 다 읽히는지 확인한 뒤에만 바꿔 끼운다.
/// 중간에 죽어도 원본은 그대로다(바꿔 끼우기는 rename 한 번).
fn encrypt_in_place(path: &Path, key: &str) -> rusqlite::Result<()> {
    let tmp = path.with_extension("sqlite.enc");
    let _ = std::fs::remove_file(&tmp);
    {
        let plain = Connection::open(path)?;
        // WAL 에만 있는 최근 기록까지 본 파일로 모은다.
        plain.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
        let version: i64 = plain.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        plain.execute(&format!("ATTACH DATABASE ?1 AS enc KEY \"x'{key}'\""), [tmp.to_string_lossy()])?;
        plain.query_row("SELECT sqlcipher_export('enc')", [], |_| Ok(()))?;
        // 스키마 단계(db::init_schema)가 이 값으로 어디까지 했는지 안다.
        plain.execute_batch(&format!("PRAGMA enc.user_version = {version}; DETACH DATABASE enc;"))?;
    }
    {
        let enc = Connection::open(&tmp)?;
        apply_key(&enc, key)?;
        let ok: String = enc.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if ok != "ok" {
            let _ = std::fs::remove_file(&tmp);
            return Err(rusqlite::Error::InvalidQuery);
        }
    }
    // 옛 WAL·SHM 이 남으면 새 파일을 옛 기록으로 읽으려 든다.
    for ext in ["sqlite-wal", "sqlite-shm"] {
        let _ = std::fs::remove_file(path.with_extension(ext));
    }
    std::fs::rename(&tmp, path).map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    #[test]
    fn plain_db_is_encrypted_in_place_and_keeps_data() {
        let dir = std::env::temp_dir().join(format!("nekodesk-cipher-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("nekodesk.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('비밀 대화'); PRAGMA user_version = 7;").unwrap();
        }
        assert!(is_plain(&path));

        let c = open(&path, KEY).unwrap();
        let v: String = c.query_row("SELECT v FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, "비밀 대화");
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 7);
        drop(c);

        // 파일엔 평문이 없다.
        let bytes = std::fs::read(&path).unwrap();
        assert!(!is_plain(&path));
        assert!(!bytes.windows("비밀 대화".len()).any(|w| w == "비밀 대화".as_bytes()));
        // 다시 열어도 된다(이미 암호화된 파일).
        assert!(open(&path, KEY).is_ok());
        // 틀린 열쇠는 실패하고 파일을 건드리지 않는다.
        assert!(open(&path, &KEY.replace('0', "1")).is_err());
        assert!(open(&path, KEY).is_ok());
        // PRAGMA 에 끼워 넣을 수 없는 열쇠는 받지 않는다.
        assert!(open(&path, "x'; DROP TABLE t; --").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// 실제 DB 의 **복사본**으로 바꿔 끼우기를 돌려 본다. 배포 전 손으로:
    /// NEKO_DB_COPY=<복사본 경로> cargo test --lib cipher::tests::real_copy -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_copy() {
        let path = std::path::PathBuf::from(std::env::var("NEKO_DB_COPY").expect("NEKO_DB_COPY"));
        let c = open(&path, KEY).unwrap();
        println!("user_version {}", c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap());
        let mut q = c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").unwrap();
        let tables: Vec<String> = q.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        for t in tables {
            let n: i64 = c.query_row(&format!("SELECT count(*) FROM \"{t}\""), [], |r| r.get(0)).unwrap();
            println!("{t} {n}");
        }
        assert!(!is_plain(&path));
    }

    #[test]
    fn new_db_starts_encrypted() {
        let dir = std::env::temp_dir().join(format!("nekodesk-cipher-new-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("nekodesk.sqlite");
        let _ = std::fs::remove_file(&path);
        let c = open(&path, KEY).unwrap();
        c.execute_batch("CREATE TABLE t(v TEXT);").unwrap();
        drop(c);
        assert!(!is_plain(&path));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
