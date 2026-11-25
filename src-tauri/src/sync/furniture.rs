//! 네코의 가구(설정 neko_furniture, src/neko/furniture.ts)는 받을 때 가구 하나씩 합친다.
//!
//! 설정은 값 하나를 통째로 덮어써 나중에 쓴 쪽이 이긴다. 가구는 두 기기가 따로 놓고 치우고 물어오니, 그러면 한쪽 바꿈이
//! 사라지고 진 쪽이 다시 쓰지 않으면 기기마다 다른 값으로 남았다(폰에서 놓은 가구가 맥엔 없음). 그래서 받을 때마다(내 값이 더
//! 새것이어도) 가구마다 바꾼 때(at)가 나중인 것을, 물어온 가구는 버린 때(gone)가 더 나중이면 버린 것을 고른다. 합친 값이 받은
//! 값과 다르면 다시 올려 다른 기기도 같은 값이 된다.
//!
//! 옛 버전(0.1.25 까지, v 1)이 쓴 값엔 at 이 없다: 그 기록 시각에 그 기기가 값 전체를 정한 것이라, 적힌 가구는 그 시각,
//! 안 적힌 기본 가구(놓이지 않은 것은 적지 않았다)는 그 시각에 치운 것으로 본다. 이 기기에 남은 옛 값은 화면이 v 2 로 다시
//! 적기 전이라 아주 오래된 것(1)으로 본다 — 화면이 바꿀 때와 같다.

use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const KEY: &str = "neko_furniture";

#[derive(Default)]
struct Furn {
    items: BTreeMap<String, Value>,
    gone: BTreeMap<String, i64>,
}

fn at(v: &Value) -> i64 {
    v.get("at").and_then(Value::as_i64).unwrap_or(0)
}

/// 값 → 가구(번호별, at 을 채운다)·버린 때. 옛 값이면 Some(at 없는 가구에 줄 시각)
fn read(raw: Option<&str>, old_at: i64) -> (Furn, bool) {
    let v: Value = raw.and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null);
    let legacy = v.is_object() && v.get("v").and_then(Value::as_i64) != Some(2);
    let mut f = Furn::default();
    for it in v.get("items").and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = it.get("id").and_then(Value::as_str) else { continue };
        let mut it = it.clone();
        if !it.get("at").is_some_and(Value::is_i64) {
            it["at"] = json!(old_at);
        }
        f.items.insert(id.to_owned(), it);
    }
    if let Some(g) = v.get("gone").and_then(Value::as_object) {
        f.gone = g.iter().filter_map(|(k, t)| Some((k.clone(), t.as_i64()?))).collect();
    }
    (f, legacy)
}

/// 둘을 합친다: 가구마다 at 이 나중인 쪽(같으면 글로 견줘 어느 기기에서나 같게), 버린 때는 늦은 것, 버린 뒤 바뀌지 않은 가구는 뺀다
fn merge(a: &Furn, b: &Furn) -> Furn {
    let mut out = Furn { items: BTreeMap::new(), gone: a.gone.clone() };
    for (k, t) in &b.gone {
        let e = out.gone.entry(k.clone()).or_insert(*t);
        *e = (*e).max(*t);
    }
    for (id, x) in a.items.iter().chain(&b.items) {
        let newer = out.items.get(id).map_or(true, |y| (at(x), x.to_string()) > (at(y), y.to_string()));
        if newer {
            out.items.insert(id.clone(), x.clone());
        }
    }
    let gone = out.gone.clone();
    out.items.retain(|id, x| gone.get(id).map_or(true, |g| at(x) > *g));
    out
}

fn same(a: &Furn, b: &Furn) -> bool {
    a.items == b.items && a.gone == b.gone
}

fn write(f: &Furn) -> String {
    json!({ "v": 2, "items": f.items.values().collect::<Vec<_>>(), "gone": f.gone }).to_string()
}

/// 받은 가구 값(remote, 기록 시각 remote_ts)을 이 기기 값과 합친다.
/// (이 기기에 적을 값 — 바뀔 때만, 받은 값에 없는 것이 있어 다시 올려야 하나)
pub fn merge_values(local: Option<&str>, remote: &str, remote_ts: i64) -> (Option<String>, bool) {
    let (mine, _) = read(local, 1);
    let (mut theirs, legacy) = read(Some(remote), remote_ts);
    if legacy {
        // 옛 버전은 놓인 기본 가구만 적는다: 안 적힌 기본 가구는 그때 치운 것
        for (id, it) in &mine.items {
            if id.starts_with("base:") && !theirs.items.contains_key(id) {
                let mut it = it.clone();
                it["place"] = Value::Null;
                it["at"] = json!(remote_ts);
                theirs.items.insert(id.clone(), it);
            }
        }
    }
    let merged = merge(&mine, &theirs);
    let changed = !same(&merged, &mine) || local.is_none();
    (changed.then(|| write(&merged)), !same(&merged, &theirs))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn val(items: Value, gone: Value) -> String {
        json!({ "v": 2, "items": items, "gone": gone }).to_string()
    }
    fn places(raw: &str) -> Vec<(String, Value)> {
        let v: Value = serde_json::from_str(raw).unwrap();
        v["items"].as_array().unwrap().iter().map(|i| (i["id"].as_str().unwrap().to_owned(), i["place"].clone())).collect()
    }
    const DOCK0: &str = r#"{"at":"dock","slot":0}"#;

    #[test]
    fn two_devices_changes_both_survive() {
        let dock0: Value = serde_json::from_str(DOCK0).unwrap();
        // 폰: 소파를 놓았다(10). 맥: 그걸 모르고 산책에서 의자를 물어왔다(20)
        let phone = val(json!([{ "id": "base:sofa", "kind": "sofa", "place": dock0, "at": 10 }]), json!({}));
        let mac = val(json!([{ "id": "walk:a", "kind": "sofa", "place": null, "at": 20 }]), json!({}));
        // 폰이 맥 값을 받는다: 둘 다 남기고, 맥 값엔 소파가 없으니 다시 올린다
        let (mine, upload) = merge_values(Some(&phone), &mac, 20);
        let merged = mine.unwrap();
        assert!(upload);
        assert_eq!(places(&merged), [("base:sofa".into(), dock0.clone()), ("walk:a".into(), Value::Null)]);
        // 맥이 합친 값을 받는다: 더 올릴 것 없이 같은 값
        let (mac_now, upload) = merge_values(Some(&mac), &merged, 30);
        assert!(!upload);
        assert_eq!(places(&mac_now.unwrap()), places(&merged));
        // 같은 가구는 나중 바꿈: 맥이 소파를 치웠다(40)
        let mac2 = val(json!([{ "id": "base:sofa", "kind": "sofa", "place": null, "at": 40 }, { "id": "walk:a", "kind": "sofa", "place": null, "at": 20 }]), json!({}));
        let (p, upload) = merge_values(Some(&merged), &mac2, 40);
        assert!(!upload);
        assert_eq!(places(&p.unwrap())[0].1, Value::Null);
        // 내 값이 이미 다 갖고 있으면 아무것도 안 적는다
        assert_eq!(merge_values(Some(&mac2), &merged, 30), (None, true));
    }

    #[test]
    fn lamp_on_follows_the_later_change() {
        // 조명 켜짐은 항목 안의 칸(lamp, 0.1.33): 켜고 끌 때 at 을 바꾸니 나중 것이 통째로 이긴다
        let dock0: Value = serde_json::from_str(DOCK0).unwrap();
        let lamp = |v: &str| serde_json::from_str::<Value>(v).unwrap()["items"][0]["lamp"].clone();
        let off = val(json!([{ "id": "base:lamp", "kind": "lamp", "place": dock0, "at": 10 }]), json!({}));
        let on = val(json!([{ "id": "base:lamp", "kind": "lamp", "place": dock0, "lamp": true, "at": 20 }]), json!({}));
        // 폰(꺼짐 10)이 맥이 켠 값(20)을 받는다: 켜진다, 다시 올릴 것 없다
        let (got, upload) = merge_values(Some(&off), &on, 20);
        assert_eq!(lamp(&got.unwrap()), json!(true));
        assert!(!upload);
        // 맥(켜짐 20)이 폰의 옛 꺼짐(10)을 받는다: 켜진 채, 폰이 모르니 다시 올린다
        assert_eq!(merge_values(Some(&on), &off, 10), (None, true));
        // 나중에 끈 값(30)은 켜짐을 이긴다
        let off2 = val(json!([{ "id": "base:lamp", "kind": "lamp", "place": dock0, "at": 30 }]), json!({}));
        let (got, _) = merge_values(Some(&on), &off2, 30);
        assert_eq!(lamp(&got.unwrap()), Value::Null);
    }

    #[test]
    fn dropped_furniture_stays_dropped_unless_changed_later() {
        let phone = val(json!([{ "id": "walk:a", "kind": "box", "place": null, "at": 5 }]), json!({}));
        let mac = val(json!([]), json!({ "walk:a": 9 }));
        let (got, upload) = merge_values(Some(&phone), &mac, 9);
        assert!(places(&got.unwrap()).is_empty());
        assert!(!upload);
    }

    #[test]
    fn free_furniture_survives_old_version_rewrites() {
        // 자유 가구(0.1.28, kind "free" — docs/neko-furniture-free.md §10): 옛 화면(0.1.27 까지)은 모르는 kind 라 빼고 읽고, 다른 가구를 바꾸며
        // 값을 다시 쓸 때 그 항목 없이 쓴다(버린 때 gone 도 안 적는다). 받는 쪽은 가구 하나씩 합쳐 자유 가구와 그 모양·쓰임새를 그대로 남긴다
        let dock0: Value = serde_json::from_str(DOCK0).unwrap();
        let free = json!({ "id": "walk:f", "kind": "free", "title": "걸상", "shape": { "v": 1, "parts": [] },
            "uses": [{ "u": "perch", "y": -11, "x0": -11.5, "x1": 11.5 }], "place": { "at": "dock", "slot": 1 }, "at": 10 });
        let new_device = val(json!([free.clone()]), json!({}));
        let old_device = val(json!([{ "id": "base:sofa", "kind": "sofa", "place": dock0, "at": 20 }]), json!({}));
        let (got, upload) = merge_values(Some(&new_device), &old_device, 20);
        let got: Value = serde_json::from_str(&got.unwrap()).unwrap();
        assert!(upload, "옛 기기 값엔 자유 가구가 없다 — 다시 올린다");
        let kept = got["items"].as_array().unwrap().iter().find(|i| i["id"] == "walk:f").unwrap();
        assert_eq!(kept, &free, "모양·쓰임새·자리가 한 글자도 안 바뀐다");
        // 옛 기기가 합친 값을 받으면(Rust 는 옛 버전에도 0.1.26 부터 같다) 자유 가구 항목을 글 그대로 들고 있다
        let (old_now, _) = merge_values(Some(&old_device), &got.to_string(), 30);
        assert!(old_now.unwrap().contains("\"kind\":\"free\""));
    }

    #[test]
    fn old_version_values() {
        let dock0: Value = serde_json::from_str(DOCK0).unwrap();
        // 이 기기의 옛 값(1)은 받은 새 바꿈에 진다. 받은 옛 값(0.1.25 맥)은 기록 시각에 그 전체 — 안 적힌 기본 가구는 치운 것
        let old_mine = json!({ "v": 1, "items": [{ "id": "base:lamp", "kind": "lamp", "place": dock0 }, { "id": "walk:b", "kind": "box", "place": null }] }).to_string();
        let old_mac = json!({ "v": 1, "items": [{ "id": "base:sofa", "kind": "sofa", "place": dock0 }] }).to_string();
        let (got, upload) = merge_values(Some(&old_mine), &old_mac, 50);
        let got = got.unwrap();
        assert!(upload, "옛 맥 값엔 물어온 상자가 없다");
        let p = places(&got);
        assert_eq!(p.iter().find(|x| x.0 == "base:lamp").unwrap().1, Value::Null);
        assert_eq!(p.iter().find(|x| x.0 == "base:sofa").unwrap().1, dock0);
        assert!(p.iter().any(|x| x.0 == "walk:b"), "모르는 물어온 가구는 남긴다");
        // 이 기기에 값이 없으면 받은 것 그대로(다시 올리지 않는다)
        let (got, upload) = merge_values(None, &old_mac, 50);
        assert!(got.is_some() && !upload);
    }
}
