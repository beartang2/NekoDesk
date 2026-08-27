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

/// 저장 상한. 넘으면 가장 안 쓰이고 오래된 것부터 지운다.
const MAX_MEMORIES: usize = 500;

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
    conn.execute(
        "INSERT INTO memories (kind, content) VALUES (?1, ?2)
         ON CONFLICT(content) DO UPDATE SET kind = excluded.kind",
        params![kind, content],
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

/// 최근 것부터 전부. 설정 화면에서 보고 지우는 용도.
///
/// `created_at` 만으로 정렬하면 안 된다 — `datetime('now')` 는 초 단위라 같은 초에
/// 저장된 것들의 순서가 뒤집힌다. id 를 보조 키로 둬야 안정적이다.
pub fn list(conn: &Connection) -> AppResult<Vec<Memory>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, content, created_at, use_count FROM memories
         ORDER BY created_at DESC, id DESC",
    )?;
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
pub fn search(conn: &Connection, terms: &[String], limit: usize) -> AppResult<Vec<Memory>> {
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

    let sql = format!(
        "SELECT id, kind, content, created_at, use_count FROM memories
         WHERE {where_clause}
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

/// 실제로 떠올려 쓴 기억에 표시한다. 다음 검색에서 우선순위가 올라간다.
pub fn mark_used(conn: &Connection, ids: &[i64]) -> AppResult<()> {
    for id in ids {
        conn.execute(
            "UPDATE memories SET use_count = use_count + 1, last_used_at = datetime('now')
             WHERE id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

/// 상한을 넘으면 안 쓰이고 오래된 것부터 지운다.
fn prune(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "DELETE FROM memories WHERE id IN (
            SELECT id FROM memories
            ORDER BY use_count ASC, id ASC
            LIMIT MAX(0, (SELECT COUNT(*) FROM memories) - ?1)
         )",
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

        let found = search(&c, &terms(&["고양이"]), 5).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].content, "사용자는 고양이를 키운다");
    }

    #[test]
    fn finds_two_syllable_korean_words_that_fts5_misses() {
        // trigram 토크나이저가 놓치는 2음절 단어. 이게 LIKE 를 쓰는 이유다.
        let c = setup();
        save(&c, "fact", "매일 아침에 사료를 준다").unwrap();
        assert_eq!(search(&c, &terms(&["사료"]), 5).unwrap().len(), 1);
        assert_eq!(search(&c, &terms(&["일정"]), 5).unwrap().len(), 0);
    }

    #[test]
    fn ranks_by_how_many_terms_matched() {
        let c = setup();
        save(&c, "fact", "고양이 이름은 네코").unwrap();
        save(&c, "fact", "고양이는 참치를 좋아한다").unwrap();
        save(&c, "fact", "참치는 비싸다").unwrap();

        let found = search(&c, &terms(&["고양이", "참치"]), 5).unwrap();
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

        let found = search(&c, &terms(&["커피"]), 5).unwrap();
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
        assert!(search(&c, &[], 5).unwrap().is_empty());
    }

    #[test]
    fn like_wildcards_in_a_query_are_literal() {
        let c = setup();
        save(&c, "fact", "정상적인 기억").unwrap();
        // 이스케이프를 안 하면 "%" 가 전부를 매칭한다.
        assert!(search(&c, &terms(&["%"]), 5).unwrap().is_empty());
        assert!(search(&c, &terms(&["_"]), 5).unwrap().is_empty());
    }

    #[test]
    fn respects_the_limit() {
        let c = setup();
        for i in 0..10 {
            save(&c, "fact", &format!("고양이 사실 {i}")).unwrap();
        }
        assert_eq!(search(&c, &terms(&["고양이"]), 3).unwrap().len(), 3);
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
}
