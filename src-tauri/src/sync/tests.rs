//! 동기화 엔진 테스트. 위쪽은 메모리 DB 두 개를 서버 없이 주고받게 하고, 맨 아래 live 는 `wrangler dev`
//! (server/)에 대고 기기 둘을 흉내 낸다 — 손으로: cd server && npm run migrate:local && npm run dev, 그리고
//! cargo test --lib sync::tests::live -- --ignored --nocapture

use super::*;
use crate::db::{conversations, memories, settings, todos};

const KEY: Key = [42u8; 32];

fn db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    crate::db::init_schema(&c).unwrap();
    c
}

/// 서버 흉내: 안 올린 것을 다 모아 "받아들여졌다"고 적고 돌려준다
fn push_all(c: &Connection, me: &str) -> Vec<Record> {
    let mut all = Vec::new();
    loop {
        let batch = collect(c, me, &KEY).unwrap();
        if batch.is_empty() {
            return all;
        }
        for r in &batch {
            c.execute("UPDATE sync_meta SET dirty = 0, device = ?3 WHERE coll = ?1 AND uid = ?2 AND ts = ?4", params![r.coll, r.id, me, r.ts]).unwrap();
        }
        all.extend(batch);
    }
}

fn apply_all(c: &Connection, me: &str, recs: &[Record]) -> Changes {
    let mut ch = Changes::default();
    for r in recs {
        apply(c, me, &KEY, r, &mut ch).unwrap();
    }
    ch
}

fn dirty(c: &Connection) -> i64 {
    c.query_row("SELECT count(*) FROM sync_meta WHERE dirty = 1", [], |r| r.get(0)).unwrap()
}

fn titles(c: &Connection) -> Vec<String> {
    session_list(c).unwrap().into_iter().map(|s| s.title).collect()
}

#[test]
fn seal_round_trips_and_aad_binds_the_header() {
    let r = Record { coll: "msg".into(), id: "u1".into(), parent: Some("s1".into()), ts: 5, device: "A".into(), deleted: 0, cut: None, blob: None };
    let blob = seal(&KEY, &r, "비밀 대화".as_bytes()).unwrap();
    assert!(!blob.contains("비밀"));
    let sealed = Record { blob: Some(blob), ..r };
    assert_eq!(unseal(&KEY, &sealed).unwrap(), "비밀 대화".as_bytes());
    // 서버가 머리를 바꾸거나 다른 기록에 끼우면 풀리지 않는다
    for bad in [
        Record { id: "u2".into(), ..sealed.clone() },
        Record { parent: Some("s2".into()), ..sealed.clone() },
        Record { ts: 6, ..sealed.clone() },
        Record { device: "B".into(), ..sealed.clone() },
        Record { coll: "memory".into(), ..sealed.clone() },
    ] {
        assert!(unseal(&KEY, &bad).is_err());
    }
    assert!(unseal(&[1u8; 32], &sealed).is_err(), "다른 열쇠");
}

#[test]
fn existing_data_is_marked_for_upload_by_the_migration() {
    // 마이그레이션 3 까지 있던 설치에 데이터가 있다
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch("PRAGMA user_version = 0").unwrap();
    crate::db::run_migrations(&c, &crate::db::MIGRATIONS[..3]).unwrap();
    conversations::save(&c, "s1", "user", "안녕", None, None).unwrap();
    memories::save(&c, "fact", "고양이를 키운다").unwrap();
    settings::set(&c, "neko_appearance", "{}").unwrap();
    settings::set(&c, "neko_stage", "{}").unwrap(); // 기기 전용
    crate::db::init_schema(&c).unwrap();
    let colls: Vec<String> = push_all(&c, "A").into_iter().map(|r| r.coll).collect();
    assert_eq!(colls, ["memory", "setting", "msg"]);
}

#[test]
fn migration_4_survives_odd_dates_and_rolls_back_if_cut_off() {
    // 배포본 첫 실행: 3 까지 있는 실제 모양 DB. 시각이 이상한 행도 있다
    let c = Connection::open_in_memory().unwrap();
    crate::db::run_migrations(&c, &crate::db::MIGRATIONS[..3]).unwrap();
    conversations::save(&c, "s1", "user", "안녕", None, None).unwrap();
    c.execute("INSERT INTO memories (kind, content, created_at) VALUES ('fact', '이상한 시각', '어제쯤')", []).unwrap();
    // 4 를 적용하다 앱이 꺼진 셈(같은 트랜잭션 안에서 실패) → 3 에 그대로 남고 데이터도 그대로
    let broken = format!("{} THIS IS NOT SQL;", crate::db::MIGRATIONS[3]);
    let steps: Vec<&str> = crate::db::MIGRATIONS[..3].iter().copied().chain([broken.as_str()]).collect();
    assert!(crate::db::run_migrations(&c, &steps).is_err());
    assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
    assert_eq!(c.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('sync_meta', 'sessions')", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    // 다시 켜면 이어서 된다
    crate::db::init_schema(&c).unwrap();
    assert_eq!(conversations::load(&c, "s1").unwrap()[0].content, "안녕");
    let up = push_all(&c, "A");
    assert_eq!(up.len(), 2, "이상한 시각의 기억도 지금 시각으로 올라간다");
    assert!(up.iter().all(|r| r.ts > 0));
    // 세션 옮기기는 여러 번 불려도 안전하다(중간에 꺼졌다 다시)
    let rows = vec![SessionRow { id: "s1".into(), title: "옛 대화".into(), created_at: 1, summary: Some("요약".into()), unread: false }];
    session_import(&c, &rows[..0]).unwrap();
    session_import(&c, &rows).unwrap();
    session_import(&c, &rows).unwrap();
    assert_eq!(session_list(&c).unwrap(), rows);
}

#[test]
fn a_reply_after_the_last_read_marks_the_session_and_stays_on_this_device() {
    let (a, b) = (db(), db());
    let unread = |c: &Connection| session_list(c).unwrap().into_iter().map(|s| (s.id, s.unread)).collect::<Vec<_>>();
    session_put(&a, "s", "s", 1).unwrap();
    conversations::save(&a, "s", "user", "질문", None, None).unwrap();
    assert_eq!(unread(&a), [("s".into(), false)], "내 말만으로는 새 답이 아니다");
    conversations::save(&a, "s", "assistant", "답", None, None).unwrap();
    assert_eq!(unread(&a), [("s".into(), true)]);
    // 다른 기기에서 온 세션도 열기 전엔 새 답
    apply_all(&b, "B", &push_all(&a, "A"));
    assert_eq!(unread(&b), [("s".into(), true)]);
    // 읽음은 이 기기에만: 올릴 거리가 생기지 않고, 받은 기록이 지우지도 않는다
    session_read(&a, "s", now_ms()).unwrap();
    assert_eq!(unread(&a), [("s".into(), false)]);
    assert_eq!(dirty(&a), 0);
    session_put(&b, "s", "새 제목", 1).unwrap();
    apply_all(&a, "A", &push_all(&b, "B"));
    assert_eq!(session_list(&a).unwrap()[0].title, "새 제목");
    assert_eq!(unread(&a), [("s".into(), false)]);
    // 더 이른 시각으로 되돌리지 않는다
    session_read(&a, "s", 0).unwrap();
    assert_eq!(unread(&a), [("s".into(), false)]);
}

#[test]
fn received_messages_are_trimmed_to_the_session_cap_newest_kept() {
    let (a, b) = (db(), db());
    session_put(&a, "s", "s", 1).unwrap();
    // A 는 저장할 때 자르니 직접 넣어 서버에 5003 개가 있는 셈으로
    for i in 0..5003 {
        a.execute("INSERT INTO conversation_messages (session_id, role, content) VALUES ('s', 'user', ?1)", [format!("m{i}")]).unwrap();
    }
    let recs = push_all(&a, "A");
    let mut got = Changes::default();
    for r in &recs {
        apply(&b, "B", &KEY, r, &mut got).unwrap();
    }
    for id in &got.sessions {
        conversations::trim(&b, id).unwrap();
    }
    let msgs = conversations::load(&b, "s").unwrap();
    assert_eq!(msgs.len(), 5000);
    assert_eq!((msgs[0].content.as_str(), msgs.last().unwrap().content.as_str()), ("m3", "m5002"));
}

#[test]
fn device_b_gets_what_device_a_wrote_without_echo() {
    let (a, b) = (db(), db());
    session_put(&a, "s1", "고양이 얘기", 1000).unwrap();
    conversations::save(&a, "s1", "user", "안녕", Some(r#"[{"name":"x.png"}]"#), None).unwrap();
    conversations::save(&a, "s1", "assistant", "냐옹", None, Some(r#"{"steps":[]}"#)).unwrap();
    memories::save(&a, "fact", "참치를 좋아한다").unwrap();
    todos::add(&a, "우유 사기", Some("2026-12-01")).unwrap();
    crate::db::events::add(&a, "병원", "2026-12-02 10:00", None).unwrap();
    settings::set(&a, "neko_name", "나비").unwrap();
    settings::set(&a, "neko_stage", "맥 화면에 묶인 값").unwrap();
    for i in 0..25 {
        conversations::save(&a, "s1", "user", &format!("m{i}"), None, None).unwrap();
    }

    let recs = push_all(&a, "A");
    assert!(recs.iter().all(|r| r.device == "A" && r.blob.is_some()));
    assert!(recs.iter().all(|r| !r.blob.as_deref().unwrap().contains("냐옹")));
    assert!(!recs.iter().any(|r| r.id == "neko_stage"), "기기 전용 설정은 안 올린다");
    let first_msg = recs.iter().position(|r| r.coll == "msg").unwrap();
    assert!(recs[..first_msg].iter().any(|r| r.coll == "session"), "세션이 메시지보다 먼저");

    let ch = apply_all(&b, "B", &recs);
    assert!(ch.sessions.contains("s1"));
    assert_eq!(titles(&b), ["고양이 얘기"]);
    let msgs = conversations::load(&b, "s1").unwrap();
    assert_eq!(msgs.len(), 27);
    assert_eq!((msgs[0].content.as_str(), msgs[0].attachments.as_deref()), ("안녕", Some(r#"[{"name":"x.png"}]"#)));
    assert_eq!(msgs[1].meta.as_deref(), Some(r#"{"steps":[]}"#));
    assert_eq!(memories::list(&b).unwrap()[0].content, "참치를 좋아한다");
    assert_eq!(todos::list_open(&b).unwrap()[0].due_at.as_deref(), Some("2026-12-01"));
    assert_eq!(settings::get(&b, "neko_name").unwrap().as_deref(), Some("나비"));
    assert_eq!(settings::get(&b, "neko_stage").unwrap(), None);
    assert_eq!(dirty(&b), 0, "받은 것을 다시 올리지 않는다");

    // 같은 걸 또 받아도 그대로
    apply_all(&b, "B", &recs);
    assert_eq!(conversations::load(&b, "s1").unwrap().len(), 27);

    // B 가 이어 말하면 A 에 간다
    conversations::save(&b, "s1", "user", "B 에서 한 말", None, None).unwrap();
    let back = push_all(&b, "B");
    assert_eq!(back.len(), 1);
    apply_all(&a, "A", &back);
    assert_eq!(conversations::load(&a, "s1").unwrap().last().unwrap().content, "B 에서 한 말");
}

#[test]
fn todo_edits_reopens_and_deletes_reach_the_other_device() {
    let (a, b) = (db(), db());
    let t = todos::add(&a, "우유", Some("2026-12-01")).unwrap();
    apply_all(&b, "B", &push_all(&a, "A"));
    let id_b = todos::list_open(&b).unwrap()[0].id;

    // 고친 내용·지운 마감
    todos::update(&a, t.id, Some("두유"), None, true).unwrap();
    apply_all(&b, "B", &push_all(&a, "A"));
    let got = &todos::list_open(&b).unwrap()[0];
    assert_eq!((got.content.as_str(), got.due_at.as_deref()), ("두유", None));

    // 완료 → 되돌리기: 같은 기록 하나라 옛 기기도 그대로 받는다(열림, 완료 시각 없음)
    todos::complete(&a, t.id).unwrap();
    todos::reopen(&a, t.id).unwrap();
    apply_all(&b, "B", &push_all(&a, "A"));
    assert_eq!(todos::list_open(&b).unwrap()[0].completed_at, None);

    // B 에서 지우면 지움 표시로 A 에서도 지워진다
    todos::delete(&b, &[id_b]).unwrap();
    let tomb = push_all(&b, "B");
    assert!(tomb.iter().all(|r| r.coll == "todo" && r.deleted == 1 && r.blob.is_none()));
    apply_all(&a, "A", &tomb);
    assert!(todos::list_open(&a).unwrap().is_empty());
    assert_eq!(dirty(&a), 0, "받은 지움을 다시 올리지 않는다");
}

#[test]
fn later_write_wins_and_earlier_one_is_ignored() {
    let (a, b) = (db(), db());
    let t = todos::add(&a, "청소", None).unwrap();
    let recs = push_all(&a, "A");
    apply_all(&b, "B", &recs);

    // A 가 완료, B 는 그보다 나중에(ts 가 큰) 다른 것을 바꾼 셈 — 겨루기는 기록 단위
    todos::complete(&a, t.id).unwrap();
    let done = push_all(&a, "A");
    let mut older = done[0].clone();
    older.ts -= 10_000;
    older.blob = Some(seal(&KEY, &older, r#"{"content":"옛 값","status":"open"}"#.as_bytes()).unwrap());
    apply_all(&b, "B", &done);
    apply_all(&b, "B", &[older]);
    assert_eq!(todos::list_done(&b).unwrap()[0].content, "청소", "옛 쓰기는 진다");
}

#[test]
fn a_joining_device_takes_the_groups_settings_instead_of_overwriting_them() {
    let (a, b) = (db(), db());
    // 쓰던 기기 A 가 한참 전에 꾸민 외형
    settings::set(&a, "neko_appearance", "꾸민 외형").unwrap();
    a.execute("UPDATE sync_meta SET ts = 1000 WHERE coll = 'setting'", []).unwrap();
    // 방금 켠 기기 B 는 기본 외형을 더 나중에 적었다. 메모는 B 것도 올라가야 한다
    settings::set(&b, "neko_appearance", "기본 외형").unwrap();
    memories::save(&b, "fact", "B 가 아는 것").unwrap();
    // B 가 짝 문자열로 끼어든다: 전부 올릴 것으로 찍되 설정은 양보
    b.execute("UPDATE sync_meta SET dirty = 1", []).unwrap();
    yield_settings(&b).unwrap();
    let from_b = push_all(&b, "B");
    assert!(from_b.iter().all(|r| r.coll != "setting"), "끼어든 기기의 설정은 올라가지 않는다");
    assert!(from_b.iter().any(|r| r.coll == "memory"));
    apply_all(&b, "B", &push_all(&a, "A"));
    assert_eq!(settings::get(&b, "neko_appearance").unwrap().as_deref(), Some("꾸민 외형"));
    // 그 뒤 B 에서 바꾸면 다시 올라간다
    settings::set(&b, "neko_appearance", "폰에서 바꾼 외형").unwrap();
    assert!(push_all(&b, "B").iter().any(|r| r.coll == "setting"));
}

#[test]
fn records_sealed_with_another_key_are_skipped_and_counted() {
    let (a, b) = (db(), db());
    todos::add(&a, "다른 열쇠로 올린 것", None).unwrap();
    let recs = push_all(&a, "A");
    // B 는 다른 암호 키를 들고 있다(dev 빌드가 키체인의 열쇠를 덮은 뒤 연결된 기기처럼)
    let srv = Server { url: String::new(), token: String::new(), device: "B".into(), key: [7u8; 32] };
    let resp = SyncResp { records: recs.clone(), seq: 9, more: false, rejected: Vec::new(), reset: false, walk: None };
    settle(&b, &srv, &[], &resp, &mut Changes::default()).unwrap();
    assert!(todos::list_open(&b).unwrap().is_empty(), "못 푼 기록은 적용되지 않는다");
    assert_eq!(state_i64(&b, "skipped").unwrap(), recs.len() as i64, "건너뛴 수를 남긴다(설정이 알린다)");
    // 처음부터 다시 받아 다 풀리면 0 으로 돌아온다
    set_state(&b, "since", "0").unwrap();
    let ok = Server { key: KEY, ..srv };
    settle(&b, &ok, &[], &resp, &mut Changes::default()).unwrap();
    assert_eq!(state_i64(&b, "skipped").unwrap(), 0);
    assert_eq!(todos::list_open(&b).unwrap().len(), 1);
}

#[test]
fn the_shared_walk_from_the_server_is_kept_and_reported_once() {
    let c = db();
    let srv = Server { url: String::new(), token: String::new(), device: "B".into(), key: KEY };
    let walk = SharedWalk { start: 1000, end: 2000, device: "A".into() };
    let with = |w: Option<SharedWalk>| SyncResp { records: Vec::new(), seq: 1, more: false, rejected: Vec::new(), reset: false, walk: w };
    let mut ch = Changes::default();
    settle(&c, &srv, &[], &with(Some(walk.clone())), &mut ch).unwrap();
    assert!(ch.colls.contains("walk"), "다른 기기의 산책을 화면에 알린다");
    assert_eq!(stored_walk(&c).unwrap(), Some(walk.clone()));
    // 같은 산책이면 다시 알리지 않고, 옛 서버(walk 없음)면 적어 둔 것을 지우지 않는다
    let mut again = Changes::default();
    settle(&c, &srv, &[], &with(Some(walk.clone())), &mut again).unwrap();
    settle(&c, &srv, &[], &with(None), &mut again).unwrap();
    assert!(again.colls.is_empty());
    assert_eq!(stored_walk(&c).unwrap(), Some(walk));
}

#[test]
fn same_memory_from_two_devices_is_merged_into_the_smaller_id() {
    let (a, b) = (db(), db());
    memories::save(&a, "fact", "생일은 3월 2일").unwrap();
    memories::save(&b, "fact", "생일은 3월 2일").unwrap();
    let (ra, rb) = (push_all(&a, "A"), push_all(&b, "B"));
    let (ua, ub) = (ra[0].id.clone(), rb[0].id.clone());
    apply_all(&b, "B", &ra);
    apply_all(&a, "A", &rb);
    // 둘 다 하나만 갖고, 큰 번호의 지움 표시를 올린다
    for (c, me) in [(&a, "A"), (&b, "B")] {
        assert_eq!(memories::list(c).unwrap().len(), 1);
        let up = push_all(c, me);
        assert!(up.iter().all(|r| r.deleted == 1 && r.id == ua.clone().max(ub.clone())), "{up:?}");
    }
    let keep: String = a.query_row("SELECT uid FROM sync_meta WHERE coll = 'memory' AND deleted = 0", [], |r| r.get(0)).unwrap();
    assert_eq!(keep, ua.min(ub));
}

#[test]
fn deleted_session_and_cut_reach_the_other_device() {
    let (a, b) = (db(), db());
    for s in ["keep", "gone"] {
        session_put(&a, s, s, 1).unwrap();
        conversations::save(&a, s, "user", "옛 말", None, None).unwrap();
    }
    apply_all(&b, "B", &push_all(&a, "A"));

    session_delete(&a, "gone").unwrap();
    session_compact(&a, "keep", "요약: 옛 말을 했다").unwrap();
    let recs = push_all(&a, "A");
    let tomb = recs.iter().find(|r| r.id == "gone").unwrap();
    assert_eq!((tomb.deleted, tomb.cut, tomb.blob.is_none()), (1, None, true));
    assert!(recs.iter().find(|r| r.id == "keep").unwrap().cut.is_some());

    let ch = apply_all(&b, "B", &recs);
    assert!(ch.sessions.contains("gone") && ch.sessions.contains("keep"));
    assert_eq!(titles(&b), ["keep"]);
    assert!(conversations::load(&b, "gone").unwrap().is_empty());
    assert!(conversations::load(&b, "keep").unwrap().is_empty(), "cut 안쪽 메시지는 지운다");
    assert_eq!(session_list(&b).unwrap()[0].summary.as_deref(), Some("요약: 옛 말을 했다"));

    // 사용자가 지운 세션은 더 새 쓰기가 와도 안 살아난다
    let mut revive = recs.iter().find(|r| r.id == "keep").unwrap().clone();
    revive.id = "gone".into();
    revive.ts += 1_000_000;
    revive.cut = None;
    revive.blob = Some(seal(&KEY, &revive, r#"{"title":"좀비","created_at":1,"summary":null}"#.as_bytes()).unwrap());
    apply_all(&b, "B", &[revive]);
    assert_eq!(titles(&b), ["keep"]);
}

#[test]
fn prune_tombstone_revives_a_session_with_unsent_messages() {
    let (a, b) = (db(), db());
    session_put(&a, "s", "s", 1).unwrap();
    apply_all(&b, "B", &push_all(&a, "A"));
    // B 에서 아직 못 올린 새 메시지
    conversations::save(&b, "s", "user", "오프라인에서 한 말", None, None).unwrap();
    // A 가 자동 삭제
    mark_pruned(&a, &["s".to_string()], 30).unwrap();
    let tomb = push_all(&a, "A");
    assert_eq!((tomb[0].deleted, tomb[0].cut.is_some()), (1, true));
    apply_all(&b, "B", &tomb);
    assert_eq!(titles(&b), ["s"], "되살린다");
    let up = push_all(&b, "B");
    let s = up.iter().find(|r| r.coll == "session").unwrap();
    assert!(s.deleted == 0 && s.ts > tomb[0].ts, "더 새 쓰기로 되살려 올린다");
    // 못 올린 메시지가 없으면 지운다
    let (c, d) = (db(), db());
    session_put(&c, "t", "t", 1).unwrap();
    apply_all(&d, "D", &push_all(&c, "C"));
    mark_pruned(&c, &["t".to_string()], 30).unwrap();
    apply_all(&d, "D", &push_all(&c, "C"));
    assert!(titles(&d).is_empty());
}

#[test]
fn gifts_sync_one_by_one_and_keep_device_only_fields() {
    let (a, b) = (db(), db());
    let gifts = |c: &Connection| -> Vec<Value> { load_gifts(c).unwrap() };
    settings::set(&a, GIFTS, r#"[{"id":"g1","title":"솔방울","placed":{"at":"screen","surface":"floor","u":0.3,"screen":"A-MON"},"lastPlayed":5},{"id":"g2","title":"조약돌"}]"#).unwrap();
    settings::set(&b, GIFTS, r#"[{"id":"g9","title":"B 의 것"}]"#).unwrap();
    let recs = push_all(&a, "A");
    assert_eq!(recs.len(), 2);
    let plain = String::from_utf8(unseal(&KEY, &recs[0]).unwrap()).unwrap();
    assert!(!plain.contains("A-MON") && !plain.contains("lastPlayed"), "{plain}");
    assert!(push_all(&a, "A").is_empty(), "안 바뀌면 다시 안 올린다");

    apply_all(&b, "B", &recs);
    let got = gifts(&b);
    assert_eq!(got.len(), 3, "B 의 선물은 남는다");
    // B 가 자기 모니터에 옮기고 갖고 논다 → 모니터·lastPlayed 만 바뀐 건 안 올린다
    let mut moved = got.clone();
    moved[1]["placed"]["screen"] = "B-MON".into();
    moved[1]["lastPlayed"] = 99.into();
    settings::set(&b, GIFTS, &Value::Array(moved).to_string()).unwrap();
    let up = push_all(&b, "B");
    assert_eq!(up.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["g9"], "B 의 것만 처음 올라간다");

    // A 가 g1 을 옮기면 B 에는 자리가 바뀌어도 B 의 모니터·lastPlayed 는 남는다
    let mut a_list = gifts(&a);
    a_list[0]["placed"]["u"] = 0.8.into();
    a_list.remove(1); // g2 를 버린다
    settings::set(&a, GIFTS, &Value::Array(a_list).to_string()).unwrap();
    let recs = push_all(&a, "A");
    assert_eq!(recs.iter().filter(|r| r.deleted == 1).count(), 1);
    apply_all(&b, "B", &recs);
    let got = gifts(&b);
    let g1 = got.iter().find(|g| g["id"] == "g1").unwrap();
    assert_eq!((g1["placed"]["u"].as_f64(), g1["placed"]["screen"].as_str(), g1["lastPlayed"].as_i64()), (Some(0.8), Some("B-MON"), Some(99)));
    assert!(!got.iter().any(|g| g["id"] == "g2"));
    assert!(push_all(&b, "B").is_empty(), "받은 선물은 다시 안 올린다");
}

#[test]
fn settings_outside_the_synced_list_are_ignored_when_received() {
    let (a, b) = (db(), db());
    settings::set(&b, "fs_write_roots", "/Users/me/safe").unwrap();
    let mk = |id: &str, ts: i64, deleted: i64, value: &str| {
        let mut r = Record { coll: "setting".into(), id: id.into(), parent: None, ts, device: "X".into(), deleted, cut: None, blob: None };
        if deleted == 0 {
            r.blob = Some(seal(&KEY, &r, serde_json::json!({ "value": value }).to_string().as_bytes()).unwrap());
        }
        r
    };
    apply_all(&b, "B", &[mk("fs_write_roots", now_ms(), 0, "/"), mk("anthropic_api_key", now_ms(), 0, "sk-x")]);
    assert_eq!(settings::get(&b, "fs_write_roots").unwrap().as_deref(), Some("/Users/me/safe"));
    assert_eq!(settings::get(&b, "anthropic_api_key").unwrap(), None);
    apply_all(&b, "B", &[mk("fs_write_roots", now_ms() + 1, 1, "")]);
    assert_eq!(settings::get(&b, "fs_write_roots").unwrap().as_deref(), Some("/Users/me/safe"), "지움도 버린다");
    // 맞추는 키는 받는다
    apply_all(&b, "B", &[mk("neko_name", now_ms(), 0, "나비")]);
    assert_eq!(settings::get(&b, "neko_name").unwrap().as_deref(), Some("나비"));
    // 올리는 쪽도 목록 밖 키는 안 올린다
    settings::set(&a, "fs_write_roots", "/").unwrap();
    assert!(push_all(&a, "A").is_empty());
}

#[test]
fn a_message_whose_body_names_another_session_is_refused() {
    let b = db();
    let mut r = Record { coll: "msg".into(), id: "m".into(), parent: Some("s1".into()), ts: 1, device: "X".into(), deleted: 0, cut: None, blob: None };
    r.blob = Some(seal(&KEY, &r, br#"{"session_id":"s2","role":"user","content":"x"}"#).unwrap());
    assert!(apply(&b, "B", &KEY, &r, &mut Changes::default()).is_err());
    assert!(conversations::load(&b, "s2").unwrap().is_empty());
}

#[test]
fn a_gift_received_just_before_the_screen_saves_is_kept() {
    let (a, b) = (db(), db());
    settings::set(&a, GIFTS, r#"[{"id":"g1","title":"솔방울"},{"id":"g2","title":"조약돌"}]"#).unwrap();
    apply_all(&b, "B", &push_all(&a, "A"));
    // A 에서 새 선물 g3 이 온다. B 의 화면은 아직 g1·g2 만 알고, 그 낡은 상태에서 놀고·옮기고·새 선물을 넣고·지운다
    settings::set(&a, GIFTS, r#"[{"id":"g1","title":"솔방울"},{"id":"g2","title":"조약돌"},{"id":"g3","title":"도토리"}]"#).unwrap();
    apply_all(&b, "B", &push_all(&a, "A"));
    gift_patch(&b, "g1", &serde_json::json!({ "lastPlayed": 7, "placed": { "at": "dock", "surface": "floor", "u": 0.5 } })).unwrap();
    gift_add(&b, &serde_json::json!({ "id": "g4", "title": "B 가 주운 것" })).unwrap();
    gift_remove(&b, &["g2".to_string()]).unwrap();
    let ids: Vec<String> = load_gifts(&b).unwrap().iter().map(|g| g["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(ids, ["g1", "g3", "g4"], "받은 g3 이 남는다");
    let up = push_all(&b, "B");
    let tombs: Vec<&str> = up.iter().filter(|r| r.deleted == 1).map(|r| r.id.as_str()).collect();
    assert_eq!(tombs, ["g2"], "화면에서 뺀 것만 지움으로 올라간다");
    assert!(!up.iter().any(|r| r.id == "g3"), "받은 선물은 다시 안 올린다");
    // 다른 기기에서 지운 선물을 낡은 화면이 갖고 놀아도 되살아나지 않는다
    assert!(!gift_patch(&b, "g2", &serde_json::json!({ "lastPlayed": 9 })).unwrap());
    // null 은 칸을 뺀다(선물함으로 치우기)
    gift_patch(&b, "g1", &serde_json::json!({ "placed": null })).unwrap();
    assert!(load_gifts(&b).unwrap()[0].get("placed").is_none());
}

#[test]
fn big_messages_drop_image_bodies() {
    let c = db();
    let big = format!("data:image/png;base64,{}", "A".repeat(800_000));
    let att = serde_json::json!([{ "name": "cat.png", "type": "image/png", "size": 1, "dataUrl": big }]).to_string();
    conversations::save(&c, "s", "user", "그림", Some(&att), None).unwrap();
    let r = &push_all(&c, "A")[0];
    let plain: Value = serde_json::from_slice(&unseal(&KEY, r).unwrap()).unwrap();
    let a: Value = serde_json::from_str(plain["attachments"].as_str().unwrap()).unwrap();
    assert_eq!((a[0]["name"].as_str(), a[0]["dataUrl"].as_str()), (Some("cat.png"), Some("")));
    assert_eq!(r.parent.as_deref(), Some("s"));
}

// ── 실제 서버(wrangler dev) ──────────────────────────────────────────────────

#[derive(Deserialize)]
struct Reg {
    device_id: String,
    token: String,
}

fn live_url() -> String {
    std::env::var("NEKO_SYNC_URL").unwrap_or_else(|_| "http://127.0.0.1:8787".into())
}

async fn device(body: Value) -> Server {
    let r: Reg = call(reqwest::Method::POST, &live_url(), "/v1/devices", None, &body).await.unwrap();
    Server { url: live_url(), token: r.token, device: r.device_id, key: KEY }
}

/// 기기 A·B(메모리 DB 둘)가 wrangler dev 에 대고 맞춘다: 올리고 받기, 겨루기, 세션 지움, cut,
/// 자동 삭제 거절과 되찾기, 오프라인 양쪽 쓰기.
#[test]
#[ignore]
fn live() {
    tauri::async_runtime::block_on(async {
        let setup = std::env::var("SETUP_TOKEN").unwrap_or_else(|_| "dev-setup-token".into());
        let sa = device(serde_json::json!({ "name": "A", "setup_token": setup })).await;
        #[derive(Deserialize)]
        struct Code { code: String }
        let code: Code = call(reqwest::Method::POST, &sa.url, "/v1/pair", Some(&sa.token), &serde_json::json!({})).await.unwrap();
        let sb = device(serde_json::json!({ "name": "B", "pair_code": code.code })).await;
        let (a, b) = (Mutex::new(db()), Mutex::new(db()));
        // 서버에 이전 시험의 기록이 남아 있어도 이번 것만 본다(세션 id 를 새로)
        let run = format!("{:x}", now_ms());
        let s1 = format!("live-{run}");
        let s2 = format!("live2-{run}");

        // A 가 말한다 → B 에 보인다
        {
            let c = a.lock().unwrap();
            session_put(&c, &s1, "같이 쓰는 대화", now_ms()).unwrap();
            conversations::save(&c, &s1, "user", "A 에서 한 말", None, None).unwrap();
            memories::save(&c, "fact", &format!("기억 {run}")).unwrap();
            settings::set(&c, GIFTS, &format!(r#"[{{"id":"g-{run}","title":"솔방울"}}]"#)).unwrap();
        }
        round(&a, &sa, now_ms()).await.unwrap();
        let ch = round(&b, &sb, 0).await.unwrap();
        assert!(ch.sessions.contains(&s1));
        {
            let c = b.lock().unwrap();
            assert_eq!(conversations::load(&c, &s1).unwrap()[0].content, "A 에서 한 말");
            assert!(memories::list(&c).unwrap().iter().any(|m| m.content == format!("기억 {run}")));
            assert!(load_gifts(&c).unwrap().iter().any(|g| g["id"] == format!("g-{run}")));
            // B 가 이어 말한다
            conversations::save(&c, &s1, "assistant", "B 에서 한 답", None, None).unwrap();
        }
        round(&b, &sb, 0).await.unwrap();
        round(&a, &sa, 0).await.unwrap();
        assert_eq!(conversations::load(&a.lock().unwrap(), &s1).unwrap().len(), 2);

        // 오프라인 양쪽 쓰기: 둘 다 남는다. 같은 할 일을 둘이 고치면 나중 것이 이긴다
        {
            let c = a.lock().unwrap();
            conversations::save(&c, &s1, "user", "A 오프라인", None, None).unwrap();
            todos::add(&c, &format!("할 일 {run}"), None).unwrap();
        }
        round(&a, &sa, 0).await.unwrap();
        round(&b, &sb, 0).await.unwrap();
        {
            let c = b.lock().unwrap();
            conversations::save(&c, &s1, "user", "B 오프라인", None, None).unwrap();
            let t = todos::list_open(&c).unwrap().into_iter().find(|t| t.content.ends_with(&run)).unwrap();
            todos::complete(&c, t.id).unwrap(); // B 가 나중
        }
        round(&b, &sb, 0).await.unwrap();
        round(&a, &sa, 0).await.unwrap();
        for c in [&a, &b] {
            let c = c.lock().unwrap();
            let msgs: Vec<String> = conversations::load(&c, &s1).unwrap().into_iter().map(|m| m.content).collect();
            assert!(msgs.contains(&"A 오프라인".to_string()) && msgs.contains(&"B 오프라인".to_string()), "{msgs:?}");
            assert!(todos::list_done(&c).unwrap().iter().any(|t| t.content.ends_with(&run)));
        }

        // 수동 요약(cut)과 세션 지움이 넘어간다
        {
            let c = a.lock().unwrap();
            session_compact(&c, &s1, "요약").unwrap();
            session_put(&c, &s2, "지울 대화", now_ms()).unwrap();
        }
        round(&a, &sa, 0).await.unwrap();
        round(&b, &sb, 0).await.unwrap();
        session_delete(&a.lock().unwrap(), &s2).unwrap();
        round(&a, &sa, 0).await.unwrap();
        round(&b, &sb, 0).await.unwrap();
        {
            let c = b.lock().unwrap();
            assert!(conversations::load(&c, &s1).unwrap().is_empty());
            let list = session_list(&c).unwrap();
            assert_eq!(list.iter().find(|s| s.id == s1).unwrap().summary.as_deref(), Some("요약"));
            assert!(!list.iter().any(|s| s.id == s2));
        }

        // 자동 삭제 거절: A 는 모르고 지우는데 B 가 그사이 서버에 새 말을 올렸다
        let s3 = format!("live3-{run}");
        {
            let c = a.lock().unwrap();
            session_put(&c, &s3, "오래된 대화", now_ms()).unwrap();
            conversations::save(&c, &s3, "user", "옛 말", None, None).unwrap();
        }
        round(&a, &sa, 0).await.unwrap();
        round(&b, &sb, 0).await.unwrap();
        conversations::save(&b.lock().unwrap(), &s3, "user", "B 가 어제 한 말", None, None).unwrap();
        round(&b, &sb, 0).await.unwrap();
        {
            // A 는 B 의 말을 아직 안 받았다. 기준을 미래로 잡아 A 눈엔 다 오래됐다
            let c = a.lock().unwrap();
            c.execute("DELETE FROM conversation_messages WHERE session_id = ?1", [&s3]).unwrap();
            c.execute("DELETE FROM sessions WHERE id = ?1", [&s3]).unwrap();
            c.execute("UPDATE sync_meta SET cut = ?2 WHERE coll = 'session' AND uid = ?1", params![s3, now_ms() - 60_000]).unwrap();
        }
        round(&a, &sa, 0).await.unwrap();
        {
            let c = a.lock().unwrap();
            assert!(session_list(&c).unwrap().iter().any(|s| s.id == s3), "거절되면 세션을 되찾는다");
            let msgs: Vec<String> = conversations::load(&c, &s3).unwrap().into_iter().map(|m| m.content).collect();
            assert!(msgs.contains(&"B 가 어제 한 말".to_string()), "{msgs:?}");
        }
        assert_eq!(dirty(&a.lock().unwrap()), 0);
        assert_eq!(dirty(&b.lock().unwrap()), 0);
        // 열쇠 바꾸기: 그 전에 만든 짝 코드(옛 열쇠가 든 짝 문자열)로는 뒤에 못 들어온다. 다른 기기는 끊긴다
        let old: Code = call(reqwest::Method::POST, &sa.url, "/v1/pair", Some(&sa.token), &serde_json::json!({})).await.unwrap();
        super::run::rekey_server(&sa).await.unwrap();
        let late: AppResult<Value> = call(reqwest::Method::POST, &sa.url, "/v1/devices", None, &serde_json::json!({ "name": "옛 짝", "pair_code": old.code })).await;
        assert!(late.is_err(), "rekey 전 짝 코드는 거절");
        assert!(round(&b, &sb, 0).await.is_err(), "B 는 끊겼다");
        // 본문 없는 GET(기기 목록) — Workers 는 본문 있는 GET 을 거절한다
        let list: Value = call(reqwest::Method::GET, &sa.url, "/v1/devices", Some(&sa.token), &Value::Null).await.unwrap();
        assert!(list["devices"].as_array().unwrap().iter().any(|d| d["id"] == sb.device.as_str()));
        println!("live sync ok (A {}, B {})", sa.device, sb.device);
    });
}

#[test]
fn sessions_list_by_last_message_the_same_on_every_device() {
    let (a, b) = (db(), db());
    let msg = |s: &str, role: &str, at: &str| {
        a.execute("INSERT INTO conversation_messages (session_id, role, content, created_at) VALUES (?1, ?2, 'x', ?3)", params![s, role, at]).unwrap();
    };
    session_put(&a, "old-asked", "old-asked", 1_000).unwrap();
    session_put(&a, "answered", "answered", 2_000).unwrap();
    session_put(&a, "empty-old", "empty-old", 500).unwrap();
    session_put(&a, "empty-new", "empty-new", now_ms()).unwrap();
    // 늦게 만든 세션이라도 마지막 메시지가 이르면 아래로. 질문만 있어도 그 시각으로 올라온다
    msg("answered", "user", "2026-01-01 00:00:01");
    msg("answered", "assistant", "2026-01-01 00:00:05");
    msg("old-asked", "user", "2026-01-01 00:00:09");
    let order = |c: &Connection| session_list(c).unwrap().into_iter().map(|s| (s.id, s.unread)).collect::<Vec<_>>();
    let want: Vec<(String, bool)> = [("empty-new", false), ("old-asked", false), ("answered", true), ("empty-old", false)]
        .map(|(id, u)| (id.to_owned(), u))
        .into();
    assert_eq!(order(&a), want, "메시지가 없으면 만든 때로 친다. 새 답 점은 답만 본다");
    apply_all(&b, "B", &push_all(&a, "A"));
    assert_eq!(order(&b), want, "다른 기기도 같은 순서");
}

#[test]
fn furniture_changed_on_two_devices_merges_and_both_end_the_same() {
    let (a, b) = (db(), db());
    let set = |c: &Connection, items: Value| settings::set(c, "neko_furniture", &serde_json::json!({ "v": 2, "items": items, "gone": {} }).to_string()).unwrap();
    let ids = |c: &Connection| {
        let v: Value = serde_json::from_str(&settings::get(c, "neko_furniture").unwrap().unwrap()).unwrap();
        v["items"].as_array().unwrap().iter().map(|i| (i["id"].as_str().unwrap().to_owned(), i["place"].clone())).collect::<Vec<_>>()
    };
    // 서로 모르는 채로: 폰(a)은 소파를 놓고, 맥(b)은 산책에서 상자를 물어왔다
    set(&a, serde_json::json!([{ "id": "base:sofa", "kind": "sofa", "place": { "at": "dock", "slot": 0 }, "at": 10 }]));
    set(&b, serde_json::json!([{ "id": "walk:x", "kind": "box", "place": null, "at": 20 }]));
    // 주고받기를 더 올릴 것이 없을 때까지(어느 쪽 기록이 먼저 닿든)
    for _ in 0..4 {
        let (up_a, up_b) = (push_all(&a, "A"), push_all(&b, "B"));
        if up_a.is_empty() && up_b.is_empty() {
            break;
        }
        apply_all(&b, "B", &up_a);
        apply_all(&a, "A", &up_b);
    }
    assert!(push_all(&a, "A").is_empty() && push_all(&b, "B").is_empty(), "다 맞춘 뒤엔 올릴 것이 없다");
    let want = vec![("base:sofa".to_owned(), serde_json::json!({ "at": "dock", "slot": 0 })), ("walk:x".to_owned(), Value::Null)];
    assert_eq!(ids(&a), want, "폰: 둘 다");
    assert_eq!(ids(&b), want, "맥: 같은 값");
}

fn session_ids(c: &Connection) -> Vec<String> {
    session_list(c).unwrap().into_iter().map(|s| s.id).collect()
}

#[test]
fn deleted_session_goes_away_on_the_other_device_and_stale_writes_do_not_revive_it() {
    let (a, b) = (db(), db());
    session_put(&a, "s", "이미지 대화", 1).unwrap();
    conversations::save(&a, "s", "user", "그림 봐", None, None).unwrap();
    session_put(&a, "keep", "남는 대화", 2).unwrap();
    apply_all(&b, "B", &push_all(&a, "A"));
    assert_eq!(session_ids(&b).len(), 2);
    // 맥(a)에서 지웠다 → 폰(b)에서도 지워진다
    session_delete(&a, "s").unwrap();
    apply_all(&b, "B", &push_all(&a, "A"));
    assert_eq!(session_ids(&b), ["keep"]);
    assert!(conversations::load(&b, "s").unwrap().is_empty());
    // 폰 화면의 낡은 목록이 제목을 고치거나(put) 요약하거나 옮기려 해도 되살지 않는다
    session_put(&b, "s", "새 제목", 1).unwrap();
    session_compact(&b, "s", "요약").unwrap();
    session_import(&b, &[SessionRow { id: "s".into(), title: "옛 목록".into(), created_at: 1, summary: None, unread: false }]).unwrap();
    assert_eq!(session_ids(&b), ["keep"]);
    // 올라가는 것은 지움 표시뿐 — 맥에서도 다시 안 생긴다
    let up = push_all(&b, "B");
    assert!(up.iter().filter(|r| r.coll == "session" && r.id == "s").all(|r| r.deleted == 1));
    apply_all(&a, "A", &up);
    assert_eq!(session_ids(&a), ["keep"]);
}

#[test]
fn big_messages_always_fit_the_server_and_pushes_are_cut_by_bytes() {
    let c = db();
    let img = format!("data:image/png;base64,{}", "A".repeat(900_000));
    let text = "본문".repeat(450_000); // 첨부 파일의 글(그림이 아니라 data: 가 아니다)
    let att = serde_json::json!([{ "name": "a.png", "dataUrl": img }, { "name": "b.txt", "content": text }]).to_string();
    conversations::save(&c, "s", "user", "그림과 글", Some(&att), None).unwrap();
    conversations::save(&c, "s", "user", &"긴 말".repeat(600_000), None, None).unwrap();
    let recs = collect(&c, "A", &KEY).unwrap();
    // 서버 한 건 상한(server/src/index.ts BLOB_MAX) 아래 — 넘으면 조용히 거절돼 다른 기기에 안 갔다
    const BLOB_MAX: usize = (1_048_576usize * 4).div_ceil(3) + 64;
    assert!(recs.iter().all(|r| r.blob.as_ref().is_some_and(|b| b.len() <= BLOB_MAX)), "{:?}", recs.iter().map(|r| r.blob.as_ref().map(|b| b.len())).collect::<Vec<_>>());
    let first: Value = serde_json::from_slice(&unseal(&KEY, &recs[0]).unwrap()).unwrap();
    assert_eq!(first["content"], "그림과 글", "말은 그대로, 그림 본문과 긴 첨부 글만 줄인다");
    // 한 요청에 싣는 양은 1MB 남짓까지: 큰 말 여럿은 나눠 올린다
    let c = db();
    for i in 0..5 {
        conversations::save(&c, "s", "user", &format!("{i}{}", "가".repeat(100_000)), None, None).unwrap();
    }
    let n = collect(&c, "A", &KEY).unwrap().len();
    assert!((1..5).contains(&n), "{n}");
    assert_eq!(push_all(&c, "A").len(), 5, "나머지는 다음 요청에");
}

#[test]
fn resend_once_puts_conversations_back_on_the_wire_except_auto_deletes() {
    let c = db();
    session_put(&c, "s", "대화", 1).unwrap();
    conversations::save(&c, "s", "user", "안녕", None, None).unwrap();
    session_put(&c, "gone", "지운 대화", 2).unwrap();
    session_put(&c, "old", "오래된 대화", 3).unwrap();
    push_all(&c, "A");
    session_delete(&c, "gone").unwrap();
    session_delete(&c, "old").unwrap();
    mark_pruned(&c, &["old".into()], 30).unwrap();
    push_all(&c, "A");
    set_state(&c, "since", "99").unwrap();
    resend_once(&c).unwrap();
    let up = push_all(&c, "A");
    let mut what: Vec<_> = up.iter().map(|r| (r.coll.as_str(), r.id.as_str() == "s" || r.coll == "msg", r.deleted)).collect();
    what.sort();
    assert_eq!(what, [("msg", true, 0), ("session", false, 1), ("session", true, 0)], "말·세션·사용자가 지운 표시만, 자동 삭제는 빼고");
    assert_eq!(state(&c, "since").unwrap().as_deref(), Some("0"), "처음부터 다시 받는다");
    // 한 번만
    set_state(&c, "since", "99").unwrap();
    resend_once(&c).unwrap();
    assert!(push_all(&c, "A").is_empty());
    assert_eq!(state(&c, "since").unwrap().as_deref(), Some("99"));
}

#[test]
fn resent_old_messages_do_not_revive_a_session_another_device_auto_deleted() {
    let (a, b) = (db(), db());
    session_put(&a, "s", "옛 대화", 1).unwrap();
    conversations::save(&a, "s", "user", "옛 말", None, None).unwrap();
    apply_all(&b, "B", &push_all(&a, "A"));
    resend_once(&a).unwrap(); // 옛 말이 다시 올릴 거리가 됐다
    // 폰(b)이 오래된 대화로 자동 삭제했다(기준 시각 = 지금보다 나중으로 잡아 옛 말이 다 그 안쪽)
    session_delete(&b, "s").unwrap();
    b.execute("UPDATE sync_meta SET cut = ?1 WHERE coll = 'session' AND uid = 's'", [now_ms() + 60_000]).unwrap();
    apply_all(&a, "A", &push_all(&b, "B"));
    assert!(session_ids(&a).is_empty(), "다시 올리던 옛 말로는 되살리지 않는다");
}

/// 서버 흉내(다시 맞추기용): 받아들인 기록을 (coll, id) 별로 쥔다. 같은 번호는 (ts, 기기) 가 큰 것, 사용자가 지운 세션은 늘 이긴다
#[derive(Default)]
struct Store(std::collections::BTreeMap<(String, String), Record>);
impl Store {
    fn take(&mut self, recs: Vec<Record>) {
        for r in recs {
            let k = (r.coll.clone(), r.id.clone());
            let keep = match self.0.get(&k) {
                Some(o) if o.coll == "session" && o.deleted == 1 && o.cut.is_none() => false,
                Some(o) if r.coll == "msg" => o.ts < 0,
                Some(o) => (r.ts, r.device.as_str()) > (o.ts, o.device.as_str()) || (r.coll == "session" && r.deleted == 1 && r.cut.is_none()),
                None => true,
            };
            if keep {
                self.0.insert(k, r);
            }
        }
    }
    fn heads(&self) -> Vec<reconcile::Head> {
        self.0.values().map(|r| reconcile::Head { coll: r.coll.clone(), id: r.id.clone(), parent: r.parent.clone(), ts: r.ts, device: r.device.clone(), deleted: r.deleted, cut: r.cut }).collect()
    }
    /// 다시 맞추기(reconcile::reconcile 에서 네트워크만 뺀 것): 머리를 견주고, 지움 표시를 적용하고, 고른 기록을 받는다
    fn reconcile(&self, c: &Connection, me: &str) -> reconcile::Plan {
        let plan = reconcile::plan(c, me, &self.heads()).unwrap();
        let mut ch = Changes::default();
        for t in &plan.tombs {
            apply(c, me, &KEY, t, &mut ch).unwrap();
        }
        for k in &plan.fetch {
            apply(c, me, &KEY, &self.0[k], &mut ch).unwrap();
        }
        plan
    }
}

/// 기기 이름을 붙여 올린다(서버가 하듯)
fn upload(c: &Connection, me: &str, s: &mut Store) {
    let recs: Vec<Record> = push_all(c, me).into_iter().map(|mut r| { r.device = me.into(); r }).collect();
    s.take(recs);
}

#[test]
fn records_lost_on_one_side_come_back_after_reconcile() {
    let (a, b, mut s) = (db(), db(), Store::default());
    session_put(&a, "s", "같이 보는 대화", 1).unwrap();
    conversations::save(&a, "s", "user", "안녕", None, None).unwrap();
    session_put(&a, "bye", "지울 대화", 2).unwrap();
    upload(&a, "A", &mut s);
    apply_all(&b, "B", &s.0.values().cloned().collect::<Vec<_>>());
    // 맥(a)에서 이미지 대화를 썼는데 서버에 조용히 안 갔다(올린 것으로 찍혔지만 서버엔 없다)
    session_put(&a, "img", "이미지 대화", 3).unwrap();
    conversations::save(&a, "img", "user", "그림 봐", None, None).unwrap();
    push_all(&a, "A");
    // 폰(b)에서 지운 것을 맥은 못 받았다(시각이 겹치지 않게 조금 뒤에)
    std::thread::sleep(std::time::Duration::from_millis(5));
    session_delete(&b, "bye").unwrap();
    upload(&b, "B", &mut s);
    assert_ne!(session_ids(&a), session_ids(&b), "갈라졌다");

    // 맥이 다시 맞춘다: 지운 세션을 지우고, 서버에 없는 이미지 대화를 올릴 거리로 찍는다
    let plan = s.reconcile(&a, "A");
    assert_eq!((plan.tombs.len(), plan.pushed), (1, 2), "지움 하나, 올릴 것 둘(세션·말)");
    upload(&a, "A", &mut s);
    // 폰이 다시 맞춘다: 서버에만 있는 이미지 대화를 받는다
    let plan = s.reconcile(&b, "B");
    assert_eq!(plan.fetch.len(), 2);
    assert_eq!(session_ids(&a), session_ids(&b));
    assert_eq!(session_ids(&a), ["img", "s"]);
    assert_eq!(conversations::load(&b, "img").unwrap().len(), 1);
    // 지운 세션에 늦게 적힌 말(서버는 안 받는다)은 매번 다시 올릴 거리가 되지 않는다
    conversations::save(&a, "bye", "assistant", "늦은 답", None, None).unwrap();
    push_all(&a, "A");
    // 다 맞은 뒤엔 할 일이 없다(받은 지움을 적용하며 내 표시 시각이 새로 찍혀도)
    std::thread::sleep(std::time::Duration::from_millis(5));
    for c in [&a, &b] {
        let p = s.reconcile(c, if std::ptr::eq(c, &a) { "A" } else { "B" });
        assert!(p.fetch.is_empty() && p.tombs.is_empty() && p.pushed == 0, "{p:?}");
    }
}

/// wrangler dev 에 대고 다시 맞추기(/v1/heads·/v1/fetch): 한쪽이 잃은 말을 다시 받고, 조용히 안 올라간 말을 다시 올린다.
/// 손으로: cd server && npm run dev, 그리고 cargo test --lib sync::tests::live_reconcile -- --ignored
#[test]
#[ignore]
fn live_reconcile() {
    tauri::async_runtime::block_on(async {
        let setup = std::env::var("SETUP_TOKEN").unwrap_or_else(|_| "dev-setup-token".into());
        let sa = device(serde_json::json!({ "name": "A", "setup_token": setup })).await;
        #[derive(Deserialize)]
        struct Code { code: String }
        let code: Code = call(reqwest::Method::POST, &sa.url, "/v1/pair", Some(&sa.token), &serde_json::json!({})).await.unwrap();
        let sb = device(serde_json::json!({ "name": "B", "pair_code": code.code })).await;
        let (a, b) = (Mutex::new(db()), Mutex::new(db()));
        let s = format!("rec-{:x}", now_ms());
        {
            let c = a.lock().unwrap();
            session_put(&c, &s, "다시 맞출 대화", now_ms()).unwrap();
            conversations::save(&c, &s, "user", "첫 말", None, None).unwrap();
        }
        round(&a, &sa, 0).await.unwrap();
        round(&b, &sb, 0).await.unwrap();
        // B 가 그 말을 잃었다(사본이 사라짐). A 의 새 말은 올린 것으로 찍혔지만 서버엔 없다
        b.lock().unwrap().execute("DELETE FROM conversation_messages WHERE session_id = ?1", [&s]).unwrap();
        {
            let c = a.lock().unwrap();
            conversations::save(&c, &s, "user", "둘째 말", None, None).unwrap();
            c.execute("UPDATE sync_meta SET dirty = 0 WHERE coll = 'msg'", []).unwrap();
        }
        let (out, _) = reconcile::reconcile(&a, &sa).await.unwrap();
        assert_eq!((out.pushed, out.heavy), (1, false), "{out:?}");
        round(&a, &sa, 0).await.unwrap();
        let (out, ch) = reconcile::reconcile(&b, &sb).await.unwrap();
        assert!(out.fetched >= 2, "{out:?}"); // 같은 서버에서 도는 다른 시험의 기록도 받을 수 있다
        assert!(ch.sessions.contains(&s));
        let got: Vec<_> = conversations::load(&b.lock().unwrap(), &s).unwrap().into_iter().map(|m| m.content).collect();
        assert_eq!(got, ["첫 말", "둘째 말"]);
        // 다 맞은 뒤엔 올릴 것이 없다
        let (out, _) = reconcile::reconcile(&b, &sb).await.unwrap();
        assert_eq!(out.pushed, 0, "{out:?}");
    });
}
