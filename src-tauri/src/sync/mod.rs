//! 기기 간 동기화 엔진(docs/neko-sync.md §2·§3). 서버는 server/ 의 Worker.
//!
//! 모든 것을 기록(record) 하나로 본다. 로컬 행 ↔ 기록 번호와 "아직 안 올림"은 sync_meta 에 있고,
//! 쓰는 곳 대신 트리거가 찍는다(db 마이그레이션 4). 여기는
//!  - collect: 안 올린 것을 모아 기록으로 만들고 잠근다(XChaCha20-Poly1305, 머리는 AAD).
//!  - apply: 받은 기록을 풀어 로컬에 적는다((ts, device) 겨루기, 지움·cut·자동 삭제 되살리기, 같은 기억 합치기).
//!  - round: 서버와 한 번 주고받는다(잠금은 네트워크 밖에서만 잡는다).
//! Tauri 쪽(키체인·주기·이벤트·커맨드)은 run.rs.

use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

mod furniture;
pub mod reconcile;
pub mod run;

pub type Key = [u8; 32];

/// 서버와 주고받는 기록 하나. 서버는 blob 말고 다 읽는다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Record {
    pub coll: String,
    pub id: String,
    pub parent: Option<String>,
    pub ts: i64,
    #[serde(default)]
    pub device: String,
    #[serde(default)]
    pub deleted: i64,
    pub cut: Option<i64>,
    pub blob: Option<String>,
}

/// 받은 것 중 화면이 다시 읽어야 할 것(`sync-changed` 이벤트 내용).
#[derive(Serialize, Default, Clone, Debug)]
pub struct Changes {
    pub colls: BTreeSet<String>,
    /// 메시지·요약·지움이 바뀐 세션
    pub sessions: BTreeSet<String>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.colls.is_empty()
    }
}

const GIFTS: &str = "neko_gifts";
pub const PUSH_MAX: usize = 20;
/// 이보다 큰 메시지는 첨부·그림 본문(dataUrl)을 빼고 올린다(§4.2, 서버 한 건 1MB)
const SHRINK_AT: usize = 700_000;
/// 한 번 올리기 요청에 싣는 암호문 합(받기 PULL_BYTES 와 같게). 그림이 든 기록 20개를 한꺼번에 실으면 요청이 수십 MB 가 됐다
const PUSH_BYTES: usize = 1_000_000;
/// D1 무료 쓰기 한도(하루 10만 행)를 처음 올리기가 다 먹지 않게(§4.4)
const DAY_PUSH_MAX: i64 = 20_000;
/// 한 번 주고받기에서 서버에 거는 요청 상한. 처음 올리기는 여러 번에 나뉜다
const ROUND_REQUESTS: usize = 25;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ── 암호화 ───────────────────────────────────────────────────────────────────

/// 머리 정보를 덧붙임 자료로 묶는다. 서버가 암호문을 다른 기록에 바꿔 끼우면 풀리지 않는다.
fn aad(r: &Record) -> String {
    format!("{}|{}|{}|{}|{}", r.coll, r.id, r.parent.as_deref().unwrap_or(""), r.ts, r.device)
}

/// base64(nonce 24 + 암호문)
pub fn seal(key: &Key, r: &Record, plain: &[u8]) -> AppResult<String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ct = cipher
        .encrypt(&nonce, Payload { msg: plain, aad: aad(r).as_bytes() })
        .map_err(|_| AppError::msg("기록을 암호화하지 못했습니다."))?;
    let mut out = nonce.to_vec();
    out.extend(ct);
    Ok(B64.encode(out))
}

pub fn unseal(key: &Key, r: &Record) -> AppResult<Vec<u8>> {
    let raw = B64.decode(r.blob.as_deref().unwrap_or("")).map_err(|_| AppError::msg("기록 모양이 이상해"))?;
    if raw.len() < 24 {
        return Err(AppError::msg("기록 모양이 이상해"));
    }
    let (nonce, ct) = raw.split_at(24);
    XChaCha20Poly1305::new(key.into())
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: aad(r).as_bytes() })
        .map_err(|_| AppError::msg("기록을 풀지 못했습니다. 암호 키가 다르거나 기록이 바뀌었습니다."))
}

// ── 로컬 표 ──────────────────────────────────────────────────────────────────

/// 표 하나 = 기록 종류 하나. natural: 키가 곧 기록 번호(세션 id, 설정 키). 아니면 정수 id ↔ uid.
struct Table {
    coll: &'static str,
    table: &'static str,
    key: &'static str,
    natural: bool,
    cols: &'static [&'static str],
    /// 받을 때 큰 쪽을 남기는 칸(기억의 쓴 때·잊은 때, 0.1.29). 기록에 없으면(옛 기기) 지금 값을 지킨다
    maxed: &'static [&'static str],
}

const TABLES: &[Table] = &[
    Table { coll: "session", table: "sessions", key: "id", natural: true, cols: &["title", "created_at", "summary"], maxed: &[] },
    Table { coll: "setting", table: "settings", key: "key", natural: true, cols: &["value"], maxed: &[] },
    Table { coll: "msg", table: "conversation_messages", key: "id", natural: false, cols: &["session_id", "role", "content", "created_at", "attachments", "meta"], maxed: &[] },
    // 기억: 쓴 때·잊은 때(ms)는 큰 쪽을 남긴다 — 잊음 = 잊은 때가 쓴 때보다 나중(db::memories), 어느 순서로 받아도 같은 값
    Table { coll: "memory", table: "memories", key: "id", natural: false, cols: &["kind", "content", "created_at", "used_ms", "forgot_ms"], maxed: &["used_ms", "forgot_ms"] },
    Table { coll: "todo", table: "todos", key: "id", natural: false, cols: &["content", "status", "priority", "due_at", "created_at", "completed_at"], maxed: &[] },
    Table { coll: "event", table: "events", key: "id", natural: false, cols: &["title", "start_at", "end_at", "notes", "all_day", "created_at"], maxed: &[] },
];

fn table(coll: &str) -> Option<&'static Table> {
    TABLES.iter().find(|t| t.coll == coll)
}

/// 행 하나를 JSON 글로(기록 내용)
fn read_row(conn: &Connection, t: &Table, local_key: &str) -> AppResult<Option<String>> {
    let obj = t.cols.iter().map(|c| format!("'{c}', {c}")).collect::<Vec<_>>().join(", ");
    let sql = format!("SELECT json_object({obj}) FROM {} WHERE {} = ?1", t.table, t.key);
    Ok(conn.query_row(&sql, [local_key], |r| r.get(0)).optional()?)
}

/// 기록 내용을 행에 적고 로컬 키를 돌려준다. 트리거가 dirty 를 찍지만 바로 뒤 adopt 가 덮는다.
fn write_row(conn: &Connection, t: &Table, local_key: Option<&str>, uid: &str, plain: &str) -> AppResult<String> {
    let ext = |c: &&str| {
        if t.maxed.contains(c) { format!("COALESCE(json_extract(?1, '$.{c}'), 0)") } else { format!("json_extract(?1, '$.{c}')") }
    };
    let cols = t.cols.join(", ");
    let vals = t.cols.iter().map(ext).collect::<Vec<_>>().join(", ");
    if t.natural {
        let set = t.cols.iter().map(|c| format!("{c} = excluded.{c}")).collect::<Vec<_>>().join(", ");
        conn.execute(
            &format!("INSERT INTO {0} ({1}, {cols}) VALUES (?2, {vals}) ON CONFLICT ({1}) DO UPDATE SET {set}", t.table, t.key),
            params![plain, uid],
        )?;
        return Ok(uid.to_owned());
    }
    if let Some(k) = local_key {
        let set = t.cols.iter()
            .map(|c| if t.maxed.contains(c) { format!("{c} = MAX({c}, {})", ext(c)) } else { format!("{c} = {}", ext(c)) })
            .collect::<Vec<_>>().join(", ");
        if conn.execute(&format!("UPDATE {} SET {set} WHERE {} = ?2", t.table, t.key), params![plain, k])? > 0 {
            return Ok(k.to_owned());
        }
    }
    conn.execute(&format!("INSERT INTO {} ({cols}) VALUES ({vals})", t.table), params![plain])?;
    Ok(conn.last_insert_rowid().to_string())
}

/// 이 기록의 로컬 상태를 받은 값으로 맞춘다(dirty 0). 트리거가 새 번호로 만든 행은 지운다.
fn adopt(conn: &Connection, r: &Record, local_key: Option<&str>, sig: Option<&str>) -> AppResult<()> {
    if let Some(k) = local_key {
        conn.execute("DELETE FROM sync_meta WHERE coll = ?1 AND local_key = ?2 AND uid <> ?3", params![r.coll, k, r.id])?;
    }
    conn.execute(
        "INSERT INTO sync_meta (coll, uid, local_key, ts, device, deleted, dirty, cut, sig) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)
         ON CONFLICT (coll, uid) DO UPDATE SET local_key = excluded.local_key, ts = excluded.ts, device = excluded.device,
             deleted = excluded.deleted, dirty = 0, cut = excluded.cut, sig = excluded.sig",
        params![r.coll, r.id, local_key, r.ts, r.device, r.deleted, r.cut, sig],
    )?;
    Ok(())
}

/// 내가 지움 표시를 올린다(같은 기억 합치기·자동 삭제 되살리기 반대편)
fn tombstone_mine(conn: &Connection, coll: &str, uid: &str, ts: i64) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_meta (coll, uid, local_key, ts, deleted, dirty) VALUES (?1, ?2, NULL, ?3, 1, 1)
         ON CONFLICT (coll, uid) DO UPDATE SET local_key = NULL, deleted = 1, dirty = 1, cut = NULL, ts = MAX(excluded.ts, ts + 1)",
        params![coll, uid, ts],
    )?;
    Ok(())
}

pub fn state(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn set_state(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO sync_state (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn state_i64(conn: &Connection, key: &str) -> AppResult<i64> {
    Ok(state(conn, key)?.and_then(|v| v.parse().ok()).unwrap_or(0))
}

// ── 선물: settings 의 JSON 배열 하나를 선물 하나씩으로 ─────────────────────────

/// 기기 전용 값을 뺀다: 갖고 논 때(lastPlayed), 마당 모니터(placed.screen) — §10.2 결정
fn strip_gift(mut g: Value) -> Value {
    if let Some(o) = g.as_object_mut() {
        o.remove("lastPlayed");
        if let Some(p) = o.get_mut("placed").and_then(Value::as_object_mut) {
            p.remove("screen");
        }
    }
    g
}

fn load_gifts(conn: &Connection) -> AppResult<Vec<Value>> {
    Ok(crate::db::settings::get(conn, GIFTS)?
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .unwrap_or_default())
}

/// 선물함을 sync_meta 와 견줘 바뀐 선물에 dirty 를 찍는다. sig 는 기기 전용 값을 뺀 JSON(serde_json 은 키를
/// 정렬해 적는다) — 곧 올릴 내용이다.
fn refresh_gifts(conn: &Connection) -> AppResult<()> {
    let now = now_ms();
    let mut ids = BTreeSet::new();
    for g in load_gifts(conn)? {
        let Some(id) = g.get("id").and_then(Value::as_str).map(str::to_owned) else { continue };
        let sig = strip_gift(g).to_string();
        conn.execute(
            "INSERT INTO sync_meta (coll, uid, local_key, ts, sig) VALUES ('gift', ?1, ?1, ?2, ?3)
             ON CONFLICT (coll, uid) DO UPDATE SET local_key = excluded.local_key, sig = excluded.sig,
                 ts = MAX(excluded.ts, ts + 1), dirty = 1, deleted = 0
             WHERE sig IS NOT excluded.sig OR deleted = 1",
            params![id, now, sig],
        )?;
        ids.insert(id);
    }
    let alive: Vec<String> = conn
        .prepare("SELECT uid FROM sync_meta WHERE coll = 'gift' AND deleted = 0")?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for uid in alive.iter().filter(|u| !ids.contains(*u)) {
        conn.execute(
            "UPDATE sync_meta SET local_key = NULL, deleted = 1, dirty = 1, sig = NULL, ts = MAX(?2, ts + 1)
             WHERE coll = 'gift' AND uid = ?1",
            params![uid, now],
        )?;
    }
    Ok(())
}

/// 받은 선물을 선물함에 넣거나 뺀다. 이 기기의 lastPlayed·마당 모니터는 남긴다.
fn apply_gift(conn: &Connection, r: &Record, plain: Option<&str>) -> AppResult<Option<String>> {
    let mut gifts = load_gifts(conn)?;
    let at = gifts.iter().position(|g| g.get("id").and_then(Value::as_str) == Some(r.id.as_str()));
    let mut sig = None;
    match plain {
        None => {
            if let Some(i) = at {
                gifts.remove(i);
            }
        }
        Some(p) => {
            let mut v: Value = serde_json::from_str(p).map_err(|_| AppError::msg("선물 모양이 이상해"))?;
            if !v.is_object() || v.get("id").and_then(Value::as_str) != Some(r.id.as_str()) {
                return Err(AppError::msg("선물 모양이 이상해"));
            }
            sig = Some(strip_gift(v.clone()).to_string());
            if let Some(i) = at {
                let old = &gifts[i];
                if let Some(lp) = old.get("lastPlayed") {
                    v["lastPlayed"] = lp.clone();
                }
                let on_screen = |g: &Value| g.pointer("/placed/at").and_then(Value::as_str) == Some("screen");
                if on_screen(&v) && on_screen(old) {
                    if let Some(scr) = old.pointer("/placed/screen") {
                        v["placed"]["screen"] = scr.clone();
                    }
                }
                gifts[i] = v;
            } else {
                gifts.push(v);
            }
        }
    }
    save_gifts(conn, gifts)?;
    Ok(sig)
}

// ── 화면의 선물함 바꾸기 ─────────────────────────────────────────────────────
// 화면은 배열을 통째로 저장하지 않고 선물 하나씩 보낸다. DB 안(잠금 아래)에서 지금 배열에 합치므로, 동기화가 막
// 넣은 선물을 화면이 아직 못 본 채 저장해도 그 선물이 덮이거나 지움으로 올라가지 않는다. 지움으로 올라가는 건
// 화면이 이름(id)으로 뺀 것뿐이다.

fn save_gifts(conn: &Connection, gifts: Vec<Value>) -> AppResult<()> {
    crate::db::settings::set(conn, GIFTS, &Value::Array(gifts).to_string())
}

fn gift_id(g: &Value) -> Option<&str> {
    g.get("id").and_then(Value::as_str)
}

/// 새 선물(같은 id 가 있으면 바꾼다)
pub fn gift_add(conn: &Connection, gift: &Value) -> AppResult<()> {
    let id = gift_id(gift).filter(|_| gift.is_object()).ok_or("선물에 id 가 없어")?;
    let mut gifts = load_gifts(conn)?;
    match gifts.iter().position(|g| gift_id(g) == Some(id)) {
        Some(i) => gifts[i] = gift.clone(),
        None => gifts.push(gift.clone()),
    }
    save_gifts(conn, gifts)
}

/// 있는 선물의 칸만 바꾼다(null 이면 그 칸을 뺀다). 없으면(다른 기기에서 지웠다) 아무것도 안 한다 — 되살리지 않는다
pub fn gift_patch(conn: &Connection, id: &str, patch: &Value) -> AppResult<bool> {
    let fields = patch.as_object().ok_or("바꿀 칸이 이상해")?;
    let mut gifts = load_gifts(conn)?;
    let Some(g) = gifts.iter_mut().find(|g| gift_id(g) == Some(id)).and_then(Value::as_object_mut) else { return Ok(false) };
    for (k, v) in fields {
        if k == "id" {
            continue;
        }
        if v.is_null() {
            g.remove(k);
        } else {
            g.insert(k.clone(), v.clone());
        }
    }
    save_gifts(conn, gifts)?;
    Ok(true)
}

pub fn gift_remove(conn: &Connection, ids: &[String]) -> AppResult<()> {
    let mut gifts = load_gifts(conn)?;
    gifts.retain(|g| !gift_id(g).is_some_and(|id| ids.iter().any(|x| x == id)));
    save_gifts(conn, gifts)
}

// ── 모으기 ───────────────────────────────────────────────────────────────────

/// 큰 메시지에서 첨부·meta 의 그림 본문(dataUrl)을 비운다(이름·종류·크기는 남는다). 큰 것부터, SHRINK_AT 아래가 될 때까지만 —
/// 작은 그림(SVG·줄인 사진)은 같이 넘어가 다른 기기에서도 보인다(전엔 하나라도 넘으면 전부 비웠다)
fn shrink(plain: &str) -> String {
    fn data_sizes(v: &Value, out: &mut Vec<usize>) {
        match v {
            Value::String(s) if s.starts_with("data:") => out.push(s.len()),
            Value::Array(a) => a.iter().for_each(|x| data_sizes(x, out)),
            Value::Object(o) => o.values().for_each(|x| data_sizes(x, out)),
            _ => {}
        }
    }
    /// cut 보다 크거나 같은 그림 본문을 비운다
    fn drop_data(v: &mut Value, cut: usize) {
        match v {
            Value::String(s) if s.starts_with("data:") && s.len() >= cut => s.clear(),
            Value::Array(a) => a.iter_mut().for_each(|x| drop_data(x, cut)),
            Value::Object(o) => o.values_mut().for_each(|x| drop_data(x, cut)),
            _ => {}
        }
    }
    /// 긴 글(첨부 파일의 본문 글·도구 결과 등)을 앞부분만 남긴다
    fn clip_long(v: &mut Value) {
        match v {
            Value::String(s) if s.chars().count() > CLIP => *s = s.chars().take(CLIP).collect::<String>() + "…",
            Value::Array(a) => a.iter_mut().for_each(clip_long),
            Value::Object(o) => o.values_mut().for_each(clip_long),
            _ => {}
        }
    }
    const CLIP: usize = 2000;
    const INNER: [&str; 2] = ["attachments", "meta"];
    let Ok(mut v) = serde_json::from_str::<Value>(plain) else { return plain.to_owned() };
    let inner = |v: &Value, f: &str| v.get(f).and_then(Value::as_str).and_then(|s| serde_json::from_str::<Value>(s).ok());
    // 1) 그림 본문을 큰 것부터, 2) 그래도 크면 첨부·meta 의 긴 글, 3) 그래도 크면 말 자체를 줄인다 — 서버 한 건(1MB)을 넘으면
    // 조용히 거절돼(too_big) 그 말이 다른 기기에 영영 안 갔다
    let mut sizes = Vec::new();
    for f in INNER {
        if let Some(i) = inner(&v, f) {
            data_sizes(&i, &mut sizes);
        }
    }
    sizes.sort_unstable_by(|a, b| b.cmp(a));
    let (mut over, mut cut) = (plain.len().saturating_sub(SHRINK_AT), usize::MAX);
    for n in sizes {
        if over == 0 {
            break;
        }
        cut = n;
        over = over.saturating_sub(n);
    }
    for pass in 0..2 {
        for f in INNER {
            if let Some(mut i) = inner(&v, f) {
                if pass == 0 { drop_data(&mut i, cut) } else { clip_long(&mut i) }
                v[f] = Value::String(i.to_string());
            }
        }
        if v.to_string().len() <= SHRINK_AT {
            return v.to_string();
        }
    }
    if let Some(Value::String(c)) = v.get("content") {
        let keep = c.chars().take(SHRINK_AT / 4).collect::<String>() + "…";
        v["content"] = Value::String(keep);
    }
    v.to_string()
}

/// 안 올린 것을 PUSH_MAX 개까지 기록으로. 세션을 먼저(메시지가 지워진 세션에 붙지 않게), 메시지는 나중.
pub fn collect(conn: &Connection, me: &str, key: &Key) -> AppResult<Vec<Record>> {
    refresh_gifts(conn)?;
    let rows: Vec<(String, String, Option<String>, i64, i64, Option<i64>, Option<String>)> = conn
        .prepare(
            "SELECT coll, uid, local_key, ts, deleted, cut, sig FROM sync_meta WHERE dirty = 1
             ORDER BY CASE coll WHEN 'session' THEN 0 WHEN 'msg' THEN 2 ELSE 1 END, ts LIMIT ?1",
        )?
        .query_map([PUSH_MAX as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)))?
        .collect::<Result<_, _>>()?;
    let mut out = Vec::new();
    let mut bytes = 0;
    for (coll, uid, local_key, ts, deleted, cut, sig) in rows {
        if bytes >= PUSH_BYTES {
            break; // 나머지는 다음 요청에
        }
        let mut r = Record {
            coll: coll.clone(), id: uid.clone(), parent: None, ts, device: me.to_owned(), deleted,
            cut: if coll == "session" { cut } else { None }, blob: None,
        };
        if deleted == 0 {
            let plain = match (coll.as_str(), table(&coll), &local_key) {
                ("gift", _, _) => sig,
                (_, Some(t), Some(k)) => read_row(conn, t, k)?,
                _ => None,
            };
            // 행이 사이에 사라졌다(지움 표시는 트리거가 따로 찍는다). 이 기록은 그만 올린다
            let Some(mut plain) = plain else {
                conn.execute("UPDATE sync_meta SET dirty = 0 WHERE coll = ?1 AND uid = ?2", params![coll, uid])?;
                continue;
            };
            if coll == "msg" {
                r.parent = serde_json::from_str::<Value>(&plain).ok()
                    .and_then(|v| v.get("session_id").and_then(Value::as_str).map(str::to_owned));
                if plain.len() > SHRINK_AT {
                    plain = shrink(&plain);
                }
            }
            r.blob = Some(seal(key, &r, plain.as_bytes())?);
        }
        bytes += r.blob.as_ref().map_or(0, String::len) + 200;
        out.push(r);
    }
    Ok(out)
}

/// 끼어드는 기기의 같이 쓰는 설정(외형·이름·성격·프로필·지우기 설정)을 양보시킨다: 올리지 않고, 받는 쪽이 이긴다.
/// 동기화는 나중에 쓴 쪽이 이기는데, 방금 켠 기기가 적어 둔 값(기본 외형 등)이 더 새것이라 쓰던 기기의 설정을 덮었다.
/// 그쪽에 없는 설정은 이 기기 값이 남고, 여기서 다시 바꾸면 그때 올라간다.
pub fn yield_settings(conn: &Connection) -> AppResult<()> {
    conn.execute("UPDATE sync_meta SET ts = 0, dirty = 0 WHERE coll = 'setting'", [])?;
    Ok(())
}

/// 이번에 받은 것이 처음부터(since 0) 받은 것인가
fn since_was_zero(conn: &Connection) -> AppResult<bool> {
    Ok(state_i64(conn, "since")? == 0)
}

// ── 적용 ─────────────────────────────────────────────────────────────────────

/// 사용자가 지운 세션(cut 없는 지움 표시)은 늘 이기고 되살릴 수 없다. 자동 삭제는 cut 이 있다.
fn user_tomb(deleted: i64, cut: Option<i64>) -> bool {
    deleted == 1 && cut.is_none()
}

/// 받은 기록 하나를 로컬에 적는다. 이미 같은 것이나 더 새 것이 있으면 아무것도 안 한다.
pub fn apply(conn: &Connection, me: &str, key: &Key, r: &Record, ch: &mut Changes) -> AppResult<()> {
    let local: Option<(Option<String>, i64, String, i64, Option<i64>)> = conn
        .query_row(
            "SELECT local_key, ts, device, deleted, cut FROM sync_meta WHERE coll = ?1 AND uid = ?2",
            params![r.coll, r.id],
            |x| Ok((x.get(0)?, x.get(1)?, x.get(2)?, x.get(3)?, x.get(4)?)),
        )
        .optional()?;
    let session = r.coll == "session";
    // 맞추는 설정 키만 받는다. 연결된 다른 기기라도 권한·경로·비밀 같은 로컬 설정은 못 바꾼다(지움도 같다)
    if r.coll == "setting" && !crate::db::SYNCED_SETTINGS.contains(&r.id.as_str()) {
        log::warn!("동기화: 맞추지 않는 설정 키를 받아 버렸어: {}", r.id);
        return Ok(());
    }
    if r.coll == "setting" && r.id == furniture::KEY && r.deleted == 0 && apply_furniture(conn, key, r, local.as_ref().map(|l| (l.1, l.2.as_str())), ch)? {
        return Ok(());
    }
    if let Some((_, lts, ldev, ldel, lcut)) = &local {
        // 메시지는 덧붙기만: 이미 있으면 끝
        if r.coll == "msg" || (session && user_tomb(*ldel, *lcut)) {
            return Ok(());
        }
        let ldev = if ldev.is_empty() { me } else { ldev.as_str() };
        let forced = session && user_tomb(r.deleted, r.cut);
        if !forced && (*lts, ldev) >= (r.ts, r.device.as_str()) {
            return Ok(());
        }
    }
    let local_key = local.and_then(|l| l.0);
    if r.deleted == 1 {
        return apply_delete(conn, r, local_key.as_deref(), ch);
    }
    let plain = String::from_utf8(unseal(key, r)?).map_err(|_| AppError::msg("기록 글자가 이상해"))?;

    if r.coll == "gift" {
        let sig = apply_gift(conn, r, Some(&plain))?;
        adopt(conn, r, Some(&r.id), sig.as_deref())?;
        ch.colls.insert(r.coll.clone());
        return Ok(());
    }
    let t = table(&r.coll).ok_or_else(|| AppError::msg(format!("모르는 기록 종류: {}", r.coll)))?;

    if r.coll == "msg" {
        let parent = r.parent.as_deref().unwrap_or("");
        // 넣는 세션은 머리(parent, AAD 로 묶임)와 같아야 한다 — 지운 세션 검사를 내용으로 비켜 가지 못하게
        let inner = serde_json::from_str::<Value>(&plain).ok().and_then(|v| v.get("session_id").and_then(Value::as_str).map(str::to_owned));
        if parent.is_empty() || inner.as_deref() != Some(parent) {
            return Err(AppError::msg("메시지의 세션이 머리와 달라"));
        }
        // 지운 세션, 요약(cut)으로 지운 시각 안쪽이면 버린다
        let gone: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM sync_meta WHERE coll = 'session' AND uid = ?1 AND (deleted = 1 OR cut >= ?2))",
            params![parent, r.ts],
            |x| x.get(0),
        )?;
        if gone {
            return Ok(());
        }
        ch.sessions.insert(parent.to_owned());
    }
    if r.coll == "memory" && merge_memory(conn, r, &plain, local_key.as_deref())? {
        ch.colls.insert(r.coll.clone());
        return Ok(());
    }
    let k = write_row(conn, t, local_key.as_deref(), &r.id, &plain)?;
    adopt(conn, r, Some(&k), None)?;
    if session {
        // 수동 요약: cut 까지의 메시지를 지운다(아직 안 올린 것도 — 서버도 받지 않는다)
        if let Some(cut) = r.cut {
            conn.execute(
                "DELETE FROM conversation_messages WHERE session_id = ?1 AND CAST(id AS TEXT) IN (
                     SELECT local_key FROM sync_meta WHERE coll = 'msg' AND ts <= ?2)",
                params![r.id, cut],
            )?;
        }
        ch.sessions.insert(r.id.clone());
    }
    ch.colls.insert(r.coll.clone());
    Ok(())
}

/// 가구는 나중 기록이 통째로 이기지 않고 가구 하나씩 합친다(sync/furniture.rs). 내 값이 더 새것이어도 받은 것을 얹는다.
/// 받은 값에 없는 것이 남으면 받은 것보다 나중 시각으로 다시 올린다. 이 기기에 값이 없으면 false(보통대로 받는다)
fn apply_furniture(conn: &Connection, key: &Key, r: &Record, local: Option<(i64, &str)>, ch: &mut Changes) -> AppResult<bool> {
    let plain = String::from_utf8(unseal(key, r)?).map_err(|_| AppError::msg("기록 글자가 이상해"))?;
    let remote = serde_json::from_str::<Value>(&plain).ok().and_then(|v| v.get("value").and_then(Value::as_str).map(str::to_owned));
    let (Some(remote), Some(mine)) = (remote, crate::db::settings::get(conn, furniture::KEY)?) else { return Ok(false) };
    let (write, upload) = furniture::merge_values(Some(&mine), &remote, r.ts);
    if let Some(v) = &write {
        crate::db::settings::set(conn, furniture::KEY, v)?;
        ch.colls.insert(r.coll.clone());
    }
    let remote_newer = local.map_or(true, |(ts, dev)| (ts, dev) < (r.ts, r.device.as_str()));
    if upload {
        conn.execute(
            "INSERT INTO sync_meta (coll, uid, local_key, ts, dirty) VALUES ('setting', ?1, ?1, MAX(?2, ?3 + 1), 1)
             ON CONFLICT (coll, uid) DO UPDATE SET local_key = excluded.local_key, ts = MAX(ts + 1, excluded.ts), dirty = 1, deleted = 0",
            params![furniture::KEY, now_ms(), r.ts],
        )?;
    } else if write.is_some() || remote_newer {
        // 받은 값이 다 갖고 있다: 받은 기록으로 맞춘다(올릴 것 없음)
        adopt(conn, r, Some(furniture::KEY), None)?;
    }
    Ok(true)
}

/// 같은 내용의 기억이 다른 번호로 이미 있으면 하나로 합친다: 번호가 작은 쪽을 남기고 다른 쪽은 지움 표시.
/// 합쳤으면 true(더 할 일 없음).
fn merge_memory(conn: &Connection, r: &Record, plain: &str, mine: Option<&str>) -> AppResult<bool> {
    let content = serde_json::from_str::<Value>(plain).ok()
        .and_then(|v| v.get("content").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    let clash: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT CAST(m.id AS TEXT), s.uid FROM memories m
             LEFT JOIN sync_meta s ON s.coll = 'memory' AND s.local_key = CAST(m.id AS TEXT)
             WHERE m.content = ?1",
            [&content],
            |x| Ok((x.get(0)?, x.get(1)?)),
        )
        .optional()?;
    let Some((row, other)) = clash else { return Ok(false) };
    if Some(row.as_str()) == mine {
        return Ok(false);
    }
    let other = other.unwrap_or_default();
    if r.id < other {
        // 받은 번호가 이긴다: 그 행이 받은 번호를 갖고, 내 번호는 지움 표시로 올린다
        write_row(conn, table("memory").unwrap(), Some(&row), &r.id, plain)?;
        adopt(conn, r, Some(&row), None)?;
        if !other.is_empty() {
            tombstone_mine(conn, "memory", &other, now_ms())?;
        }
    } else {
        tombstone_mine(conn, "memory", &r.id, now_ms().max(r.ts + 1))?;
    }
    Ok(true)
}

fn apply_delete(conn: &Connection, r: &Record, local_key: Option<&str>, ch: &mut Changes) -> AppResult<()> {
    match r.coll.as_str() {
        "session" => {
            // 자동 삭제인데 아직 못 올린 새 메시지(기준 시각 cut 보다 늦은 것 — 서버가 자동 삭제를 거절하는 것과 같다)가 있으면
            // 세션을 되살려 올린다(§2.5 규칙 3). 다시 올리는 옛 말(resend_once)로는 되살리지 않는다
            let unsent: bool = conn.query_row(
                "SELECT EXISTS (SELECT 1 FROM conversation_messages c JOIN sync_meta s
                     ON s.coll = 'msg' AND s.local_key = CAST(c.id AS TEXT) WHERE c.session_id = ?1 AND s.dirty = 1 AND s.ts > ?2)",
                params![r.id, r.cut.unwrap_or(i64::MAX)],
                |x| x.get(0),
            )?;
            if r.cut.is_some() && unsent {
                conn.execute(
                    "UPDATE sync_meta SET ts = ?2, dirty = 1, deleted = 0, cut = NULL WHERE coll = 'session' AND uid = ?1",
                    params![r.id, now_ms().max(r.ts + 1)],
                )?;
                return Ok(());
            }
            conn.execute("DELETE FROM conversation_messages WHERE session_id = ?1", [&r.id])?;
            conn.execute("DELETE FROM sessions WHERE id = ?1", [&r.id])?;
            ch.sessions.insert(r.id.clone());
        }
        "gift" => {
            apply_gift(conn, r, None)?;
        }
        coll => {
            if let (Some(t), Some(k)) = (table(coll), local_key) {
                conn.execute(&format!("DELETE FROM {} WHERE {} = ?1", t.table, t.key), [k])?;
            }
        }
    }
    adopt(conn, r, None, None)?;
    ch.colls.insert(r.coll.clone());
    Ok(())
}

// ── 서버와 주고받기 ──────────────────────────────────────────────────────────

pub struct Server {
    pub url: String,
    pub token: String,
    pub device: String,
    pub key: Key,
}

#[derive(Deserialize)]
struct Rejected {
    coll: String,
    id: String,
    reason: String,
}

#[derive(Deserialize)]
struct SyncResp {
    #[serde(default)]
    records: Vec<Record>,
    #[serde(default)]
    seq: i64,
    #[serde(default)]
    more: bool,
    #[serde(default)]
    rejected: Vec<Rejected>,
    #[serde(default)]
    reset: bool,
    /// 기기들이 나눠 쓰는 마지막 산책(시작·끝·나간 기기). 옛 서버는 안 준다
    #[serde(default)]
    walk: Option<SharedWalk>,
    /// 기기들이 나눠 쓰는 놀이 게이지 기준(§4.7). 옛 서버는 칸 자체가 없고(None), 새 서버는 아직 기준이 없으면 null(Some(None))
    #[serde(default, deserialize_with = "present")]
    pet: Option<Option<SharedPet>>,
}

/// 칸이 있으면(null 이어도) Some — "서버가 이 기능을 안다"와 "값이 아직 없다"를 가른다
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
}

/// 놀이 게이지의 기준(§4.7): 서버가 행동을 적용해 잰 값(play)과 그때(at, ms). 화면 값은 기기가 같은 식으로 줄여 낸다.
/// feeds·day = 그날(UTC) 밥을 준 횟수
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct SharedPet {
    pub play: f64,
    pub at: i64,
    #[serde(default)]
    pub feeds: i64,
    #[serde(default)]
    pub day: String,
}

/// 받은 놀이 게이지 기준을 적는다(없으면 "null" — 서버가 기능은 안다). 바뀌었으면 true(화면에 알린다)
pub fn store_pet(conn: &Connection, pet: Option<&SharedPet>) -> AppResult<bool> {
    let next = serde_json::to_string(&pet).unwrap_or_else(|_| "null".into());
    if state(conn, "pet")?.as_deref() == Some(next.as_str()) {
        return Ok(false);
    }
    set_state(conn, "pet", &next)?;
    Ok(true)
}

/// 서버가 놀이 게이지를 아는가와 지금 기준. 옛 서버(칸을 안 줌)면 None
pub fn stored_pet(conn: &Connection) -> AppResult<Option<Option<SharedPet>>> {
    Ok(state(conn, "pet")?.and_then(|s| serde_json::from_str::<Option<SharedPet>>(&s).ok()))
}

/// 마지막 산책 하나를 기기들이 같이 본다(§5.4): 한 기기가 나가 있으면 다른 기기는 안 나가고, 다음 산책 시각도 이걸로 잰다.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct SharedWalk {
    pub start: i64,
    pub end: i64,
    pub device: String,
}

/// 받은 산책을 적는다. 바뀌었으면 true(화면에 알린다)
pub fn store_walk(conn: &Connection, walk: Option<&SharedWalk>) -> AppResult<bool> {
    let next = walk.map(|w| serde_json::to_string(w).unwrap_or_default()).unwrap_or_default();
    if state(conn, "walk")?.unwrap_or_default() == next {
        return Ok(false);
    }
    set_state(conn, "walk", &next)?;
    Ok(true)
}

pub fn stored_walk(conn: &Connection) -> AppResult<Option<SharedWalk>> {
    Ok(state(conn, "walk")?.and_then(|s| serde_json::from_str(&s).ok()))
}

pub(crate) fn client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client")
    })
}

/// 서버에 JSON 을 보내고 JSON 을 받는다. 401 은 끊긴 기기라 따로 알린다.
pub(crate) async fn call<T: serde::de::DeserializeOwned>(
    method: reqwest::Method, url: &str, path: &str, token: Option<&str>, body: &Value,
) -> AppResult<T> {
    let mut req = client().request(method, format!("{}{path}", url.trim_end_matches('/')));
    // GET·DELETE 는 본문 없이(Workers 는 본문 있는 GET 을 거절한다)
    if !body.is_null() {
        req = req.json(body);
    }
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req.send().await?;
    match res.status().as_u16() {
        200 => Ok(res.json().await?),
        401 => Err(AppError::msg("서버가 이 기기를 알아보지 못했습니다. 연결이 끊겼을 수 있습니다. 기기 연결 코드로 다시 연결하십시오.")),
        403 => Err(AppError::msg("서버가 요청을 거절했습니다. 설정 토큰이나 기기 연결 코드가 틀렸거나 만료되었습니다.")),
        s => Err(AppError::msg(format!("서버 오류입니다({s}). 서버 설정을 확인하십시오."))),
    }
}

fn push_budget_left(conn: &Connection) -> AppResult<bool> {
    let day = (now_ms() / 86_400_000).to_string();
    Ok(state(conn, "push_day")?.as_deref() != Some(day.as_str()) || state_i64(conn, "push_count")? < DAY_PUSH_MAX)
}

fn count_push(conn: &Connection, n: usize) -> AppResult<()> {
    let day = (now_ms() / 86_400_000).to_string();
    let before = if state(conn, "push_day")?.as_deref() == Some(day.as_str()) { state_i64(conn, "push_count")? } else { 0 };
    set_state(conn, "push_day", &day)?;
    set_state(conn, "push_count", &(before + n as i64).to_string())
}

/// 응답을 적는다: 올린 것은 dirty 를 내리고(그새 또 바뀌었으면 그대로), 받은 것을 적용하고, 순번을 옮긴다.
/// 처음부터 다시 받아야 하면 true.
fn settle(conn: &Connection, srv: &Server, push: &[Record], resp: &SyncResp, ch: &mut Changes) -> AppResult<bool> {
    let rejected: HashMap<(&str, &str), &str> =
        resp.rejected.iter().map(|x| ((x.coll.as_str(), x.id.as_str()), x.reason.as_str())).collect();
    let mut repull = false;
    for r in push {
        match rejected.get(&(r.coll.as_str(), r.id.as_str())) {
            // 자동 삭제가 거절됐다: 다른 기기가 그 세션에 썼다. 지움 표시를 버리고 처음부터 다시 받아 되찾는다.
            // ponytail: 전부 다시 받는다(드물다). 잦아지면 세션 하나만 받는 요청을 더한다
            Some(&"prune") => {
                conn.execute("DELETE FROM sync_meta WHERE coll = 'session' AND uid = ?1", [&r.id])?;
                repull = true;
            }
            // 받아들여짐, 졌음(이긴 기록이 records 로 온다), 버려짐(지운 세션의 메시지·시계) — 다시 올리지 않는다
            other => {
                if let Some(reason) = other {
                    log::warn!("동기화: {} {} 거절 ({reason})", r.coll, r.id);
                    // 졌음(lost)·지운 세션의 말(gone)은 늘 있는 일이다. 그 밖(too_big·clock …)은 그 기록이 다른 기기에 안 간다 —
                    // 조용히 넘기면 왜 안 보이는지 알 길이 없어 설정 › 동기화에 알린다
                    if !matches!(*reason, "lost" | "gone") {
                        let n = state_i64(conn, "rejected")? + 1;
                        set_state(conn, "rejected", &format!("{n}"))?;
                        set_state(conn, "rejected_why", reason)?;
                    }
                }
                conn.execute(
                    "UPDATE sync_meta SET dirty = 0, device = ?3 WHERE coll = ?1 AND uid = ?2 AND ts = ?4",
                    params![r.coll, r.id, srv.device, r.ts],
                )?;
            }
        }
    }
    if !push.is_empty() {
        count_push(conn, push.len())?;
    }
    let mut got = Changes::default();
    let mut skipped = 0i64;
    for r in &resp.records {
        // 하나 못 풀었다고 나머지를 멈추지 않는다
        if let Err(e) = apply(conn, &srv.device, &srv.key, r, &mut got) {
            log::warn!("동기화: {} {} 적용 못 함: {e}", r.coll, r.id);
            skipped += 1;
        }
    }
    // 못 받은 기록 수를 남긴다(설정 › 동기화가 알린다). 조용히 건너뛰기만 하면 다른 암호 키로 올라간 기록(선물·대화)이
    // 왜 안 보이는지 알 길이 없었다. 처음부터 다시 받을 때는 새로 센다
    if skipped > 0 || since_was_zero(conn)? {
        let before = if since_was_zero(conn)? { 0 } else { state_i64(conn, "skipped")? };
        set_state(conn, "skipped", &(before + skipped).to_string())?;
    }
    // 받을 때도 세션당 상한으로 자른다(§9) — 새 기기가 서버의 긴 대화를 다 받아도 다른 기기와 같은 만큼만
    for id in &got.sessions {
        crate::db::conversations::trim(conn, id)?;
    }
    ch.colls.extend(got.colls);
    ch.sessions.extend(got.sessions);
    // 옛 서버(walk 를 안 줌)면 적어 둔 것을 지우지 않는다
    if resp.walk.is_some() && store_walk(conn, resp.walk.as_ref())? {
        ch.colls.insert("walk".into());
    }
    // 놀이 게이지: 옛 서버(칸이 없음)면 적어 둔 것을 지워 화면이 예전 방식(기기마다)으로 돌아가게 한다
    match &resp.pet {
        Some(p) => {
            if store_pet(conn, p.as_ref())? {
                ch.colls.insert("pet".into());
            }
        }
        None => {
            if conn.execute("DELETE FROM sync_state WHERE key = 'pet'", [])? > 0 {
                ch.colls.insert("pet".into());
            }
        }
    }
    let again = resp.reset || repull;
    set_state(conn, "since", &(if again { 0 } else { resp.seq }).to_string())?;
    set_state(conn, "last_sync", &now_ms().to_string())?;
    Ok(again)
}

/// 서버와 한 번 맞춘다: 안 올린 것이 없고 더 받을 것이 없을 때까지(요청 ROUND_REQUESTS 번까지).
pub async fn round(db: &Mutex<Connection>, srv: &Server, active_at: i64) -> AppResult<Changes> {
    let mut ch = Changes::default();
    resend_once(&*db.lock()?)?;
    for _ in 0..ROUND_REQUESTS {
        let (push, since) = {
            let conn = db.lock()?;
            let push = if push_budget_left(&conn)? { collect(&conn, &srv.device, &srv.key)? } else { Vec::new() };
            (push, state_i64(&conn, "since")?)
        };
        // name: 기기 목록에 보일 이름. 이미 등록한 기기의 이름도 이걸로 고쳐진다(옛 서버는 무시한다)
        let body = serde_json::json!({ "since": since, "push": push, "active_at": active_at, "name": run::device_name() });
        let resp: SyncResp = call(reqwest::Method::POST, &srv.url, "/v1/sync", Some(&srv.token), &body).await?;
        let again = {
            let conn = db.lock()?;
            let tx = conn.unchecked_transaction()?;
            let again = settle(&tx, srv, &push, &resp, &mut ch)?;
            tx.commit()?;
            again
        };
        // 크기로 잘라 덜 실었으면(PUSH_BYTES) 바로 이어 올린다
        let left = !push.is_empty() && db.lock()?.query_row("SELECT EXISTS (SELECT 1 FROM sync_meta WHERE dirty = 1)", [], |r| r.get::<_, bool>(0))?;
        if !resp.more && !again && push.len() < PUSH_MAX && !left {
            break;
        }
    }
    Ok(ch)
}

/// 0.1.29 에서 한 번: 대화(세션·말)를 처음부터 다시 맞춘다. 서버에 못 간 기록(조용히 거절된 큰 말, 막힌 사이 쓴 것)을 다시 올리고
/// 처음부터 다시 받는다 — 사용자가 지운 세션은 지움 표시도 다시 올라가 다른 기기에서도 지워지고(지운 쪽이 이긴다), 한쪽에만 있던
/// 세션은 다른 쪽에 생긴다. 자동 삭제(cut 있는 지움)는 다시 올리지 않는다(그새 다른 기기가 되살렸을 수 있다).
/// 서버는 이미 있는 말을 그대로 두고(덧붙기만), 같은 시각의 세션은 받아들이니 두 번 쌓이지 않는다
fn resend_once(conn: &Connection) -> AppResult<()> {
    if state(conn, "resent_v1")?.is_some() {
        return Ok(());
    }
    conn.execute("UPDATE sync_meta SET dirty = 1 WHERE coll IN ('session', 'msg') AND NOT (deleted = 1 AND cut IS NOT NULL)", [])?;
    set_state(conn, "since", "0")?;
    set_state(conn, "resent_v1", &now_ms().to_string())
}

// ── 화면이 쓰는 세션 목록(localStorage 에서 옮겨 옴) ─────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub summary: Option<String>,
    /// 마지막으로 연 뒤에 온 답이 있다(읽기 전용 — 옮길 때는 무시)
    #[serde(default)]
    pub unread: bool,
}

pub fn session_list(conn: &Connection) -> AppResult<Vec<SessionRow>> {
    // 메시지 시각은 초 단위 글('YYYY-MM-DD HH:MM:SS', UTC)이라 초를 내려 ms 로 견준다.
    // 순서: 마지막 메시지(질문이든 답이든)가 최근인 세션이 위. 메시지가 없으면 만든 때로 친다. 메시지 시각은 쓴 기기의
    // 것이 그대로 동기화돼 기기마다 같은 순서가 된다
    let mut stmt = conn.prepare(
        "SELECT s.id, s.title, s.created_at, s.summary,
                COALESCE(CAST(strftime('%s', m.answered) AS INTEGER) * 1000 > COALESCE(s.read_at, 0), 0)
         FROM sessions s
         LEFT JOIN (SELECT session_id, MAX(created_at) AS last, MAX(CASE WHEN role = 'assistant' THEN created_at END) AS answered
                    FROM conversation_messages GROUP BY session_id) m ON m.session_id = s.id
         ORDER BY COALESCE(CAST(strftime('%s', m.last) AS INTEGER) * 1000, s.created_at) DESC, s.created_at DESC, s.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(SessionRow { id: r.get(0)?, title: r.get(1)?, created_at: r.get(2)?, summary: r.get(3)?, unread: r.get(4)? })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// 세션을 at(ms)까지 읽었다. 이 기기에만 남는다(동기화 안 함)
pub fn session_read(conn: &Connection, id: &str, at: i64) -> AppResult<()> {
    conn.execute("UPDATE sessions SET read_at = MAX(COALESCE(read_at, 0), ?2) WHERE id = ?1", params![id, at])?;
    Ok(())
}

/// 없으면 만들고, 있으면 제목만 바꾼다(요약은 session_compact 로)
/// 사용자가 지운 세션(cut 없는 지움 표시)이다. 이 기기·다른 기기에서 지운 세션을 화면의 낡은 목록(제목 바꿈·요약·옮기기)이
/// 다시 만들면 지움 표시가 풀려 올라갔다 — 서버가 다시 지우지만 그사이 목록이 튀었다. 세션 id 는 다시 쓰지 않으니 거절한다
fn user_deleted(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sync_meta WHERE coll = 'session' AND uid = ?1 AND deleted = 1 AND cut IS NULL)",
        [id],
        |r| r.get(0),
    )?)
}

pub fn session_put(conn: &Connection, id: &str, title: &str, created_at: i64) -> AppResult<()> {
    if user_deleted(conn, id)? {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO sessions (id, title, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO UPDATE SET title = excluded.title",
        params![id, title, created_at],
    )?;
    Ok(())
}

/// 처음 한 번 localStorage 의 목록·요약을 옮긴다. 이미 있는 세션은 건드리지 않는다.
pub fn session_import(conn: &Connection, rows: &[SessionRow]) -> AppResult<()> {
    for s in rows {
        if user_deleted(conn, &s.id)? {
            continue;
        }
        conn.execute(
            // 이 기기에 있던 대화라 다 읽은 것으로
            "INSERT INTO sessions (id, title, created_at, summary, read_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (id) DO NOTHING",
            params![s.id, s.title, s.created_at, s.summary, now_ms()],
        )?;
    }
    Ok(())
}

/// 사용자가 지운 세션: 메시지와 함께 지운다(트리거가 지움 표시)
pub fn session_delete(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM conversation_messages WHERE session_id = ?1", [id])?;
    conn.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
    Ok(())
}

/// 수동 요약: 요약을 적고 그 세션 메시지를 다 지운다. cut = 지금(그 세션 마지막 메시지보다 늦게)
pub fn session_compact(conn: &Connection, id: &str, summary: &str) -> AppResult<()> {
    if user_deleted(conn, id)? {
        return Ok(());
    }
    let cut: i64 = conn.query_row(
        "SELECT MAX(?2, COALESCE(MAX(s.ts), 0)) FROM conversation_messages c
         JOIN sync_meta s ON s.coll = 'msg' AND s.local_key = CAST(c.id AS TEXT) WHERE c.session_id = ?1",
        params![id, now_ms()],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO sessions (id, title, created_at, summary) VALUES (?1, '새 대화', ?3, ?2)
         ON CONFLICT (id) DO UPDATE SET summary = excluded.summary",
        params![id, summary, now_ms()],
    )?;
    conn.execute("UPDATE sync_meta SET cut = ?2, dirty = 1 WHERE coll = 'session' AND uid = ?1", params![id, cut])?;
    conn.execute("DELETE FROM conversation_messages WHERE session_id = ?1", [id])?;
    Ok(())
}

/// 자동 삭제로 지운 세션: 세션 행도 지우고 지움 표시에 기준 시각(cut)을 단다 — 서버는 그보다 새 메시지가
/// 있으면 거절하고, 받은 기기는 못 올린 메시지가 있으면 되살린다.
pub fn mark_pruned(conn: &Connection, ids: &[String], days: u32) -> AppResult<()> {
    let cutoff = now_ms() - days as i64 * 86_400_000;
    for id in ids {
        conn.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
        conn.execute(
            "UPDATE sync_meta SET cut = ?2 WHERE coll = 'session' AND uid = ?1 AND deleted = 1",
            params![id, cutoff],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
