//! 서버와 다시 맞추기(docs/neko-sync.md §4.5). 보통 동기화는 순번(since) 뒤의 것만 주고받아, 한 번 빠진 기록(조용히 거절된 것,
//! 다른 기기가 막혀 있던 사이 놓친 것)은 다시 오가지 않았다. 하루 한 번쯤·켤 때(너무 잦지 않게)·설정의 버튼으로 서버에 있는 기록
//! 머리(번호·시각·기기·지움, 본문 없음)를 다 받아 내 사본과 견준다:
//! - 서버에만 있거나 서버 것이 더 새것 → 그 기록만 골라 받는다(지움 표시는 머리만으로 적용).
//! - 나만 있거나 내 것이 더 새것 → 올릴 거리로 찍는다(다음 주고받기에 올라간다).
//! - 같은 번호인데 다르면 지금 규칙(apply: (ts, 기기) 이김, 가구 합치기, 사용자가 지운 세션은 늘 이김)대로.
//!
//! 옛 서버(목록 API 가 없음)면 전부 다시 올리고 처음부터 다시 받는다(무거우니 주 1회).

use super::*;
use std::collections::HashSet;

/// 서버 기록의 머리(본문 없이)
#[derive(Deserialize, Clone, Debug)]
pub struct Head {
    pub coll: String,
    pub id: String,
    #[serde(default)]
    pub parent: Option<String>,
    pub ts: i64,
    #[serde(default)]
    pub device: String,
    #[serde(default)]
    pub deleted: i64,
    #[serde(default)]
    pub cut: Option<i64>,
}

#[derive(Default, Debug)]
pub struct Plan {
    /// 골라 받을 기록(coll, id)
    pub fetch: Vec<(String, String)>,
    /// 머리만으로 적용하는 지움 표시
    pub tombs: Vec<Record>,
    /// 올릴 거리로 찍은 수
    pub pushed: usize,
}

/// 다시 맞춘 결과(설정 › 동기화에 짧게 보인다)
#[derive(Serialize, Default, Debug, Clone, PartialEq)]
pub struct Outcome {
    pub fetched: usize,
    pub pushed: usize,
    pub deleted: usize,
    /// 옛 서버라 전부 다시 맞추는 중(개수는 모른다)
    pub heavy: bool,
}

/// 서버 머리 전부와 내 사본을 견준다. 올릴 것은 바로 dirty 로 찍는다. 아직 안 올린 것(dirty)은 건드리지 않는다
pub fn plan(conn: &Connection, me: &str, heads: &[Head]) -> AppResult<Plan> {
    type Local = (i64, String, i64, Option<i64>, bool);
    let local: HashMap<(String, String), Local> = conn
        .prepare("SELECT coll, uid, ts, device, deleted, cut, dirty FROM sync_meta")?
        .query_map([], |r| Ok(((r.get(0)?, r.get(1)?), (r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get::<_, i64>(6)? == 1))))?
        .collect::<Result<_, _>>()?;
    let mark = |coll: &str, uid: &str| conn.execute("UPDATE sync_meta SET dirty = 1 WHERE coll = ?1 AND uid = ?2", params![coll, uid]);
    let mut out = Plan::default();
    let mut seen = HashSet::new();
    for h in heads {
        seen.insert((h.coll.as_str(), h.id.as_str()));
        match local.get(&(h.coll.clone(), h.id.clone())) {
            Some(l) if l.4 => {} // 곧 올라간다
            Some(_) if h.coll == "msg" => {} // 말은 덧붙기만: 있으면 같다
            // 둘 다 지웠다. 받은 지움을 적용할 때 트리거가 내 표시 시각을 새로 찍어, 견주면 매번 다시 올릴 거리가 됐다
            Some(l) if l.2 == 1 && h.deleted == 1 => {}
            Some((lts, ldev, ..)) => {
                let ldev = if ldev.is_empty() { me } else { ldev.as_str() };
                let (mine, theirs) = ((*lts, ldev), (h.ts, h.device.as_str()));
                if mine > theirs {
                    mark(&h.coll, &h.id)?;
                    out.pushed += 1;
                } else if mine < theirs {
                    if h.deleted == 1 { out.tombs.push(tomb(h)) } else { out.fetch.push((h.coll.clone(), h.id.clone())) }
                }
            }
            // 나한테 없다: 살아 있으면 받고, 지움 표시면 할 일이 없다
            None if h.deleted == 0 => out.fetch.push((h.coll.clone(), h.id.clone())),
            None => {}
        }
    }
    // 서버에 없는 내 것은 다시 올린다. 빼는 것: 자동 삭제 표시(cut 있는 세션 지움 — 그새 다른 기기가 되살렸을 수 있다),
    // 지운 세션에 늦게 적힌 말(서버가 늘 gone 으로 거절해 매번 다시 올릴 거리가 된다)
    let dead: HashSet<&str> = heads.iter().filter(|h| h.coll == "session" && h.deleted == 1).map(|h| h.id.as_str())
        .chain(local.iter().filter(|((c, _), l)| c == "session" && l.2 == 1).map(|((_, u), _)| u.as_str()))
        .collect();
    let parent: HashMap<String, String> = conn
        .prepare("SELECT s.uid, c.session_id FROM sync_meta s JOIN conversation_messages c ON s.coll = 'msg' AND s.local_key = CAST(c.id AS TEXT)")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for ((coll, uid), (_, _, deleted, cut, dirty)) in &local {
        if *dirty || seen.contains(&(coll.as_str(), uid.as_str())) {
            continue;
        }
        let orphan = coll == "msg" && parent.get(uid).is_some_and(|p| dead.contains(p.as_str()));
        if !orphan && !(coll == "session" && *deleted == 1 && cut.is_some()) {
            mark(coll, uid)?;
            out.pushed += 1;
        }
    }
    Ok(out)
}

fn tomb(h: &Head) -> Record {
    Record { coll: h.coll.clone(), id: h.id.clone(), parent: h.parent.clone(), ts: h.ts, device: h.device.clone(), deleted: 1, cut: h.cut, blob: None }
}

/// 옛 서버(목록 API 없음): 전부 다시 올리고 받기는 무거워 주 1회만 한다 — 버튼(설정 › 동기화)을 자주 눌러도. 찍은 수(안 했으면 0)
pub fn heavy_fallback(conn: &Connection, now: i64) -> AppResult<usize> {
    let last = if state(conn, "reconcile_heavy")?.is_some() { state_i64(conn, "reconciled_at")? } else { 0 };
    set_state(conn, "reconcile_heavy", "1")?;
    if now - last < 7 * 86_400_000 {
        return Ok(0);
    }
    set_state(conn, "reconciled_at", &now.to_string())?;
    resend_all(conn)
}

/// 기록을 전부 다시 올리고(자동 삭제 표시는 빼고) 처음부터 다시 받는다. 찍은 수
pub fn resend_all(conn: &Connection) -> AppResult<usize> {
    let n = conn.execute("UPDATE sync_meta SET dirty = 1 WHERE dirty = 0 AND NOT (coll = 'session' AND deleted = 1 AND cut IS NOT NULL)", [])?;
    set_state(conn, "since", "0")?;
    Ok(n)
}

#[derive(Deserialize)]
struct HeadsResp {
    heads: Vec<Head>,
    #[serde(default)]
    next: Option<Value>,
}

#[derive(Deserialize)]
struct FetchResp {
    records: Vec<Record>,
    /// 1MB 를 넘어 이번에 못 실은 번호(다시 묻는다)
    #[serde(default)]
    rest: Vec<(String, String)>,
}

/// 골라 받기 한 번에 묻는 번호 수(서버 D1 묶는 값 100개 = 번호 50쌍)
const FETCH_KEYS: usize = 50;

/// 서버와 다시 맞춘다. 올릴 거리는 찍기만 하고, 실제로 올리는 건 이어지는 주고받기(round)가 한다. 화면이 다시 읽을 것도 돌려준다
pub async fn reconcile(db: &Mutex<Connection>, srv: &Server) -> AppResult<(Outcome, Changes)> {
    let mut heads = Vec::new();
    let mut after = Value::Null;
    loop {
        let page: HeadsResp = match call(reqwest::Method::POST, &srv.url, "/v1/heads", Some(&srv.token), &serde_json::json!({ "after": after })).await {
            Ok(p) => p,
            // 목록 API 가 없는 옛 서버(사용자가 Worker 를 아직 안 바꿈)
            Err(e) if e.to_string().contains("(404)") => {
                let pushed = heavy_fallback(&*db.lock()?, now_ms())?;
                return Ok((Outcome { pushed, heavy: true, ..Default::default() }, Changes::default()));
            }
            Err(e) => return Err(e),
        };
        heads.extend(page.heads);
        match page.next {
            Some(n) if !n.is_null() => after = n,
            _ => break,
        }
    }
    let plan = plan(&*db.lock()?, &srv.device, &heads)?;
    let mut out = Outcome { pushed: plan.pushed, deleted: plan.tombs.len(), ..Default::default() };
    let mut ch = Changes::default();
    {
        let conn = db.lock()?;
        let tx = conn.unchecked_transaction()?;
        for t in &plan.tombs {
            apply(&tx, &srv.device, &srv.key, t, &mut ch)?;
        }
        tx.commit()?;
    }
    let mut keys = plan.fetch;
    while !keys.is_empty() {
        let ask: Vec<_> = keys.drain(..keys.len().min(FETCH_KEYS)).collect();
        let resp: FetchResp = call(reqwest::Method::POST, &srv.url, "/v1/fetch", Some(&srv.token), &serde_json::json!({ "keys": ask })).await?;
        let conn = db.lock()?;
        let tx = conn.unchecked_transaction()?;
        for r in &resp.records {
            // 하나 못 풀었다고 나머지를 멈추지 않는다(보통 받기와 같다)
            match apply(&tx, &srv.device, &srv.key, r, &mut ch) {
                Ok(()) => out.fetched += 1,
                Err(e) => log::warn!("다시 맞추기: {} {} 적용 못 함: {e}", r.coll, r.id),
            }
        }
        for id in &ch.sessions {
            crate::db::conversations::trim(&tx, id)?;
        }
        tx.commit()?;
        // 못 실은 번호는 먼저 다시 묻는다. 서버가 아무것도 못 실었으면(이상한 응답) 멈춘다
        if resp.records.is_empty() && !resp.rest.is_empty() {
            break;
        }
        keys.splice(0..0, resp.rest);
    }
    let conn = db.lock()?;
    set_state(&conn, "reconciled_at", &now_ms().to_string())?;
    conn.execute("DELETE FROM sync_state WHERE key = 'reconcile_heavy'", [])?;
    Ok((out, ch))
}
