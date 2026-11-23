//! 세션을 넘어 남는 기억.
//!
//! 대화 기록(`conversation_messages`)은 세션 안에서만 쓰이고, 사용자 프로필은
//! 사람이 직접 적어 넣는 텍스트 한 덩이였다. 그래서 어제 알려준 것을 오늘 모른다.
//!
//! ## 왜 FTS5 가 아니라 LIKE 인가
//!
//! 번들 SQLite 에 FTS5 는 있지만 한국어에 못 쓴다. 실측:
//!
//! | 토크나이저 | "고양이" | "사료"(본문에 존재) |
//! |---|---|---|
//! | unicode61(기본) | 0건 | 0건 |
//! | trigram | 1건 | 0건 |
//!
//! 기본 토크나이저는 어절 단위라 "고양이를" 만 맞고, trigram 은 3자 미만 질의를
//! 아예 못 찾는다. 한국어는 2음절 단어(일정·회의·마감·사료)가 흔해서 실패율이 높다.
//! 개인 기억 저장소는 수백 행 규모라 LIKE 로 훑어도 비용이 문제되지 않는다.

use crate::error::AppResult;
use rusqlite::{params, Connection};
use serde::Serialize;

/// 한 번에 떠올릴 기억의 상한. 컨텍스트가 좁아 많이 넣을 수 없다.
pub const RECALL_LIMIT: usize = 5;

/// 저장 상한(잊은 것 포함, 안전선). 넘으면 잊은 것부터, 그다음 오래 안 쓴 것부터 지운다. 보이는 기억은 쉴 때 잊기(forget)가
/// 사용자 상한(기본 300) 안으로 천천히 줄인다 — 이 선에 닿는 일은 하루에 아주 많이 저장할 때뿐이다.
const MAX_MEMORIES: usize = 1000;

// ── 잊기(0.1.29, 마이그레이션 13) ───────────────────────────────────────────────
// 오래됐다고 지우지 않는다(사용자: 기억은 지식처럼 쓰인다). 마지막으로 꺼내 쓴 때(used_ms, 없으면 만든 때)가 가장 오래된 것부터
// 쉴 때 조금씩 잊고(숨김), 잊은 지 30일이 지나면 지운다. 잊은 기억은 목록·자동 떠올리기에 안 나오고, 기억 검색 도구로 직접 찾아
// 꺼내 쓰면 되살아난다(사람처럼 떠오른다). 다시 저장해도 되살아난다.

/// 만든 때(ms) — created_at 은 동기화로 기기끼리 같다
const CREATED_MS: &str = "CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER)";
/// 쓴 때를 다시 찍는 간격. 순서만 맞으면 되니 꺼낼 때마다 찍지 않는다 — 찍을 때마다 동기화 기록이 올라간다
const TOUCH_EVERY_MS: i64 = 6 * 3_600_000;
/// 잊은 기억을 지우는 때
pub const FORGET_KEEP_MS: i64 = 30 * 86_400_000;
const DAY_MS: i64 = 86_400_000;

fn used_eff() -> String {
    format!("MAX(used_ms, {CREATED_MS})")
}
/// 보이는(안 잊은) 기억
fn remembered() -> String {
    format!("forgot_ms <= {}", used_eff())
}
fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Memory {
    pub id: i64,
    pub kind: String,
    pub content: String,
    pub created_at: String,
    pub use_count: i64,
}

/// 저장한다. 같은 내용이 이미 있으면 새로 만들지 않고 그것을 돌려준다 —
/// 모델은 같은 사실을 여러 번 저장하려 든다.
pub fn save(conn: &Connection, kind: &str, content: &str) -> AppResult<Memory> {
    let content = content.trim();
    // 같은 것을 다시 알게 됐으면 최근으로. 잊은 것이면 잊은 때보다 뒤로 찍어 꼭 되살린다(다른 기기 시계가 앞서 있어도)
    conn.execute(
        "INSERT INTO memories (kind, content) VALUES (?1, ?2)
         ON CONFLICT(content) DO UPDATE SET kind = excluded.kind, used_ms = MAX(used_ms, ?3, forgot_ms + 1)",
        params![kind, content, now_ms()],
    )?;
    prune(conn)?;
    get_by_content(conn, content)
}

fn get_by_content(conn: &Connection, content: &str) -> AppResult<Memory> {
    Ok(conn.query_row(
        "SELECT id, kind, content, created_at, use_count FROM memories WHERE content = ?1",
        params![content],
        row_to_memory,
    )?)
}

fn row_to_memory(row: &rusqlite::Row) -> rusqlite::Result<Memory> {
    Ok(Memory {
        id: row.get(0)?,
        kind: row.get(1)?,
        content: row.get(2)?,
        created_at: row.get(3)?,
        use_count: row.get(4)?,
    })
}

/// 최근 것부터 보이는(안 잊은) 기억 전부. 설정 화면에서 보고 지우는 용도이고, 생각하기·산책의 재료도 여기서 온다.
///
/// `created_at` 만으로 정렬하면 안 된다 — `datetime('now')` 는 초 단위라 같은 초에
/// 저장된 것들의 순서가 뒤집힌다. id 를 보조 키로 둬야 안정적이다.
pub fn list(conn: &Connection) -> AppResult<Vec<Memory>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT id, kind, content, created_at, use_count FROM memories WHERE {}
         ORDER BY created_at DESC, id DESC",
        remembered()
    ))?;
    let rows = stmt.query_map([], row_to_memory)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn delete(conn: &Connection, id: i64) -> AppResult<bool> {
    Ok(conn.execute("DELETE FROM memories WHERE id = ?1", params![id])? > 0)
}

/// 검색어들 중 **하나라도** 포함하는 기억을, 많이 맞은 순으로.
///
/// 점수는 맞은 검색어 수다. 동점이면 자주 쓰인 것, 그 다음 최근 것을 앞세운다 —
/// 실제로 도움이 됐던 기억이 다시 도움이 될 가능성이 높다.
///
/// 산책 기억(`neko`)은 빼고 찾는다. 네코가 혼자 웹에서 보고 온 것이라, 대화 컨텍스트로 떠오르면
/// 남의 페이지에 심긴 지시가 본 대화에 섞인다. 산책(목록으로 읽음)과 설정 화면에서만 쓴다.
///
/// 잊은 기억은 forgotten 일 때만(기억 검색 도구 — 모델이 직접 찾을 때) 찾는다. 자동 떠올리기엔 안 나온다.
pub fn search(conn: &Connection, terms: &[String], limit: usize, forgotten: bool) -> AppResult<Vec<Memory>> {
    if terms.is_empty() {
        return Ok(Vec::new());
    }

    // LIKE 절과 점수 계산을 검색어 개수만큼 동적으로 만든다.
    let where_clause = terms
        .iter()
        .map(|_| "content LIKE ?")
        .collect::<Vec<_>>()
        .join(" OR ");
    let score_clause = terms
        .iter()
        .map(|_| "(content LIKE ?)")
        .collect::<Vec<_>>()
        .join(" + ");

    let hide = if forgotten { String::new() } else { format!(" AND {}", remembered()) };
    let sql = format!(
        "SELECT id, kind, content, created_at, use_count FROM memories
         WHERE kind != 'neko' AND ({where_clause}){hide}
         ORDER BY ({score_clause}) DESC, use_count DESC, id DESC
         LIMIT ?"
    );

    // LIKE 패턴을 두 번(WHERE 절, 점수 절) 넘긴 뒤 마지막에 limit.
    let patterns: Vec<String> = terms.iter().map(|t| format!("%{}%", escape_like(t))).collect();
    let mut values: Vec<&dyn rusqlite::ToSql> = Vec::new();
    for p in &patterns {
        values.push(p);
    }
    for p in &patterns {
        values.push(p);
    }
    let limit = limit as i64;
    values.push(&limit);

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(values.as_slice(), row_to_memory)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// 실제로 떠올려 쓴 기억에 표시한다. 다음 검색에서 우선순위가 올라가고, 마지막으로 쓴 때가 지금이 된다(잊는 순서가 뒤로 밀린다).
/// 쓴 때는 TOUCH_EVERY_MS 에 한 번만 찍는다. 잊은 기억이면 바로 찍어 되살린다.
pub fn mark_used(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    mark_used_at(conn, ids, now_ms())
}

pub(crate) fn mark_used_at(conn: &Connection, ids: &[i64], now: i64) -> AppResult<()> {
    let sql = format!(
        "UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now'),
             used_ms = CASE WHEN {u} < ?2 - ?3 OR forgot_ms > {u} THEN MAX(?2, forgot_ms + 1) ELSE used_ms END
         WHERE id = ?1",
        u = used_eff()
    );
    for id in ids {
        conn.execute(&sql, params![id, now, TOUCH_EVERY_MS])?;
    }
    Ok(())
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct ForgetOut {
    /// 이번에 잊은 수
    pub forgot: usize,
    /// 잊은 지 30일이 지나 지운 수
    pub purged: usize,
    /// 남은 보이는 기억 수
    pub visible: usize,
}

/// 쉴 때 한 번: 잊은 지 30일 지난 것을 지우고, 보이는 기억이 cap 을 넘으면 마지막으로 쓴 때가 가장 오래된 것부터 잊는다 —
/// 지난 하루(24시간) 동안 잊은 것과 합쳐 per_day 개까지. 순서는 쓴 때 → 만든 때 → 내용(동기화로 기기끼리 같은 값만 본다)
pub fn forget(conn: &Connection, cap: usize, per_day: usize) -> AppResult<ForgetOut> {
    forget_at(conn, cap, per_day, now_ms())
}

pub(crate) fn forget_at(conn: &Connection, cap: usize, per_day: usize, now: i64) -> AppResult<ForgetOut> {
    let u = used_eff();
    let purged = conn.execute(&format!("DELETE FROM memories WHERE forgot_ms > {u} AND forgot_ms <= ?1"), params![now - FORGET_KEEP_MS])?;
    let visible: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM memories WHERE {}", remembered()), [], |r| r.get(0))?;
    let today: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM memories WHERE forgot_ms > {u} AND forgot_ms > ?1"), params![now - DAY_MS], |r| r.get(0))?;
    let n = (visible - cap as i64).min(per_day as i64 - today).max(0);
    let forgot = if n > 0 {
        conn.execute(
            &format!(
                "UPDATE memories SET forgot_ms = MAX(?1, {u} + 1) WHERE id IN (
                     SELECT id FROM memories WHERE {r} ORDER BY {u} ASC, created_at ASC, content ASC LIMIT ?2)",
                r = remembered()
            ),
            params![now, n],
        )?
    } else {
        0
    };
    Ok(ForgetOut { forgot, purged, visible: (visible as usize).saturating_sub(forgot) })
}

/// 상한(안전선)을 넘으면 잊은 것부터, 그다음 마지막으로 쓴 때가 오래된 것부터 지운다.
fn prune(conn: &Connection) -> AppResult<()> {
    conn.execute(
        &format!(
            "DELETE FROM memories WHERE id IN (
                SELECT id FROM memories
                ORDER BY ({r}) ASC, {u} ASC, id ASC
                LIMIT MAX(0, (SELECT COUNT(*) FROM memories) - ?1)
             )",
            r = remembered(),
            u = used_eff()
        ),
        params![MAX_MEMORIES as i64],
    )?;
    Ok(())
}

/// LIKE 의 와일드카드를 리터럴로 만든다. 검색어에 % 나 _ 가 있으면 전부 매칭된다.
fn escape_like(term: &str) -> String {
    term.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&c).unwrap();
        c
    }

    fn terms(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn save_then_search_roundtrip() {
        let c = setup();
        save(&c, "fact", "사용자는 고양이를 키운다").unwrap();

        let found = search(&c, &terms(&["고양이"]), 5, false).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].content, "사용자는 고양이를 키운다");
    }

    #[test]
    fn walk_memories_never_surface_in_search() {
        let c = setup();
        save(&c, "neko", "산책하다 알게 됨: 고양이는 하루 16시간 잔다").unwrap();
        save(&c, "fact", "사용자는 고양이를 키운다").unwrap();
        let found = search(&c, &terms(&["고양이"]), 5, false).unwrap();
        assert_eq!(found.iter().map(|m| m.kind.as_str()).collect::<Vec<_>>(), ["fact"]);
        assert_eq!(list(&c).unwrap().len(), 2);
    }

    #[test]
    fn finds_two_syllable_korean_words_that_fts5_misses() {
        // trigram 토크나이저가 놓치는 2음절 단어. 이게 LIKE 를 쓰는 이유다.
        let c = setup();
        save(&c, "fact", "매일 아침에 사료를 준다").unwrap();
        assert_eq!(search(&c, &terms(&["사료"]), 5, false).unwrap().len(), 1);
        assert_eq!(search(&c, &terms(&["일정"]), 5, false).unwrap().len(), 0);
    }

    #[test]
    fn ranks_by_how_many_terms_matched() {
        let c = setup();
        save(&c, "fact", "고양이 이름은 네코").unwrap();
        save(&c, "fact", "고양이는 참치를 좋아한다").unwrap();
        save(&c, "fact", "참치는 비싸다").unwrap();

        let found = search(&c, &terms(&["고양이", "참치"]), 5, false).unwrap();
        // 둘 다 맞은 기억이 맨 앞.
        assert_eq!(found[0].content, "고양이는 참치를 좋아한다");
        assert_eq!(found.len(), 3);
    }

    #[test]
    fn ties_break_toward_memories_that_proved_useful() {
        let c = setup();
        let a = save(&c, "fact", "커피를 좋아한다").unwrap();
        save(&c, "fact", "커피는 오후에만").unwrap();
        mark_used(&c, &[a.id]).unwrap();

        let found = search(&c, &terms(&["커피"]), 5, false).unwrap();
        assert_eq!(found[0].id, a.id);
    }

    #[test]
    fn saving_the_same_fact_twice_does_not_duplicate_it() {
        let c = setup();
        let first = save(&c, "fact", "생일은 3월 2일").unwrap();
        let second = save(&c, "preference", "생일은 3월 2일").unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(list(&c).unwrap().len(), 1);
        // kind 는 최신 것으로 갱신된다.
        assert_eq!(second.kind, "preference");
    }

    #[test]
    fn empty_terms_return_nothing_rather_than_everything() {
        let c = setup();
        save(&c, "fact", "무언가").unwrap();
        assert!(search(&c, &[], 5, false).unwrap().is_empty());
    }

    #[test]
    fn like_wildcards_in_a_query_are_literal() {
        let c = setup();
        save(&c, "fact", "정상적인 기억").unwrap();
        // 이스케이프를 안 하면 "%" 가 전부를 매칭한다.
        assert!(search(&c, &terms(&["%"]), 5, false).unwrap().is_empty());
        assert!(search(&c, &terms(&["_"]), 5, false).unwrap().is_empty());
    }

    #[test]
    fn respects_the_limit() {
        let c = setup();
        for i in 0..10 {
            save(&c, "fact", &format!("고양이 사실 {i}")).unwrap();
        }
        assert_eq!(search(&c, &terms(&["고양이"]), 3, false).unwrap().len(), 3);
    }

    #[test]
    fn delete_removes_it() {
        let c = setup();
        let m = save(&c, "fact", "지울 기억").unwrap();
        assert!(delete(&c, m.id).unwrap());
        assert!(!delete(&c, m.id).unwrap());
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn list_is_newest_first() {
        let c = setup();
        save(&c, "fact", "먼저").unwrap();
        save(&c, "fact", "나중").unwrap();
        assert_eq!(list(&c).unwrap()[0].content, "나중");
    }

    // ── 잊기(0.1.29) ──

    const DAY: i64 = 86_400_000;
    /// 기준 시각: 2026-11-23 00:00 UTC
    const T: i64 = 1_795_392_000_000;

    /// 만든 날을 T 기준 며칠 전으로 박아 넣는다(datetime('now') 는 같은 초라 순서가 안 선다)
    fn made(c: &Connection, content: &str, days_ago: i64) -> i64 {
        let m = save(c, "fact", content).unwrap();
        c.execute(
            "UPDATE memories SET created_at = datetime(?2 / 1000, 'unixepoch'), used_ms = 0 WHERE id = ?1",
            params![m.id, T - days_ago * DAY],
        ).unwrap();
        m.id
    }
    fn shown(c: &Connection) -> Vec<String> {
        let mut v: Vec<String> = list(c).unwrap().into_iter().map(|m| m.content).collect();
        v.sort();
        v
    }

    #[test]
    fn forgets_the_longest_unused_first_and_using_pushes_it_back() {
        let c = setup();
        let a = made(&c, "가", 60);
        for (x, d) in [("나", 50), ("다", 40), ("라", 30), ("마", 20), ("바", 10)] {
            made(&c, x, d);
        }
        // 가장 오래된 '가'를 꺼내 썼다 → 최근으로
        mark_used_at(&c, &[a], T).unwrap();
        let out = forget_at(&c, 3, 5, T).unwrap();
        assert_eq!(out, ForgetOut { forgot: 3, purged: 0, visible: 3 });
        assert_eq!(shown(&c), ["가", "마", "바"]);
    }

    #[test]
    fn at_most_five_a_day_and_none_under_the_cap() {
        let c = setup();
        for i in 0..20 {
            made(&c, &format!("기억 {i:02}"), 100 - i);
        }
        assert_eq!(forget_at(&c, 10, 5, T).unwrap().forgot, 5);
        assert_eq!(forget_at(&c, 10, 5, T + 3_600_000).unwrap().forgot, 0, "같은 날엔 더 안 잊는다");
        assert_eq!(forget_at(&c, 10, 5, T + DAY + 1).unwrap().forgot, 5);
        assert_eq!(forget_at(&c, 10, 5, T + 2 * DAY + 2).unwrap(), ForgetOut { forgot: 0, purged: 0, visible: 10 }, "상한 안이면 안 잊는다");
        assert_eq!(list(&c).unwrap().len(), 10);
    }

    #[test]
    fn forgotten_ones_are_hidden_then_deleted_after_30_days() {
        let c = setup();
        made(&c, "오래된 것", 90);
        made(&c, "새 것", 1);
        assert_eq!(forget_at(&c, 1, 5, T).unwrap().forgot, 1);
        assert_eq!(shown(&c), ["새 것"]);
        let all: i64 = c.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0)).unwrap();
        assert_eq!(all, 2, "잊은 것은 숨겼을 뿐 아직 있다");
        assert_eq!(forget_at(&c, 1, 5, T + FORGET_KEEP_MS - 1).unwrap().purged, 0);
        assert_eq!(forget_at(&c, 1, 5, T + FORGET_KEEP_MS).unwrap().purged, 1);
        let all: i64 = c.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0)).unwrap();
        assert_eq!(all, 1);
    }

    #[test]
    fn a_forgotten_memory_comes_back_when_searched_and_used_or_learned_again() {
        let c = setup();
        made(&c, "사용자는 참치를 좋아한다", 90);
        made(&c, "사용자는 산책을 좋아한다", 1);
        forget_at(&c, 1, 5, T).unwrap();
        // 자동 떠올리기엔 안 나오고, 기억 검색 도구(forgotten)는 찾는다
        assert!(search(&c, &terms(&["참치"]), 5, false).unwrap().is_empty());
        let found = search(&c, &terms(&["참치"]), 5, true).unwrap();
        assert_eq!(found.len(), 1);
        // 찾아 쓰면(명령이 mark_used) 되살아난다 — 잊은 지 몇 분 안이어도
        mark_used_at(&c, &[found[0].id], T + 60_000).unwrap();
        assert_eq!(shown(&c).len(), 2);
        // 다시 잊혀도 같은 것을 다시 알게 되면(저장) 되살아난다
        forget_at(&c, 1, 5, T + 2 * DAY).unwrap();
        assert_eq!(shown(&c).len(), 1);
        save(&c, "fact", shown_missing(&c, &["사용자는 참치를 좋아한다", "사용자는 산책을 좋아한다"])).unwrap();
        assert_eq!(shown(&c).len(), 2);
    }
    fn shown_missing<'a>(c: &Connection, all: &[&'a str]) -> &'a str {
        let s = shown(c);
        all.iter().find(|x| !s.contains(&x.to_string())).unwrap()
    }

    #[test]
    fn using_again_within_hours_does_not_stamp_again() {
        let c = setup();
        let a = made(&c, "가", 10);
        mark_used_at(&c, &[a], T).unwrap();
        mark_used_at(&c, &[a], T + 3_600_000).unwrap();
        let used: i64 = c.query_row("SELECT used_ms FROM memories WHERE id = ?1", [a], |r| r.get(0)).unwrap();
        assert_eq!(used, T, "6시간 안엔 다시 안 찍는다(찍을 때마다 동기화 기록이 올라간다)");
        mark_used_at(&c, &[a], T + 7 * 3_600_000).unwrap();
        let used: i64 = c.query_row("SELECT used_ms FROM memories WHERE id = ?1", [a], |r| r.get(0)).unwrap();
        assert_eq!(used, T + 7 * 3_600_000);
    }
}
