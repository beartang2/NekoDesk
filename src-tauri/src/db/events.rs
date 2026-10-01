//! events 테이블 접근 (일정). 순수 함수 → 인메모리 DB로 단위 테스트 가능.

use crate::db::models::ScheduleEvent;
use crate::error::AppResult;
use rusqlite::{params, Connection};

const COLS: &str = "id, title, start_at, end_at, notes, all_day, created_at";

/// 조회 범위. 문자열 파싱을 한 곳에 모은다.
pub enum Range {
    Today,
    Week,
    All,
}

impl Range {
    pub fn parse(s: &str) -> Range {
        match s {
            "today" => Range::Today,
            "week" => Range::Week,
            _ => Range::All,
        }
    }
}

/// 여러 날에 걸친 일정(`end_at` 이 있는 것)은 시작한 날이 아니라 걸친 기간으로 본다.
/// 월~수 여행이면 화요일의 "오늘 일정" 에도 나와야 한다.
pub fn list(conn: &Connection, range: Range) -> AppResult<Vec<ScheduleEvent>> {
    let sql = match range {
        Range::Today => format!(
            "SELECT {COLS} FROM events
             WHERE date(start_at) <= date('now') AND date(COALESCE(end_at, start_at)) >= date('now')
             ORDER BY start_at ASC LIMIT 20"
        ),
        // 하루짜리는 예전처럼 아직 안 지난 것만. 여러 날짜는 마지막 날이 안 지났으면 진행 중이다.
        Range::Week => format!(
            "SELECT {COLS} FROM events
             WHERE (CASE WHEN end_at IS NULL THEN start_at >= datetime('now')
                         ELSE date(end_at) >= date('now') END)
               AND date(start_at) <= date('now', '+7 days')
             ORDER BY start_at ASC LIMIT 20"
        ),
        Range::All => format!("SELECT {COLS} FROM events ORDER BY start_at ASC LIMIT 200"),
    };
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| ScheduleEvent::try_from(r))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn add(
    conn: &Connection,
    title: &str,
    start_at: &str,
    end_at: Option<&str>,
) -> AppResult<ScheduleEvent> {
    conn.execute(
        "INSERT INTO events (title, start_at, end_at) VALUES (?1, ?2, ?3)",
        params![title, start_at, end_at],
    )?;
    let id = conn.last_insert_rowid();
    let sql = format!("SELECT {COLS} FROM events WHERE id = ?1");
    Ok(conn.query_row(&sql, params![id], |r| ScheduleEvent::try_from(r))?)
}

/// id 여러 개를 한 번에 삭제. 실제로 지워진 개수를 반환.
pub fn delete(conn: &Connection, ids: &[i64]) -> AppResult<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let placeholders = ids
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("DELETE FROM events WHERE id IN ({placeholders})");
    let bound: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    Ok(conn.execute(&sql, bound.as_slice())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&c).unwrap();
        c
    }

    #[test]
    fn add_maps_all_day_bool() {
        let c = setup();
        let ev = add(&c, "회의 🗓", "2026-07-11 14:00", None).unwrap();
        assert_eq!(ev.title, "회의 🗓");
        assert!(!ev.all_day); // 정수 0 → false 로 매핑
    }

    #[test]
    fn delete_empty_is_noop() {
        let c = setup();
        assert_eq!(delete(&c, &[]).unwrap(), 0);
    }

    #[test]
    fn delete_removes_only_given_ids() {
        let c = setup();
        let a = add(&c, "A", "2026-07-11 10:00", None).unwrap();
        let b = add(&c, "B", "2026-07-11 11:00", None).unwrap();
        add(&c, "C", "2026-07-11 12:00", None).unwrap();
        assert_eq!(delete(&c, &[a.id, b.id]).unwrap(), 2);
        let rest = list(&c, Range::All).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].title, "C");
    }

    #[test]
    fn multi_day_event_shows_on_every_day_it_covers() {
        let c = setup();
        let day = |offset: &str| -> String {
            c.query_row(&format!("SELECT date('now', '{offset}')"), [], |r| r.get(0)).unwrap()
        };
        // 어제 시작해 내일 끝나는 여행 — 오늘은 둘째 날이다.
        add(&c, "여행", &day("-1 day"), Some(&day("+1 day"))).unwrap();
        // 어제로 끝난 하루짜리는 오늘 목록에 없어야 한다.
        add(&c, "어제 회의", &day("-1 day"), None).unwrap();

        let today = list(&c, Range::Today).unwrap();
        assert_eq!(today.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(), ["여행"]);
        let week = list(&c, Range::Week).unwrap();
        assert_eq!(week.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(), ["여행"]);
    }

    #[test]
    fn list_all_orders_by_start() {
        let c = setup();
        add(&c, "늦음", "2026-07-11 18:00", None).unwrap();
        add(&c, "이름", "2026-07-11 09:00", None).unwrap();
        let all = list(&c, Range::All).unwrap();
        assert_eq!(all[0].title, "이름");
    }
}
