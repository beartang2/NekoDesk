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
