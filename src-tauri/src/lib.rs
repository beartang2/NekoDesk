use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

// ── Database state ────────────────────────────────────────────────────────────

pub struct DbState(pub Mutex<Connection>);

fn db_path() -> PathBuf {
    let home = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("nekodesk").join("nekodesk.sqlite")
}

fn open_db() -> rusqlite::Result<Connection> {
    let path = db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(&path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS memos (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            content    TEXT NOT NULL,
            tags       TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
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
        ",
    )
}

// ── Shared types ──────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Memo {
    pub id: i64,
    pub content: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Todo {
    pub id: i64,
    pub content: String,
    pub status: String,
    pub priority: Option<i64>,
    pub due_at: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduleEvent {
    pub id: i64,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub notes: Option<String>,
    pub all_day: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConversationMessage {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

// ── Commands module ───────────────────────────────────────────────────────────
// Tauri 2 requires commands to be in their own module when using generate_handler!
// with multiple commands to avoid macro namespace collisions.

mod commands {
    use super::*;
    use tauri::State;

    #[tauri::command]
    pub fn memo_search(db: State<DbState>, query: String) -> Result<Vec<Memo>, String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let pattern = format!("%{}%", query);
        let mut stmt = conn
            .prepare(
                "SELECT id, content, tags, created_at, updated_at FROM memos
                 WHERE content LIKE ?1 ORDER BY updated_at DESC LIMIT 10",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![pattern], |row| {
                let tags_json: String = row.get(2)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok(Memo {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    tags,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;

        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }

    #[tauri::command]
    pub fn memo_add(
        db: State<DbState>,
        content: String,
        tags: Vec<String>,
    ) -> Result<Memo, String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());
        conn.execute(
            "INSERT INTO memos (content, tags) VALUES (?1, ?2)",
            params![content, tags_json],
        )
        .map_err(|e| e.to_string())?;

        let id = conn.last_insert_rowid();
        conn.query_row(
            "SELECT id, content, tags, created_at, updated_at FROM memos WHERE id = ?1",
            params![id],
            |row| {
                let tags_json: String = row.get(2)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok(Memo {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    tags,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn todo_list(db: State<DbState>) -> Result<Vec<Todo>, String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, content, status, priority, due_at, created_at, completed_at
                 FROM todos WHERE status = 'open'
                 ORDER BY due_at ASC NULLS LAST, created_at DESC LIMIT 20",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Todo {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    status: row.get(2)?,
                    priority: row.get(3)?,
                    due_at: row.get(4)?,
                    created_at: row.get(5)?,
                    completed_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }

    #[tauri::command]
    pub fn todo_add(
        db: State<DbState>,
        content: String,
        due_at: Option<String>,
    ) -> Result<Todo, String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO todos (content, due_at) VALUES (?1, ?2)",
            params![content, due_at],
        )
        .map_err(|e| e.to_string())?;

        let id = conn.last_insert_rowid();
        conn.query_row(
            "SELECT id, content, status, priority, due_at, created_at, completed_at
             FROM todos WHERE id = ?1",
            params![id],
            |row| {
                Ok(Todo {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    status: row.get(2)?,
                    priority: row.get(3)?,
                    due_at: row.get(4)?,
                    created_at: row.get(5)?,
                    completed_at: row.get(6)?,
                })
            },
        )
        .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn todo_complete(db: State<DbState>, id: i64) -> Result<bool, String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let updated = conn
            .execute(
                "UPDATE todos SET status = 'done', completed_at = datetime('now') WHERE id = ?1",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        Ok(updated > 0)
    }

    #[tauri::command]
    pub fn schedule_list(db: State<DbState>, range: String) -> Result<Vec<ScheduleEvent>, String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;

        let where_clause = match range.as_str() {
            "today" => "AND date(start_at) = date('now')",
            "week" => "AND date(start_at) BETWEEN date('now') AND date('now', '+7 days')",
            _ => "",
        };

        let sql = format!(
            "SELECT id, title, start_at, end_at, notes, all_day, created_at
             FROM events WHERE start_at >= datetime('now') {}
             ORDER BY start_at ASC LIMIT 20",
            where_clause
        );

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map([], |row| {
                let all_day_int: i64 = row.get(5)?;
                Ok(ScheduleEvent {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    start_at: row.get(2)?,
                    end_at: row.get(3)?,
                    notes: row.get(4)?,
                    all_day: all_day_int != 0,
                    created_at: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;

        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }

    #[tauri::command]
    pub fn schedule_add(
        db: State<DbState>,
        title: String,
        start_at: String,
        end_at: Option<String>,
    ) -> Result<ScheduleEvent, String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO events (title, start_at, end_at) VALUES (?1, ?2, ?3)",
            params![title, start_at, end_at],
        )
        .map_err(|e| e.to_string())?;

        let id = conn.last_insert_rowid();
        conn.query_row(
            "SELECT id, title, start_at, end_at, notes, all_day, created_at
             FROM events WHERE id = ?1",
            params![id],
            |row| {
                let all_day_int: i64 = row.get(5)?;
                Ok(ScheduleEvent {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    start_at: row.get(2)?,
                    end_at: row.get(3)?,
                    notes: row.get(4)?,
                    all_day: all_day_int != 0,
                    created_at: row.get(6)?,
                })
            },
        )
        .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn github_overview(db: State<DbState>, token_override: Option<String>) -> Result<serde_json::Value, String> {
        let token = token_override
            .filter(|t| !t.is_empty())
            .or_else(|| {
                let conn = db.0.lock().ok()?;
                conn.query_row(
                    "SELECT value FROM settings WHERE key = 'github_token'",
                    [],
                    |row| row.get::<_, String>(0),
                ).ok()
            })
            .unwrap_or_default();

        if token.is_empty() {
            return Ok(serde_json::json!({
                "error": "GitHub 토큰이 설정되지 않았어. 설정에서 GitHub Token을 입력해줘."
            }));
        }

        let client = reqwest::blocking::Client::builder()
            .user_agent("NekoDesk/0.1")
            .build()
            .map_err(|e: reqwest::Error| e.to_string())?;

        let user: serde_json::Value = client
            .get("https://api.github.com/user")
            .bearer_auth(&token)
            .header("Accept", "application/vnd.github.v3+json")
            .send()
            .map_err(|e| e.to_string())?
            .json()
            .map_err(|e: reqwest::Error| e.to_string())?;

        let issues: serde_json::Value = client
            .get("https://api.github.com/issues?filter=assigned&state=open&per_page=5")
            .bearer_auth(&token)
            .header("Accept", "application/vnd.github.v3+json")
            .send()
            .map_err(|e| e.to_string())?
            .json()
            .map_err(|e: reqwest::Error| e.to_string())?;

        Ok(serde_json::json!({
            "user": user.get("login"),
            "assigned_issues": issues,
        }))
    }

    #[tauri::command]
    pub fn web_search(query: String) -> Result<Vec<SearchResult>, String> {
        let encoded = urlencoding(&query);
        let url = format!("https://html.duckduckgo.com/html/?q={}", encoded);

        let client = reqwest::blocking::Client::builder()
            .user_agent(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            )
            .build()
            .map_err(|e: reqwest::Error| e.to_string())?;

        let html = client
            .get(&url)
            .send()
            .map_err(|e| e.to_string())?
            .text()
            .map_err(|e| e.to_string())?;

        let document = scraper::Html::parse_document(&html);
        let result_sel = scraper::Selector::parse(".result").unwrap();
        let title_sel = scraper::Selector::parse(".result__title a").unwrap();
        let snippet_sel = scraper::Selector::parse(".result__snippet").unwrap();

        let mut results = Vec::new();
        for result in document.select(&result_sel).take(5) {
            let title = result
                .select(&title_sel)
                .next()
                .map(|n| n.text().collect::<String>().trim().to_string())
                .unwrap_or_default();

            let href = result
                .select(&title_sel)
                .next()
                .and_then(|n| n.value().attr("href"))
                .map(|s| s.to_string())
                .unwrap_or_default();

            let snippet = result
                .select(&snippet_sel)
                .next()
                .map(|n| n.text().collect::<String>().trim().to_string())
                .unwrap_or_default();

            if !title.is_empty() {
                results.push(SearchResult {
                    title,
                    url: href,
                    snippet,
                });
            }
        }

        Ok(results)
    }

    #[tauri::command]
    pub fn settings_set(db: State<DbState>, key: String, value: String) -> Result<(), String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tauri::command]
    pub fn settings_get(db: State<DbState>, key: String) -> Result<Option<String>, String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        );
        match result {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    #[tauri::command]
    pub fn conversation_save(
        db: State<DbState>,
        session_id: String,
        role: String,
        content: String,
    ) -> Result<(), String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO conversation_messages (session_id, role, content) VALUES (?1, ?2, ?3)",
            params![session_id, role, content],
        )
        .map_err(|e| e.to_string())?;

        // Trim to 40 most recent messages per session
        conn.execute(
            "DELETE FROM conversation_messages WHERE session_id = ?1 AND id NOT IN (
                 SELECT id FROM conversation_messages WHERE session_id = ?1
                 ORDER BY id DESC LIMIT 40
             )",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tauri::command]
    pub fn conversation_load(
        db: State<DbState>,
        session_id: String,
    ) -> Result<Vec<ConversationMessage>, String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, role, content, created_at
                 FROM conversation_messages WHERE session_id = ?1
                 ORDER BY id ASC",
            )
            .map_err(|e| e.to_string())?;

        let rows = stmt
            .query_map(params![session_id], |row| {
                Ok(ConversationMessage {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;

        rows.map(|r| r.map_err(|e| e.to_string())).collect()
    }
}

fn urlencoding(s: &str) -> String {
    s.bytes()
        .flat_map(|b| {
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' || b == b'~' {
                vec![b as char]
            } else if b == b' ' {
                vec!['+']
            } else {
                format!("%{:02X}", b).chars().collect::<Vec<_>>()
            }
        })
        .collect()
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let conn = open_db().expect("Failed to open database");
    init_schema(&conn).expect("Failed to initialize schema");

    tauri::Builder::default()
        .manage(DbState(Mutex::new(conn)))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::memo_search,
            commands::memo_add,
            commands::todo_list,
            commands::todo_add,
            commands::todo_complete,
            commands::schedule_list,
            commands::schedule_add,
            commands::github_overview,
            commands::web_search,
            commands::settings_set,
            commands::settings_get,
            commands::conversation_save,
            commands::conversation_load,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
