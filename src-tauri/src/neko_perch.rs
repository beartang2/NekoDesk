//! 마당 캣타워(docs/neko-screen-mode.md §8 2단계 '창 위에 올라앉기'): 다른 앱의 보통 창 윗변을 발판(tops), 옆면을
//! 벽(walls)으로 만들어 화면 창 엔진에 넘긴다(`setPerches`). 창 위치·크기만 쓴다 — 이름·내용은 안 읽어 새 권한이 없다.
//!
//! - 창 목록은 앞에서부터(CGWindowListCopyWindowInfo, 화면에 있는 layer 0). 최소화·다른 Space 창은 목록에 없다.
//! - 발판·벽은 앞 창에 가리지 않은 구간만. 이 앱 창·전체화면 창·작은 창은 발판이 아니다(앞 창으로 가리기는 한다).
//! - 좌표는 고양이가 있는 모니터(화면 창) 왼쪽 위 기준 포인트 = 엔진 세계 좌표.
//!
//! 순수 계산(`perches`)만 여기 있고, 언제 읽고 보낼지는 neko_screen.rs 폴러가 정한다.

use serde::Serialize;

/// 창 하나(전역 좌표 x, y, w, h). `perch`: 발판·벽이 될 수 있는 창(아니면 가리기만 한다).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Win {
    pub id: u32,
    pub rect: [f64; 4],
    pub perch: bool,
}

/// 창 윗변 중 보이는 구간. id = "<창 번호>:t<k>"
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Top {
    pub id: String,
    pub win: u32,
    pub x0: f64,
    pub x1: f64,
    pub y: f64,
}

/// 창 옆면 중 보이는 구간. face: 고양이가 타는 쪽(창 왼쪽 옆면은 "left" — 왼쪽 밖에서 붙는다)
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Wall {
    pub id: String,
    pub win: u32,
    pub x: f64,
    pub y0: f64,
    pub y1: f64,
    pub face: &'static str,
}

/// 엔진 `setPerches` 에 그대로. partial: 그 창(번호) 항목만 갈아 끼운다(올라탄 창을 30Hz 로). 없으면 전체 교체
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
pub struct Perches {
    pub tops: Vec<Top>,
    pub walls: Vec<Wall>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial: Option<u32>,
}

/// 이보다 짧은 발판·벽 조각은 버린다(고양이가 설 수 없다)
const MIN_TOP: f64 = 40.0;
const MIN_WALL: f64 = 40.0;
/// 이보다 작은 창은 발판이 아니다
const MIN_W: f64 = 80.0;
const MIN_H: f64 = 40.0;

/// 구간 [a, b] 에서 가리는 구간들을 뺀 나머지(차례대로)
fn visible(a: f64, b: f64, covers: impl Iterator<Item = (f64, f64)>) -> Vec<(f64, f64)> {
    let mut out = vec![(a, b)];
    for (c0, c1) in covers {
        out = out
            .into_iter()
            .flat_map(|(s, e)| {
                if c1 <= s || c0 >= e {
                    vec![(s, e)]
                } else {
                    [(s, c0.min(e)), (c1.max(s), e)].into_iter().filter(|(p, q)| q > p).collect()
                }
            })
            .collect();
    }
    out
}

/// 창이 그 모니터 전체를 덮는가(전체화면)
fn full(r: [f64; 4], m: [f64; 4]) -> bool {
    r[0] <= m[0] + 0.5 && r[1] <= m[1] + 0.5 && r[0] + r[2] >= m[0] + m[2] - 0.5 && r[1] + r[3] >= m[1] + m[3] - 0.5
}

/// 앞에서부터 놓인 창들(`wins`)로 모니터 `mon`(전역 x, y, w, h)의 발판·벽. `ground` 는 화면 창 좌표의 바닥(이보다 아래는
/// 안 쓴다). `only`: 그 창 것만(올라탄 창 30Hz 갱신, 가리기는 다른 창 그대로)
pub fn perches(wins: &[Win], mon: [f64; 4], ground: f64, only: Option<u32>) -> Perches {
    let [mx, my, mw, _] = mon;
    let mut p = Perches { partial: only, ..Default::default() };
    for (i, w) in wins.iter().enumerate() {
        let [x, y, ww, h] = w.rect;
        if !w.perch || only.is_some_and(|o| o != w.id) || ww < MIN_W || h < MIN_H || full(w.rect, mon) {
            continue;
        }
        let front = &wins[..i];
        // 윗변: 그 높이를 앞 창이 덮는 구간을 빼고, 모니터 폭 안으로
        let (top, bottom) = (y - my, ground);
        if top > 0.0 && top < bottom {
            let covers = front.iter().filter(|o| o.rect[1] <= y && o.rect[1] + o.rect[3] > y).map(|o| (o.rect[0], o.rect[0] + o.rect[2]));
            for (k, (a, b)) in visible(x.max(mx), (x + ww).min(mx + mw), covers).into_iter().filter(|(a, b)| b - a >= MIN_TOP).enumerate() {
                p.tops.push(Top { id: format!("{}:t{k}", w.id), win: w.id, x0: a - mx, x1: b - mx, y: top });
            }
        }
        // 옆면: 그 x 를 앞 창이 덮는 높이를 빼고, 모니터 위 끝 ~ 바닥 사이로
        for (face, ex) in [("left", x), ("right", x + ww)] {
            if ex <= mx || ex >= mx + mw {
                continue;
            }
            let covers = front.iter().filter(|o| o.rect[0] <= ex && o.rect[0] + o.rect[2] >= ex).map(|o| (o.rect[1], o.rect[1] + o.rect[3]));
            let (a, b) = (y.max(my), (y + h).min(my + ground));
            for (k, (s, e)) in visible(a, b, covers).into_iter().filter(|(s, e)| e - s >= MIN_WALL).enumerate() {
                let tag = if face == "left" { 'l' } else { 'r' };
                p.walls.push(Wall { id: format!("{}:{tag}{k}", w.id), win: w.id, x: ex - mx, y0: s - my, y1: e - my, face });
            }
        }
    }
    p
}

pub(crate) mod macos {
    use crate::quick::macos::ns_string;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::ffi::{c_void, CStr};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }
    /// kCGWindowListOptionIncludingWindow: 그 창 하나만
    const INCLUDING_WINDOW: u32 = 1 << 3;

    unsafe fn num(dict: *mut AnyObject, key: &CStr) -> Option<f64> {
        let v: *mut AnyObject = msg_send![dict, objectForKey: ns_string(key)];
        (!v.is_null()).then(|| msg_send![v, doubleValue])
    }

    /// 창 하나의 자리(전역 x, y, w, h). 닫혔거나 화면에 없으면(최소화·다른 Space) None. 아무 스레드에서나.
    pub unsafe fn window_rect(id: u32) -> Option<[f64; 4]> {
        let list = CGWindowListCopyWindowInfo(INCLUDING_WINDOW, id);
        if list.is_null() {
            return None;
        }
        let array = list as *mut AnyObject;
        let count: usize = msg_send![array, count];
        let out = (count > 0)
            .then(|| {
                let info: *mut AnyObject = msg_send![array, objectAtIndex: 0usize];
                let bounds: *mut AnyObject = msg_send![info, objectForKey: ns_string(c"kCGWindowBounds")];
                if num(info, c"kCGWindowIsOnscreen").unwrap_or(1.0) == 0.0 || bounds.is_null() {
                    return None;
                }
                Some([num(bounds, c"X")?, num(bounds, c"Y")?, num(bounds, c"Width")?, num(bounds, c"Height")?])
            })
            .flatten();
        CFRelease(list);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MON: [f64; 4] = [0.0, 0.0, 1512.0, 982.0];
    const W: fn(u32, [f64; 4]) -> Win = |id, rect| Win { id, rect, perch: true };

    #[test]
    fn a_lone_window_gives_its_top_and_both_sides() {
        let p = perches(&[W(7, [100.0, 300.0, 600.0, 400.0])], MON, 912.0, None);
        assert_eq!(p.tops, [Top { id: "7:t0".into(), win: 7, x0: 100.0, x1: 700.0, y: 300.0 }]);
        assert_eq!(p.walls.iter().map(|w| (w.face, w.x, w.y0, w.y1)).collect::<Vec<_>>(), [("left", 100.0, 300.0, 700.0), ("right", 700.0, 300.0, 700.0)]);
        assert_eq!(p.partial, None);
    }

    #[test]
    fn front_windows_cut_tops_and_sides() {
        // 앞 창(9)이 뒤 창(7) 윗변 가운데와 오른쪽 옆면 위쪽을 덮는다
        let front = W(9, [300.0, 200.0, 500.0, 300.0]);
        let back = W(7, [100.0, 300.0, 600.0, 400.0]);
        let p = perches(&[front, back], MON, 912.0, None);
        let tops: Vec<_> = p.tops.iter().filter(|t| t.win == 7).map(|t| (t.id.as_str(), t.x0, t.x1)).collect();
        assert_eq!(tops, [("7:t0", 100.0, 300.0)]); // 300~700 은 가렸다(700 끝은 앞 창 오른쪽 800 안)
        let right: Vec<_> = p.walls.iter().filter(|w| w.win == 7 && w.face == "right").map(|w| (w.y0, w.y1)).collect();
        assert_eq!(right, [(500.0, 700.0)]); // 300~500 은 앞 창 안
        // 앞 창은 다 보인다
        assert_eq!(p.tops.iter().filter(|t| t.win == 9).count(), 1);
    }

    #[test]
    fn skips_own_full_tiny_and_offscreen_parts() {
        let own = Win { id: 1, rect: [100.0, 300.0, 600.0, 400.0], perch: false };
        let full = W(2, MON);
        let tiny = W(3, [10.0, 10.0, 60.0, 30.0]);
        // 다른 모니터에 걸친 창: 이 모니터 안 부분만, 좌표는 모니터 기준
        let wide = W(4, [1300.0, 500.0, 800.0, 300.0]);
        let p = perches(&[own, tiny, wide], MON, 912.0, None);
        assert!(p.tops.iter().all(|t| t.win == 4) && p.walls.iter().all(|w| w.win == 4));
        assert_eq!((p.tops[0].x0, p.tops[0].x1), (1300.0, 1512.0));
        assert_eq!(p.walls.iter().map(|w| w.face).collect::<Vec<_>>(), ["left"]); // 오른쪽 옆면은 모니터 밖
        assert!(perches(&[full], MON, 912.0, None).tops.is_empty());
        // 이 앱 창은 발판은 아니어도 뒤 창을 가린다
        let back = W(5, [50.0, 300.0, 800.0, 400.0]);
        assert_eq!(perches(&[own, back], MON, 912.0, None).tops.iter().map(|t| (t.x0, t.x1)).collect::<Vec<_>>(), [(50.0, 100.0), (700.0, 850.0)]);
    }

    #[test]
    fn walls_stop_at_the_floor_and_tops_below_it_are_dropped() {
        let p = perches(&[W(7, [100.0, 700.0, 300.0, 400.0])], MON, 912.0, None);
        assert_eq!(p.walls[0].y1, 912.0);
        assert!(perches(&[W(8, [100.0, 950.0, 300.0, 200.0])], MON, 912.0, None).tops.is_empty());
    }

    #[test]
    fn a_monitor_off_the_origin_uses_its_own_coords_and_partial_keeps_one_window() {
        let right = [1512.0, -96.0, 1920.0, 1080.0];
        let a = W(7, [1612.0, 104.0, 400.0, 300.0]);
        let b = W(8, [2000.0, 404.0, 400.0, 300.0]);
        let p = perches(&[a, b], right, 1000.0, Some(8));
        assert_eq!(p.partial, Some(8));
        assert_eq!(p.tops.iter().map(|t| (t.win, t.x0, t.y)).collect::<Vec<_>>(), [(8, 488.0, 500.0)]);
        assert!(p.walls.iter().all(|w| w.win == 8));
    }
}


