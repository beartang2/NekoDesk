//! API 키 같은 비밀은 macOS 키체인에 둔다. 예전엔 SQLite settings 표(와 localStorage)에 그대로
//! 적혀 있어, 같은 사용자로 도는 프로그램은 물론 네코 자신의 파일 도구로도 읽혔다.
//!
//! 키체인 항목은 만든 앱(코드 서명)만 묻지 않고 꺼낸다. 다른 프로그램이 꺼내려 하면 macOS 가
//! 사용자에게 묻는다. 서명이 자체 인증서(Apple 발급 아님)라 업데이트할 때마다 macOS 는 새 앱으로
//! 보고 항목마다 따로 묻는다 — 그래서 비밀 전부를 항목 하나(`BUNDLE`, 이름→값 JSON)에 담는다.
//! 업데이트당 한 번만 묻는다(0.1.34 — 그 전엔 비밀마다 항목이 따로라 3~4번 떴다).
//!
//! 화면(webview)에는 값을 돌려주지 않는다 — 저장했는지만 알려 준다. 값을 쓰는 건 백엔드뿐이다
//! (검색·그림 그리기·Claude 중계). dev 빌드만 복사 버튼용으로 값을 꺼내 준다.

use crate::error::AppError;
use rusqlite::Connection;
use std::collections::{BTreeMap, BTreeSet};

/// 키체인에 두는 설정 이름. 이 밖의 이름은 비밀로 다루지 않는다.
pub const KEYS: &[&str] = &["brave_search_key", "cf_api_token", "google_api_key", "anthropic_api_key"];

#[cfg(any(target_os = "macos", target_os = "ios"))]
const SERVICE: &str = "com.nekodesk.desktop";

/// 비밀 전부를 담는 항목의 계정 이름(같은 `SERVICE`). 안의 이름은 예전 항목 이름 그대로다 —
/// API 키·`db_key` 는 dev·배포가 같이 쓰고, 동기화 비밀은 dev 만 `_dev` 를 붙인다(`sync_account`).
#[cfg(any(target_os = "macos", target_os = "ios"))]
const BUNDLE: &str = "secrets";

pub fn is_secret(key: &str) -> bool {
    KEYS.contains(&key)
}

fn check(key: &str) -> Result<(), AppError> {
    if is_secret(key) {
        Ok(())
    } else {
        Err(AppError::msg(format!("비밀로 다루는 설정이 아니야: {key}")))
    }
}

/// 대화 DB 열쇠의 이름. `KEYS` 밖이라 화면에서 읽거나 바꿀 수 없다 — 바뀌면 DB 를 못 연다.
const DB_KEY: &str = "db_key";

/// 동기화 열쇠·기기 토큰의 이름(crate::sync). `KEYS` 밖이라 화면에서 읽거나 바꿀 수 없다.
const SYNC_NAMES: &[&str] = &["sync_key", "sync_token"];

fn check_sync(name: &str) -> Result<(), AppError> {
    if SYNC_NAMES.contains(&name) { Ok(()) } else { Err(AppError::msg(format!("동기화 비밀 이름이 아니야: {name}"))) }
}

/// 키체인에 적는 이름. dev 빌드는 뒤에 `_dev` 를 붙인다 — dev 와 배포 버전은 DB 가 따로인데(nekodesk-dev) 키체인 이름이
/// 같아서, dev 에서 동기화를 등록하면 배포 버전의 토큰·열쇠를 덮어 그쪽 동기화가 끊겼다. 배포 쪽 이름은 그대로라
/// 이미 등록한 사용자는 영향이 없다.
fn sync_account(name: &str, dev: bool) -> String {
    if dev { format!("{name}_dev") } else { name.to_owned() }
}

// ── 묶음: 이름 → 값. 값 "" 는 지운 것(남은 옛 항목을 다시 옮겨 오지 않게 이름은 둔다) ────────────

type Map = BTreeMap<String, String>;

fn parse_bundle(raw: &str) -> Result<Map, AppError> {
    serde_json::from_str(raw).map_err(|e| AppError::msg(format!("키체인 비밀 묶음을 못 읽었어: {e}")))
}

fn bundle_json(map: &Map) -> String {
    serde_json::to_string(map).unwrap_or_else(|_| "{}".into())
}

/// 이 빌드가 쓰는 이름. 배포는 dev 의 동기화 이름을 옮기지 않는다(dev 를 켤 때 dev 가 옮긴다).
fn names_for(dev: bool) -> Vec<String> {
    KEYS.iter()
        .map(|k| k.to_string())
        .chain([DB_KEY.to_owned()])
        .chain(SYNC_NAMES.iter().map(|n| sync_account(n, dev)))
        .collect()
}

/// 예전 항목(비밀마다 하나)을 읽은 결과
#[derive(Debug, Clone, PartialEq)]
enum Old {
    Missing,
    Found(String),
    /// 읽다 실패(사용자 거부 등). 옛 항목을 그대로 두고 다음에 다시 묻는다
    Denied,
}

/// 묶음에 없는 이름만 예전 항목에서 찾는다. 돌려주는 것: 묶음에 더할 값, 못 읽은 이름.
fn plan_migration(map: &Map, names: &[String], mut old: impl FnMut(&str) -> Old) -> (Map, BTreeSet<String>) {
    let (mut found, mut denied) = (Map::new(), BTreeSet::new());
    for n in names.iter().filter(|n| !map.contains_key(*n)) {
        match old(n) {
            Old::Missing => {}
            Old::Found(v) => {
                found.insert(n.clone(), v.trim().to_owned());
            }
            Old::Denied => {
                denied.insert(n.clone());
            }
        }
    }
    (found, denied)
}

/// 이 실행이 아는 비밀. 키체인은 실행당 한 번 읽는다 — 서명이 바뀌는 dev 빌드(다시 빌드할 때마다 새 바이너리)는
/// 읽을 때마다 macOS 가 물었다. 값은 이 프로세스 메모리에만 있다.
#[derive(Default)]
struct State {
    map: Map,
    /// 예전 항목을 못 읽은 이름 — 쓸 때 다시 묻는다
    denied: BTreeSet<String>,
}

/// 대화 DB 열쇠 판단. None 이면 새로 만들어도 된다. 예전 열쇠가 있는데 못 읽었으면 실패 — 새 열쇠로는
/// 이미 암호화된 DB 를 못 연다.
fn known_db_key(st: &State) -> Option<Result<String, AppError>> {
    if let Some(k) = st.map.get(DB_KEY).filter(|k| !k.is_empty()) {
        return Some(Ok(k.clone()));
    }
    st.denied.contains(DB_KEY).then(|| Err(AppError::msg("키체인에서 DB 열쇠를 못 꺼냈어")))
}

// ── 키체인 ──────────────────────────────────────────────────────────────────

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn keychain_get(service: &str, account: &str) -> Result<Option<String>, AppError> {
    match security_framework::passwords::get_generic_password(service, account) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        // errSecItemNotFound
        Err(e) if e.code() == -25300 => Ok(None),
        Err(e) => Err(AppError::msg(format!("키체인에서 못 꺼냈어: {e}"))),
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn read_bundle(service: &str) -> Result<Option<Map>, AppError> {
    keychain_get(service, BUNDLE)?.map(|raw| parse_bundle(&raw)).transpose()
}

/// 묶음을 새로 읽어 고치고 다시 쓴다. dev·배포가 같은 묶음을 쓰니, 메모리의 것이 아니라 늘 새로 읽은 것에
/// 고친다 — 그 사이 다른 쪽이 넣은 이름(동기화 토큰 등)을 덮지 않게.
/// ponytail: 프로세스 사이 잠금은 없다. 읽고 쓰는 사이(밀리초)에 두 앱이 함께 쓰면 한쪽 변경이 빠질 수 있다.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn update_bundle<T>(service: &str, edit: impl FnOnce(&mut Map) -> T) -> Result<(Map, T), AppError> {
    let mut map = read_bundle(service)?.unwrap_or_default();
    let out = edit(&mut map);
    security_framework::passwords::set_generic_password(service, BUNDLE, bundle_json(&map).as_bytes())
        .map_err(|e| AppError::msg(format!("키체인에 못 넣었어: {e}")))?;
    Ok((map, out))
}

/// 묶음에 없는 이름을 예전 항목에서 옮긴다. 예전 항목은 묶음을 쓴 뒤에만 지운다. 못 쓰면 예전 항목을 두고
/// (다음 실행에 다시) 이번 실행은 읽은 값으로 돈다.
#[cfg(any(target_os = "macos", target_os = "ios"))]
fn adopt(service: &str, st: &mut State, names: &[String]) {
    let (found, denied) = plan_migration(&st.map, names, |n| match keychain_get(service, n) {
        Ok(Some(v)) => Old::Found(v),
        Ok(None) => Old::Missing,
        Err(_) => Old::Denied,
    });
    for n in names {
        st.denied.remove(n);
    }
    st.denied.extend(denied);
    if found.is_empty() {
        return;
    }
    let wrote = update_bundle(service, |m| {
        for (n, v) in &found {
            m.entry(n.clone()).or_insert_with(|| v.clone());
        }
    });
    match wrote {
        Ok((map, ())) => {
            st.map.extend(map);
            for n in found.keys() {
                let _ = security_framework::passwords::delete_generic_password(service, n);
            }
        }
        Err(_) => st.map.extend(found),
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn load(service: &str, names: &[String]) -> Result<State, AppError> {
    // 묶음을 못 읽으면(거부) 실패를 돌려주고 담지 않는다 — 빈 것으로 치면 DB 열쇠를 새로 만들어 버린다.
    let mut st = State { map: read_bundle(service)?.unwrap_or_default(), denied: BTreeSet::new() };
    adopt(service, &mut st, names);
    Ok(st)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn with_state<T>(f: impl FnOnce(&mut State) -> Result<T, AppError>) -> Result<T, AppError> {
    static STATE: std::sync::Mutex<Option<State>> = std::sync::Mutex::new(None);
    let mut g = STATE.lock()?;
    if g.is_none() {
        *g = Some(load(SERVICE, &names_for(cfg!(debug_assertions)))?);
    }
    f(g.as_mut().expect("방금 채웠다"))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn read_name(name: &str) -> Result<Option<String>, AppError> {
    with_state(|st| {
        if st.denied.contains(name) {
            // 옮길 때 못 읽은 예전 항목 — 쓸 때 다시 묻는다(예전처럼)
            adopt(SERVICE, st, &[name.to_owned()]);
            if st.denied.contains(name) {
                return Err(AppError::msg("키체인에서 못 꺼냈어"));
            }
        }
        Ok(st.map.get(name).filter(|v| !v.is_empty()).cloned())
    })
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn write_name(name: &str, value: &str) -> Result<(), AppError> {
    let value = value.trim().to_owned();
    with_state(|st| {
        let (map, ()) = update_bundle(SERVICE, |m| {
            m.insert(name.to_owned(), value);
        })?;
        st.map.extend(map);
        // 새 값이 생겼다 — 묶음에 이름이 있으니 예전 항목은 더 안 본다
        st.denied.remove(name);
        Ok(())
    })
}

/// 꺼낸다. 없으면 None.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn get(key: &str) -> Result<Option<String>, AppError> {
    check(key)?;
    read_name(key)
}

/// 넣는다. 빈 값이면 지운다.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn set(key: &str, value: &str) -> Result<(), AppError> {
    check(key)?;
    write_name(key, value)
}

/// 대화 DB 열쇠(32바이트 hex). 처음이면 만들어 넣는다. 예전 열쇠를 못 꺼냈으면(거부 등) 새로 만들지
/// 않고 실패를 돌려준다 — 새 열쇠로는 이미 암호화된 DB 를 못 연다.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn db_key() -> Result<String, AppError> {
    with_state(|st| {
        if let Some(known) = known_db_key(st) {
            return known;
        }
        let mut buf = [0u8; 32];
        security_framework::random::SecRandom::default()
            .copy_bytes(&mut buf)
            .map_err(|e| AppError::msg(format!("DB 열쇠를 못 만들었어: {e}")))?;
        let made: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        // 그 사이 다른 쪽(dev·배포)이 만들어 넣었으면 그것을 쓴다
        let (map, key) = update_bundle(SERVICE, |m| {
            let k = m.entry(DB_KEY.to_owned()).or_default();
            if k.is_empty() {
                *k = made;
            }
            k.clone()
        })?;
        st.map.extend(map);
        Ok(key)
    })
}

/// 동기화 비밀을 꺼낸다(실행당 한 번만 키체인에 묻는다 — `get` 과 같은 묶음).
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn sync_get(name: &str) -> Result<Option<String>, AppError> {
    check_sync(name)?;
    read_name(&sync_account(name, cfg!(debug_assertions)))
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn sync_set(name: &str, value: &str) -> Result<(), AppError> {
    check_sync(name)?;
    write_name(&sync_account(name, cfg!(debug_assertions)), value)
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn sync_get(name: &str) -> Result<Option<String>, AppError> {
    check_sync(name)?;
    Err(AppError::msg("키체인은 macOS 에서만 쓸 수 있어."))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn sync_set(name: &str, _value: &str) -> Result<(), AppError> {
    check_sync(name)?;
    Err(AppError::msg("키체인은 macOS 에서만 쓸 수 있어."))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn db_key() -> Result<String, AppError> {
    Err(AppError::msg("키체인은 macOS 에서만 쓸 수 있어."))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn get(key: &str) -> Result<Option<String>, AppError> {
    check(key)?;
    Err(AppError::msg("키체인은 macOS 에서만 쓸 수 있어."))
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn set(key: &str, _value: &str) -> Result<(), AppError> {
    check(key)?;
    Err(AppError::msg("키체인은 macOS 에서만 쓸 수 있어."))
}

/// 예전 버전이 settings 표에 적어 둔 비밀을 키체인으로 옮기고 표에서 지운다. 켤 때마다 불러도
/// 된다 — 옮길 게 없으면 아무것도 안 한다. 키체인에 못 넣으면 표에 그대로 둔다(잃지 않게).
pub fn migrate(conn: &Connection) {
    for key in KEYS {
        let Ok(Some(value)) = crate::db::settings::get(conn, key) else { continue };
        if !value.trim().is_empty() && set(key, &value).is_err() {
            continue;
        }
        let _ = conn.execute("DELETE FROM settings WHERE key = ?1", [key]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_listed_names_are_secrets() {
        assert!(is_secret("brave_search_key"));
        assert!(is_secret("google_api_key"));
        assert!(is_secret("anthropic_api_key"));
        assert!(!is_secret("cf_account_id"));
        assert!(!is_secret("memo"));
        assert!(get("memo").is_err());
        // 동기화 비밀은 화면 쪽 이름(KEYS)이 아니다
        assert!(!is_secret("sync_key") && !is_secret("sync_token"));
        assert!(sync_get("db_key").is_err());
        // dev 빌드는 배포 버전의 동기화 토큰·열쇠와 다른 이름을 쓴다. 배포 쪽 이름은 예전 그대로
        assert_eq!(sync_account("sync_token", false), "sync_token");
        assert_eq!(sync_account("sync_token", true), "sync_token_dev");
        assert_ne!(sync_account("sync_key", true), sync_account("sync_key", false));
    }

    #[test]
    fn bundle_round_trip() {
        let map: Map = [("db_key", "ab12"), ("anthropic_api_key", "비밀 \"값\""), ("sync_token", "")]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        assert_eq!(parse_bundle(&bundle_json(&map)).unwrap(), map);
        assert!(parse_bundle("{}").unwrap().is_empty());
        // 깨진 묶음은 빈 것으로 치지 않는다(빈 것으로 치면 DB 열쇠를 새로 만든다)
        assert!(parse_bundle("not json").is_err());
        assert!(parse_bundle("[1]").is_err());
    }

    /// dev 와 배포는 DB 열쇠·API 키를 같이 쓰고, 동기화 이름만 다르다(dev 가 배포의 동기화 토큰을 덮지 않게)
    #[test]
    fn names_keep_dev_split() {
        let (rel, dev) = (names_for(false), names_for(true));
        for shared in ["db_key", "anthropic_api_key", "brave_search_key", "google_api_key", "cf_api_token"] {
            assert!(rel.iter().any(|n| n == shared) && dev.iter().any(|n| n == shared), "{shared}");
        }
        assert!(rel.iter().any(|n| n == "sync_token") && !rel.iter().any(|n| n == "sync_token_dev"));
        assert!(dev.iter().any(|n| n == "sync_token_dev") && !dev.iter().any(|n| n == "sync_token"));
        assert!(dev.iter().any(|n| n == "sync_key_dev") && !dev.iter().any(|n| n == "sync_key"));
    }

    #[test]
    fn migration_plan() {
        let names: Vec<String> = ["db_key", "sync_key", "sync_token", "anthropic_api_key", "brave_search_key"]
            .into_iter()
            .map(String::from)
            .collect();
        // 묶음 없음: 있는 건 옮기고(앞뒤 공백 정리), 없는 건 넘기고, 못 읽은 건 남긴다
        let mut asked = vec![];
        let (found, denied) = plan_migration(&Map::new(), &names, |n| {
            asked.push(n.to_owned());
            match n {
                "db_key" => Old::Found(" k1 ".into()),
                "sync_token" => Old::Found("t".into()),
                "anthropic_api_key" => Old::Denied,
                _ => Old::Missing,
            }
        });
        assert_eq!(asked.len(), names.len());
        assert_eq!(found.get("db_key").map(String::as_str), Some("k1"));
        assert_eq!(found.get("sync_token").map(String::as_str), Some("t"));
        assert_eq!(found.len(), 2);
        assert_eq!(denied.into_iter().collect::<Vec<_>>(), vec!["anthropic_api_key".to_owned()]);

        // 묶음에 이미 있는 이름(지운 것 "" 포함)은 예전 항목을 묻지도 않는다 — 다시 켤 때 묻는 건 묶음 하나뿐
        let have: Map = [("db_key", "k1"), ("sync_token", "t"), ("sync_key", ""), ("anthropic_api_key", "a"), ("brave_search_key", "")]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        let (found, denied) = plan_migration(&have, &names, |n| panic!("묻지 말아야 할 예전 항목: {n}"));
        assert!(found.is_empty() && denied.is_empty());

        // 일부만 있음: 빠진 이름만 다시 시도
        let some: Map = [("db_key".to_owned(), "k1".to_owned())].into_iter().collect();
        let (found, denied) = plan_migration(&some, &names, |n| {
            assert_ne!(n, "db_key");
            if n == "anthropic_api_key" { Old::Found("a".into()) } else { Old::Missing }
        });
        assert_eq!(found.keys().collect::<Vec<_>>(), vec!["anthropic_api_key"]);
        assert!(denied.is_empty());
    }

    #[test]
    fn db_key_never_remade_when_old_unreadable() {
        let mut st = State::default();
        assert!(known_db_key(&st).is_none(), "처음이면 만든다");
        st.denied.insert(DB_KEY.into());
        assert!(matches!(known_db_key(&st), Some(Err(_))), "예전 열쇠를 못 읽었으면 실패");
        st.map.insert(DB_KEY.into(), "k1".into());
        assert_eq!(known_db_key(&st).unwrap().unwrap(), "k1", "묶음에 있으면 그것");
    }

    /// 진짜 키체인으로 옮기기·쓰기를 해 본다(테스트 전용 서비스 이름 — 사용자 항목은 안 건드린다). 키체인이 잠긴
    /// CI 에선 못 돌아 손으로 돌린다: cargo test --lib secrets -- --ignored
    #[test]
    #[ignore]
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn keychain_migration_round_trip() {
        use security_framework::passwords::{delete_generic_password, set_generic_password};
        let service = "com.nekodesk.desktop.test";
        let names: Vec<String> = ["db_key", "sync_token", "anthropic_api_key"].into_iter().map(String::from).collect();
        for n in names.iter().chain([&BUNDLE.to_owned()]) {
            let _ = delete_generic_password(service, n);
        }
        set_generic_password(service, "db_key", b"k1").unwrap();
        set_generic_password(service, "sync_token", b" t ").unwrap();

        // 예전 항목 → 묶음, 예전 항목은 지워진다
        let st = load(service, &names).unwrap();
        assert_eq!(st.map.get("db_key").map(String::as_str), Some("k1"));
        assert_eq!(st.map.get("sync_token").map(String::as_str), Some("t"));
        assert!(!st.map.contains_key("anthropic_api_key") && st.denied.is_empty());
        assert_eq!(keychain_get(service, "db_key").unwrap(), None);
        assert_eq!(keychain_get(service, "sync_token").unwrap(), None);

        // 다시 읽으면 묶음에서. 고치면 다른 이름은 그대로
        update_bundle(service, |m| m.insert("anthropic_api_key".into(), "a".into())).unwrap();
        let st = load(service, &names).unwrap();
        assert_eq!(st.map.get("db_key").map(String::as_str), Some("k1"));
        assert_eq!(st.map.get("anthropic_api_key").map(String::as_str), Some("a"));

        // 묶음에 이름이 있으면 남은 예전 항목을 다시 옮겨 오지 않는다
        set_generic_password(service, "db_key", b"stale").unwrap();
        assert_eq!(load(service, &names).unwrap().map.get("db_key").map(String::as_str), Some("k1"));

        for n in names.iter().chain([&BUNDLE.to_owned()]) {
            let _ = delete_generic_password(service, n);
        }
    }
}
