use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::io::Read;

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
pub struct ScrapResult {
    pub url: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CodeExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
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
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use std::thread;
    use std::sync::mpsc;
    use tauri::State;

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
    pub fn code_exec(code: String, language: Option<String>, work_dir: Option<String>) -> Result<CodeExecResult, String> {
        let lang = language.as_deref().unwrap_or("python");

        let (interpreter, flag) = match lang {
            "python" | "python3" => ("python3", "-c"),
            "shell" | "sh" | "bash" => ("sh", "-c"),
            "applescript" | "osascript" => ("osascript", "-e"),
            other => return Err(format!("지원하지 않는 언어: {}. python, shell 또는 applescript를 사용해줘.", other)),
        };

        let dir = work_dir
            .filter(|d| !d.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));

        let mut child = Command::new(interpreter)
            .arg(flag)
            .arg(&code)
            .current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("실행 실패: {}. {} 가 설치되어 있는지 확인해줘.", e, interpreter))?;

        // Collect stdout/stderr in background threads
        let stdout_pipe = child.stdout.take().unwrap();
        let stderr_pipe = child.stderr.take().unwrap();

        let (tx_out, rx_out) = mpsc::channel::<String>();
        let (tx_err, rx_err) = mpsc::channel::<String>();

        thread::spawn(move || {
            let mut buf = String::new();
            let mut reader = std::io::BufReader::new(stdout_pipe);
            reader.read_to_string(&mut buf).ok();
            tx_out.send(buf).ok();
        });

        thread::spawn(move || {
            let mut buf = String::new();
            let mut reader = std::io::BufReader::new(stderr_pipe);
            reader.read_to_string(&mut buf).ok();
            tx_err.send(buf).ok();
        });

        // Poll for completion with 30s timeout
        let timeout = Duration::from_secs(30);
        let start = Instant::now();
        let exit_code = loop {
            match child.try_wait().map_err(|e| e.to_string())? {
                Some(status) => break status.code().unwrap_or(-1),
                None => {
                    if start.elapsed() > timeout {
                        child.kill().ok();
                        return Err("실행 시간 초과 (30초)".to_string());
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }
        };

        let stdout_raw = rx_out.recv_timeout(Duration::from_secs(5)).unwrap_or_default();
        let stderr_raw = rx_err.recv_timeout(Duration::from_secs(5)).unwrap_or_default();

        const MAX_OUTPUT: usize = 4000;
        let truncated = stdout_raw.len() > MAX_OUTPUT || stderr_raw.len() > MAX_OUTPUT;
        let stdout = if stdout_raw.len() > MAX_OUTPUT {
            format!("{}…(잘림)", &stdout_raw[..MAX_OUTPUT])
        } else {
            stdout_raw
        };
        let stderr = if stderr_raw.len() > MAX_OUTPUT {
            format!("{}…(잘림)", &stderr_raw[..MAX_OUTPUT])
        } else {
            stderr_raw
        };

        Ok(CodeExecResult { stdout, stderr, exit_code, truncated })
    }

    #[tauri::command]
    pub fn web_search(query: String) -> Result<Vec<SearchResult>, String> {
        let encoded = urlencoding(&query);
        let url = format!("https://lite.duckduckgo.com/lite/?q={}", encoded);

        let client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e: reqwest::Error| e.to_string())?;

        let html = client
            .get(&url)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .header("Accept-Language", "en-US,en;q=0.9,ko;q=0.8")
            .header("Referer", "https://lite.duckduckgo.com/")
            .send()
            .map_err(|e| e.to_string())?
            .text()
            .map_err(|e| e.to_string())?;

        let document = scraper::Html::parse_document(&html);

        // DuckDuckGo Lite structure: tr.result-title > td > a.result-link
        let row_sel    = scraper::Selector::parse("tr.result-title").unwrap();
        let link_sel   = scraper::Selector::parse("a.result-link").unwrap();
        let snippet_sel = scraper::Selector::parse("td.result-snippet").unwrap();

        let rows: Vec<_> = document.select(&row_sel).collect();
        let snippets: Vec<_> = document.select(&snippet_sel).collect();

        let mut results = Vec::new();
        for (i, row) in rows.iter().enumerate().take(5) {
            let link = row.select(&link_sel).next();
            let title = link
                .map(|n| n.text().collect::<String>().trim().to_string())
                .unwrap_or_default();
            let href = link
                .and_then(|n| n.value().attr("href"))
                .map(|s| s.to_string())
                .unwrap_or_default();
            let snippet = snippets.get(i)
                .map(|n| n.text().collect::<String>().trim().to_string())
                .unwrap_or_default();

            if !title.is_empty() {
                results.push(SearchResult { title, url: href, snippet });
            }
        }

        Ok(results)
    }

    #[tauri::command]
    pub fn web_scrape(url: String) -> Result<ScrapResult, String> {
        let client = reqwest::blocking::Client::builder()
            .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .map_err(|e| e.to_string())?;

        let html = client
            .get(&url)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
            .header("Accept-Language", "en-US,en;q=0.9,ko;q=0.8")
            .send()
            .map_err(|e| format!("요청 실패: {}", e))?
            .text()
            .map_err(|e| format!("응답 읽기 실패: {}", e))?;

        let document = scraper::Html::parse_document(&html);

        let title_sel = scraper::Selector::parse("title").unwrap();
        let title = document.select(&title_sel)
            .next()
            .map(|n| n.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        // Extract readable text from content tags, skip nav/footer/script/style
        let content_sel = scraper::Selector::parse(
            "article, main, p, h1, h2, h3, h4, li, td, th, blockquote"
        ).unwrap();

        let content: String = document.select(&content_sel)
            .map(|n| n.text().collect::<String>().trim().to_string())
            .filter(|s| s.len() > 15)
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .take(6000)
            .collect();

        Ok(ScrapResult { url, title, content })
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

    #[tauri::command]
    pub fn conversation_delete(
        db: State<DbState>,
        session_id: String,
    ) -> Result<(), String> {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM conversation_messages WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tauri::command]
    pub fn weather_get(_db: State<DbState>, location: String) -> Result<String, String> {
        // Step 1: Geocoding
        let geo_url = format!(
            "https://geocoding-api.open-meteo.com/v1/search?name={}&count=1&language=ko&format=json",
            urlencoding(&location)
        );
        let geo_resp: serde_json::Value = reqwest::blocking::get(&geo_url)
            .map_err(|e| e.to_string())?
            .json()
            .map_err(|e| e.to_string())?;

        let results = geo_resp["results"].as_array()
            .ok_or_else(|| format!("'{}' 위치를 찾을 수 없습니다.", location))?;
        if results.is_empty() {
            return Err(format!("'{}' 위치를 찾을 수 없습니다.", location));
        }
        let lat = results[0]["latitude"].as_f64().unwrap_or(0.0);
        let lon = results[0]["longitude"].as_f64().unwrap_or(0.0);
        let place_name = results[0]["name"].as_str().unwrap_or(&location).to_string();

        // Step 2: Weather fetch
        let weather_url = format!(
            "https://api.open-meteo.com/v1/forecast?latitude={}&longitude={}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,apparent_temperature&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FSeoul&forecast_days=3",
            lat, lon
        );
        let weather: serde_json::Value = reqwest::blocking::get(&weather_url)
            .map_err(|e| e.to_string())?
            .json()
            .map_err(|e| e.to_string())?;

        let cur = &weather["current"];
        let temp = cur["temperature_2m"].as_f64().unwrap_or(0.0);
        let feels = cur["apparent_temperature"].as_f64().unwrap_or(temp);
        let humidity = cur["relative_humidity_2m"].as_i64().unwrap_or(0);
        let wind = cur["wind_speed_10m"].as_f64().unwrap_or(0.0);
        let code = cur["weather_code"].as_i64().unwrap_or(0);

        let condition = super::weather_code_to_str(code);

        let daily = &weather["daily"];
        let max_temps = daily["temperature_2m_max"].as_array();
        let min_temps = daily["temperature_2m_min"].as_array();
        let precip = daily["precipitation_probability_max"].as_array();

        let mut result = format!(
            "{} 현재 날씨\n{} | {:.1}°C (체감 {:.1}°C)\n습도 {}% | 바람 {:.1}km/h",
            place_name, condition, temp, feels, humidity, wind
        );

        let day_labels = ["오늘", "내일", "모레"];
        for i in 0..3 {
            let tmax = max_temps.and_then(|a| a.get(i)).and_then(|v| v.as_f64());
            let tmin = min_temps.and_then(|a| a.get(i)).and_then(|v| v.as_f64());
            let rain = precip.and_then(|a| a.get(i)).and_then(|v| v.as_i64());
            if let (Some(mx), Some(mn)) = (tmax, tmin) {
                let rain_str = rain.map(|r| format!(" 강수 {}%", r)).unwrap_or_default();
                result.push_str(&format!("\n{}: 최고 {:.0}°C / 최저 {:.0}°C{}", day_labels[i], mx, mn, rain_str));
            }
        }
        Ok(result)
    }

    #[tauri::command]
    pub fn news_search(db: State<DbState>, query: String) -> Result<String, String> {
        // Read API key from settings table
        let api_key = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let result: rusqlite::Result<String> = conn.query_row(
                "SELECT value FROM settings WHERE key = 'newsapi_key'",
                [],
                |row| row.get(0),
            );
            match result {
                Ok(k) if !k.trim().is_empty() => k,
                _ => return Err("NewsAPI 키가 설정되지 않았습니다. 설정에서 NewsAPI 키를 입력해주세요.".to_string()),
            }
        };

        let url = format!(
            "https://newsapi.org/v2/everything?q={}&sortBy=publishedAt&pageSize=5&language=en&apiKey={}",
            urlencoding(&query), api_key
        );

        let resp: serde_json::Value = reqwest::blocking::Client::new()
            .get(&url)
            .send()
            .map_err(|e| e.to_string())?
            .json()
            .map_err(|e| e.to_string())?;

        if resp["status"] != "ok" {
            let msg = resp["message"].as_str().unwrap_or("API 오류");
            return Err(format!("NewsAPI 오류: {}", msg));
        }

        let articles = resp["articles"].as_array()
            .ok_or("기사 없음")?;

        if articles.is_empty() {
            return Ok(format!("'{}' 검색 결과 없음", query));
        }

        let mut result = format!("'{}' 뉴스 검색 결과\n", query);
        for (i, article) in articles.iter().enumerate().take(5) {
            let title = article["title"].as_str().unwrap_or("제목 없음");
            let source = article["source"]["name"].as_str().unwrap_or("");
            let desc = article["description"].as_str().unwrap_or("");
            let art_url = article["url"].as_str().unwrap_or("");
            let published = article["publishedAt"].as_str().unwrap_or("").get(..10).unwrap_or("");
            result.push_str(&format!("\n{}. [{}] {} ({})\n   {}\n   {}\n", i+1, source, title, published, desc, art_url));
        }
        Ok(result)
    }

    /// macOS URL 스킴 또는 앱을 엽니다 (권한 설정 페이지 열기 등에 사용)
    #[tauri::command]
    pub fn open_url(url: String) -> Result<(), String> {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn weather_code_to_str(code: i64) -> &'static str {
    match code {
        0 => "맑음 ☀",
        1 => "대체로 맑음 🌤",
        2 => "부분 흐림 ⛅",
        3 => "흐림 ☁",
        45 | 48 => "안개 🌫",
        51 | 53 | 55 => "이슬비 🌦",
        61 | 63 => "비 🌧",
        65 => "강한 비 🌧",
        71 | 73 | 75 => "눈 🌨",
        77 => "눈보라 ❄",
        80 | 81 | 82 => "소나기 🌦",
        85 | 86 => "눈 소나기 🌨",
        95 => "천둥번개 ⛈",
        96 | 99 => "우박 동반 뇌우 ⛈",
        _ => "알 수 없음",
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
            commands::todo_list,
            commands::todo_add,
            commands::todo_complete,
            commands::schedule_list,
            commands::schedule_add,
            commands::code_exec,
            commands::web_search,
            commands::web_scrape,
            commands::settings_set,
            commands::settings_get,
            commands::conversation_save,
            commands::conversation_load,
            commands::conversation_delete,
            commands::weather_get,
            commands::news_search,
            commands::open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
