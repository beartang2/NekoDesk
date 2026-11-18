//! 네코 '모니터 화면' 자리(docs/neko-screen-mode.md). 고양이가 있는 모니터 전체를 덮는 투명 창 하나에
//! 네코가 산다. 평소엔 클릭이 뒤로 지나가고, 고양이 위에서만 받는다.
//!
//! - 창: 키 창이 못 되는 패널이다 — 고양이를 눌러도 치던 앱의 키보드를 뺏지 않는다. 패널로 바꾼
//!   창은 닫으면 앱이 죽어서(capture.rs 머리말) 숨기기만 한다.
//! - 커서: 폴러가 33ms 마다 읽어 화면 창에 보낸다(`neko-screen-cursor`). 고양이 위인지는 화면 창이
//!   엔진 hit 로 보고 `neko_screen_catch` 로 알린다. 클릭 통과는 여기서만 바꾼다(`wants_clicks`).
//! - 2초마다: 모니터 목록과 바닥(Dock 위), 잠금·잠자기·화면 보호기, 전체화면 영상.
//! - 여러 모니터(§8 3단계): 창은 하나다. 고양이를 잡고 다른 모니터로 끌거나, 커서가 다른 모니터에
//!   한동안 있어 고양이가 걸어 나가면 창을 그 모니터로 옮기고 세계를 옮기라고 알린다(`neko-screen-moved`).
//!
//! - 마당 선물(§8-1): 모니터마다(고양이가 있는 모니터도) 선물 창 하나가 그 모니터의 선물을 그리고 직접 받는다
//!   (끌기·'정리'). 선물 창은 그린 선물 칸을 알려 두고(`neko_decor_boxes`), 커서가 그 안일 때만 클릭을 받는다.
//!   고양이 창이 같은 모니터의 선물 창보다 한 층 위다.
//!
//! 전역 좌표는 포인트, 주 모니터 왼쪽 위가 0,0(capture.rs 와 같다). 화면 창에 보내는 좌표는 창(=고양이가
//! 있는 모니터) 왼쪽 위 기준이다.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::capture::on_main;
use crate::error::AppError;
use crate::neko_perch::{perches, Perches, Win};

const LABEL: &str = "neko-screen";
/// 커서를 읽는 간격(초당 30번). capture.rs 의 FOLLOW_EVERY 와 같다.
const TICK: Duration = Duration::from_millis(33);
/// 이만큼(TICK 의 배수, 2초)마다 화면 크기·멈춤·전체화면 영상을 본다.
const SLOW_TICKS: u32 = 60;
/// 멈췄거나 숨긴 동안은 커서를 안 읽고 이 간격으로 멈춤 조건만 본다.
const SLOW: Duration = Duration::from_secs(2);
/// 화면 창이 '고양이 위'라고 마지막으로 알린 뒤 이만큼 지나면 클릭을 다시 흘린다. 화면 창이
/// 굳거나 죽어도 0.25초 안에 다른 앱 클릭이 돌아온다. 화면 창은 고양이 위에 있는 동안 0.1초마다 알린다.
const CATCH_TTL: Duration = Duration::from_millis(250);
/// 커서가 다른 모니터에 이만큼 있으면 고양이를 그쪽으로 걸어 보낸다(잠깐 다녀오는 건 따라가지 않게).
const AWAY_AFTER: Duration = Duration::from_secs(3);
/// 창을 옮기며 숨긴 뒤 화면 창이 다시 보이라고 하지 않아도 이만큼 지나면 보인다.
const REVEAL_AFTER: Duration = Duration::from_millis(500);
/// 캣타워(neko_perch.rs): 고양이가 창 근처면 이 간격으로 창 목록을 다시 읽는다(한 번 ≈ 2ms). 멀면 PERCH_FAR.
const PERCH_NEAR: Duration = Duration::from_millis(500);
const PERCH_FAR: Duration = Duration::from_secs(2);
/// 고양이(화면 창이 알린 자리)가 창에서 이만큼(pt) 안이면 '근처'
const NEAR_PT: f64 = 300.0;

/// 화면 창이 처음과 바뀔 때 받는 판 크기와 바닥(엔진 세계 좌표).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
pub struct Layout {
    pub w: f64,
    pub h: f64,
    /// 고양이가 서는 높이. visibleFrame 의 바닥, 곧 Dock 바로 위.
    pub ground: f64,
}

/// 모니터 하나. `rect` 는 전역 좌표(x, y, w, h), `cocoa` 는 AppKit 좌표(왼쪽 아래 원점, 창 옮길 때).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Screen {
    /// 모니터 UUID(CGDisplayCreateUUIDFromDisplayID). 재부팅·포트를 바꿔도 같다 — 마당 선물이 놓인 모니터를 이걸로 적는다.
    pub id: [u8; 16],
    pub rect: [f64; 4],
    pub cocoa: [f64; 4],
    pub layout: Layout,
}

/// 모니터 UUID 를 글자로(8-4-4-4-12).
fn uuid_str(b: &[u8; 16]) -> String {
    let h: String = b.iter().map(|x| format!("{x:02X}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// 마당 선물 창 라벨 앞말. 모니터마다 하나, 뒤는 그 모니터 UUID — 고양이가 건너가도 창은 제 모니터에 그대로다.
const DECOR: &str = "neko-decor-";

fn decor_label(id: &[u8; 16]) -> String {
    format!("{DECOR}{}", uuid_str(id))
}

/// 메인 창에 알리는 모니터 목록(`neko-screens`). 메인 창이 모니터마다 선물을 골라 엔진과 선물 창에 넘긴다.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Screens {
    screens: Vec<ScreenInfo>,
    /// 주 모니터. 놓인 모니터가 빠진 선물은 여기 보인다
    main: String,
    /// 고양이(화면 창)가 있는 모니터
    cat: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
struct ScreenInfo {
    id: String,
    layout: Layout,
    /// 이 모니터를 맡은 선물 창 라벨
    decor: String,
}

fn screens_info(screens: &[Screen], cat: Option<&Screen>) -> Screens {
    let list = screens.iter().map(|s| ScreenInfo { id: uuid_str(&s.id), layout: s.layout, decor: decor_label(&s.id) }).collect();
    Screens { screens: list, main: screens.first().map(|s| uuid_str(&s.id)).unwrap_or_default(), cat: cat.map(|c| uuid_str(&c.id)) }
}

/// 끌던 마당 선물이 다른 모니터 위에 있다(`neko-screen-elsewhere`). x, y 는 그 모니터 왼쪽 위 기준.
#[derive(Serialize, Clone, Debug, PartialEq)]
struct Elsewhere {
    screen: String,
    x: f64,
    y: f64,
}

/// 고양이가 걸어 나가는 쪽.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
}

/// 창을 다른 모니터로 옮겼다. 화면 창은 엔진 세계를 shift 만큼 옮기고 새 바닥을 준 뒤 `neko_screen_reveal`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
struct Moved {
    layout: Layout,
    shift: [f64; 2],
}

struct State {
    /// 설정이 화면 자리고 산책 중이 아니다(메인 창이 정한다).
    on: bool,
    on_top: bool,
    /// 네코 캡처 중이라 숨김.
    capture: bool,
    /// 전체화면 영상·발표라 숨김.
    video: bool,
    /// 사용자가 고양이 메뉴로 숨겼다. 이 앱이 맨 앞으로 오면 다시 보인다(`unhide`). 껐다 켜면 풀린다.
    user_hidden: bool,
    /// 숨긴 뒤 마지막으로 본 '맨 앞 앱이 이 앱'. 다른 앱 → 이 앱으로 바뀌는 순간에만 다시 보인다.
    front_own: Option<bool>,
    /// 잠금·사용자 전환·디스플레이 잠자기·화면 보호기.
    asleep: bool,
    /// 마지막으로 화면 창에 알린 '움직여도 된다'.
    active: Option<bool>,
    layout: Option<Layout>,
    /// 마지막으로 읽은 모니터 목록. 0번이 주 모니터.
    screens: Vec<Screen>,
    /// 창이 붙은 모니터(`Screen::rect`). 그 모니터가 없어지면 주 모니터로.
    at: Option<[f64; 4]>,
    /// 커서가 있는 다른 모니터와 거기 간 때.
    away: Option<(Screen, Instant)>,
    /// 창을 옮기며 숨긴 때(alpha 0). 화면 창이 세계를 옮기고 다시 그리면 보인다.
    hidden_at: Option<Instant>,
    catch_at: Option<Instant>,
    /// 지금 클릭을 받는 중(ignoresMouseEvents = NO).
    catching: bool,
    /// 받는 중에 눌렀다 — 놓을 때까지 화면 어디서든 받는다(목덜미 잡고 끌기).
    grabbing: bool,
    /// 화면 창이 마지막으로 알린 게 고양이 위였다(아니면 마당 선물·메뉴).
    catch_cat: bool,
    /// 잡은 게 고양이다. 고양이를 잡고 끌 때만 창이 다른 모니터로 따라간다.
    grab_cat: bool,
    /// 잡힌 고양이 목덜미(창 좌표)와 알린 때(`neko_screen_held`). 빠르게 끌면 고양이가 커서보다 한참 뒤라, 창은 커서가
    /// 아니라 이게 다른 모니터에 들어갈 때 옮긴다.
    held: Option<([f64; 2], Instant)>,
    /// 마지막으로 본 왼쪽 버튼. 누르는 순간 그 누름을 안 받은 창은 띄운 메뉴를 닫는다(`neko-screen-press-out`).
    was_down: bool,
    /// 선물 창마다 그린 선물 칸(창 좌표 x, y, w, h — '정리' 버튼 포함). 커서가 이 안이면 그 창이 클릭을 받는다.
    boxes: Vec<(String, Vec<[f64; 4]>)>,
    /// 클릭을 받는 선물 창.
    decor_catching: Option<String>,
    /// 선물을 잡고 끄는 선물 창. 놓을 때까지 받는다.
    decor_grab: Option<String>,
    /// 마지막으로 알린 끌던 선물의 다른 모니터 자리.
    elsewhere: Option<Elsewhere>,
    /// 마지막으로 메인 창에 알린 모니터 목록.
    screens_sent: Option<Screens>,
    /// 캣타워: 마지막으로 읽은 보통 창들(앞에서부터)과 그때.
    wins: Vec<Win>,
    perch_at: Option<Instant>,
    /// 마지막으로 화면 창에 보낸 발판·벽(올라탄 창 갱신을 합친 것).
    perches_sent: Option<Perches>,
    /// 화면 창이 알린 고양이 자리(창 좌표)와 올라탄 창 번호. 올라탄 창은 30Hz 로 따라 읽는다.
    cat_at: Option<[f64; 2]>,
    perch_win: Option<u32>,
    poller: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    on: false,
    on_top: true,
    capture: false,
    video: false,
    user_hidden: false,
    front_own: None,
    asleep: false,
    active: None,
    layout: None,
    screens: Vec::new(),
    at: None,
    away: None,
    hidden_at: None,
    catch_at: None,
    catching: false,
    grabbing: false,
    catch_cat: false,
    grab_cat: false,
    held: None,
    was_down: false,
    boxes: Vec::new(),
    decor_catching: None,
    decor_grab: None,
    elsewhere: None,
    screens_sent: None,
    wins: Vec::new(),
    perch_at: None,
    perches_sent: None,
    cat_at: None,
    perch_win: None,
    poller: false,
});

/// 클릭을 받을지. 잡고 끄는 중이면 무조건 받는다. 아니면 화면 창이 방금(CATCH_TTL 안에) '고양이
/// 위'라고 했고, 커서가 이 화면에 있고, ⌥ 를 안 눌렀고, 버튼을 누른 채 들어온 게 아닐 때만 —
/// 다른 앱에서 창이나 글을 끌다가 고양이 위를 지나가도 끊기지 않게.
fn wants_clicks(grabbing: bool, fresh: bool, on_screen: bool, option: bool, down: bool) -> bool {
    grabbing || (fresh && on_screen && !option && !down)
}

/// 클릭을 받을 선물 창. 끄는 중이면 그 창, 아니면 커서 밑에 선물이 있는 창 — 고양이 창이 받는 중이 아니고
/// ⌥ 를 안 눌렀고 버튼을 누른 채 들어온 게 아닐 때(`wants_clicks` 와 같은 안전장치).
fn decor_target(grab: Option<String>, hover: Option<String>, cat_catching: bool, option: bool, down: bool) -> Option<String> {
    grab.or(hover.filter(|_| !cat_catching && !option && !down))
}

/// 선물 창 잡기: 누른 순간 받던 창이 잡고, 놓으면 끝.
fn decor_grab_step(down: bool, grab: Option<String>, catching: Option<String>) -> Option<String> {
    if down {
        grab.or(catching)
    } else {
        None
    }
}

/// 선물 창이 그린 선물 칸을 알린다(그릴 때마다).
pub fn set_boxes(label: &str, boxes: Vec<[f64; 4]>) -> Result<(), AppError> {
    if !label.starts_with(DECOR) {
        return Ok(());
    }
    let mut st = STATE.lock()?;
    st.boxes.retain(|(l, _)| l != label);
    st.boxes.push((label.to_string(), boxes));
    Ok(())
}

/// 주 모니터 frame·visibleFrame(AppKit 좌표, 왼쪽 아래 원점)으로 판과 바닥을 낸다.
fn layout_of(frame: [f64; 4], visible: [f64; 4]) -> Layout {
    let [_, fy, _, fh] = frame;
    let [_, vy, _, _] = visible;
    Layout { w: frame[2], h: fh, ground: fh - (vy - fy) }
}

/// 맨 앞 창이 그 모니터 전체를 덮는가(전체화면 앱). 둘 다 전역 좌표.
fn covers(win: &crate::capture::Rect, s: [f64; 4]) -> bool {
    win.x <= s[0] + 0.5 && win.y <= s[1] + 0.5 && win.x + win.w >= s[0] + s[2] - 0.5 && win.y + win.h >= s[1] + s[3] - 0.5
}

/// AppKit 좌표(왼쪽 아래 원점, 위로 +)를 전역 좌표(주 모니터 왼쪽 위 원점, 아래로 +)로.
fn flip(cocoa: [f64; 4], main_top: f64) -> [f64; 4] {
    [cocoa[0], main_top - (cocoa[1] + cocoa[3]), cocoa[2], cocoa[3]]
}

fn inside(r: [f64; 4], p: [f64; 2]) -> bool {
    p[0] >= r[0] && p[1] >= r[1] && p[0] < r[0] + r[2] && p[1] < r[1] + r[3]
}

/// `to` 가 `from` 의 어느 쪽인가. 위아래로 놓였으면(가운데가 같으면) 오른쪽으로 나간다.
fn side_of(from: [f64; 4], to: [f64; 4]) -> Side {
    if to[0] + to[2] / 2.0 < from[0] + from[2] / 2.0 {
        Side::Left
    } else {
        Side::Right
    }
}

/// 걸어서 건너갈 때 세계를 옮길 양. 오른쪽으로 나가면 새 모니터 왼쪽 끝에서, 왼쪽으로 나가면 오른쪽
/// 끝에서 들어온다. 모니터가 실제로 맞닿았는지는 보지 않는다 — 위아래로 놓여도 옆으로 걸어 들어온다.
fn walk_shift(side: Side, from: Layout, to: Layout) -> [f64; 2] {
    let dx = match side {
        Side::Right => -from.w,
        Side::Left => to.w,
    };
    [dx, to.ground - from.ground]
}

/// 잡고 끌어 건너갈 때 세계를 옮길 양: 옛 창 원점 − 새 창 원점. 고양이가 커서 밑에 그대로 있다.
fn drag_shift(from: [f64; 4], to: [f64; 4]) -> [f64; 2] {
    [from[0] - to[0], from[1] - to[1]]
}

/// 창이 붙을 모니터. 붙어 있던 모니터가 없어졌으면 주 모니터.
fn pick(screens: &[Screen], at: Option<[f64; 4]>) -> Option<Screen> {
    at.and_then(|r| screens.iter().find(|s| s.rect == r)).or(screens.first()).copied()
}

/// 메인 창이 자리·산책·'항상 위'가 바뀔 때 부른다. 처음 켤 때 창을 만든다.
pub fn show(app: &AppHandle, on: bool, on_top: bool) -> Result<(), AppError> {
    {
        let mut st = STATE.lock()?;
        st.on = on;
        if st.on_top != on_top {
            st.perch_at = None; // '항상 위'를 끄면 발판을 비우고, 켜면 바로 다시 읽는다
        }
        st.on_top = on_top;
    }
    if !on {
        unhide(app); // 다른 자리로 가면 숨김도 푼다
    }
    if !on && app.get_webview_window(LABEL).is_none() {
        return Ok(()); // 한 번도 안 띄웠으면 만들 것도 없다
    }
    if app.get_webview_window(LABEL).is_none() {
        create(app)?;
    }
    sync(app)?;
    if on {
        start_poller(app)?;
    }
    Ok(())
}

/// 화면 창이 커서가 고양이·마당 선물 위인지 알린다. `cat` 은 고양이 위일 때.
pub fn set_catch(on: bool, cat: bool) -> Result<(), AppError> {
    let mut st = STATE.lock()?;
    st.catch_at = on.then(Instant::now);
    st.catch_cat = on && cat;
    Ok(())
}

/// 화면 창: 고양이 자리(창 좌표, 크게 움직였을 때만)와 올라탄 창 번호(엔진 perch 의 창).
pub fn set_cat(at: Option<[f64; 2]>, perch: Option<u32>) -> Result<(), AppError> {
    let mut st = STATE.lock()?;
    if at.is_some() {
        st.cat_at = at;
    }
    st.perch_win = perch;
    Ok(())
}

/// 화면 창이 처음 뜰 때 지금 발판·벽을 가져간다.
pub fn perches_now() -> Option<Perches> {
    STATE.lock().ok()?.perches_sent.clone()
}

/// 화면 창: 잡힌 고양이 목덜미 자리(창 좌표). 놓으면 None. 창을 옮기는 중(다시 보이기 전)에 온 건 옛 창 좌표라 버린다.
pub fn set_held(at: Option<[f64; 2]>) -> Result<(), AppError> {
    let mut st = STATE.lock()?;
    if st.hidden_at.is_none() {
        st.held = at.map(|p| (p, Instant::now()));
    }
    Ok(())
}

/// 고양이를 끌 때 창이 따라갈 점(전역 좌표): 방금 알린 목덜미, 없으면 커서.
fn drag_point(held: Option<([f64; 2], Instant)>, origin: [f64; 2], mouse: [f64; 2]) -> [f64; 2] {
    held.filter(|(_, t)| t.elapsed() < CATCH_TTL).map_or(mouse, |(h, _)| [origin[0] + h[0], origin[1] + h[1]])
}

/// 버튼 상태로 잡기를 고친다: (잡는 중, 잡은 게 고양이). 누른 순간 받는 중이었으면 잡기 시작이고, 무엇을
/// 잡았는지는 그때 정한다 — 선물을 끌다 고양이 위를 지나가도 선물 끌기다.
fn grab_step(down: bool, catching: bool, grabbing: bool, grab_cat: bool, catch_cat: bool) -> (bool, bool) {
    match (down, grabbing) {
        (false, _) => (false, false),
        (true, true) => (true, grab_cat),
        (true, false) => (catching, catching && catch_cat),
    }
}

/// 화면 창이 처음 뜰 때 판 크기와 바닥을 가져간다. 아직 모르면 None(곧 `neko-screen-layout` 이 온다).
pub fn layout() -> Option<Layout> {
    STATE.lock().ok()?.layout
}

/// 네코 캡처 동안 숨긴다. 숨긴 게 있으면 true(사라질 때까지 기다리라고).
pub fn set_capture(app: &AppHandle, on: bool) -> bool {
    let was_visible = match STATE.lock() {
        Ok(mut st) => {
            let v = visible(&st);
            st.capture = on;
            v
        }
        Err(_) => return false,
    };
    if app.get_webview_window(LABEL).is_some() {
        let _ = sync(app);
    }
    on && was_visible
}

fn visible(st: &State) -> bool {
    st.on && !st.capture && !st.video && !st.user_hidden
}

/// 고양이 메뉴 '숨기기': 마당(고양이·선물)을 숨기고 엔진을 멈춘다. 메인 창 감독에도 알린다(`neko-screen-hidden`).
pub fn hide(app: &AppHandle) -> Result<(), AppError> {
    {
        let mut st = STATE.lock()?;
        if st.user_hidden {
            return Ok(());
        }
        st.user_hidden = true;
        st.front_own = None;
    }
    let _ = app.emit("neko-screen-hidden", true);
    sync(app)
}

/// 고양이 메뉴로 숨겨 둔 중인가.
pub fn user_hidden() -> bool {
    STATE.lock().is_ok_and(|st| st.user_hidden)
}

/// 이 앱이 맨 앞으로 왔다(메인 창 활성화·Dock·⌘Tab): 숨긴 마당을 다시 보인다. main thread 에서 부르지 말 것(sync 가 main thread 를 기다린다).
pub fn unhide(app: &AppHandle) {
    match STATE.lock() {
        Ok(mut st) if st.user_hidden => st.user_hidden = false,
        _ => return,
    }
    let _ = app.emit("neko-screen-hidden", false);
    let _ = sync(app);
}

/// 숨긴 동안 폴러가 2초마다: 맨 앞 앱이 다른 앱에서 이 앱으로 바뀌었으면 다시 보인다. 메인 창이 닫힌 채
/// ⌘Tab 으로 왔을 때처럼 창 포커스가 안 오는 경우를 잡는다.
fn watch_front(app: &AppHandle) {
    if !STATE.lock().is_ok_and(|st| st.user_hidden) {
        return;
    }
    let Ok((_, own)) = on_main(app, || unsafe { crate::ambient::macos::frontmost() }) else { return };
    let was = STATE.lock().ok().and_then(|mut st| st.front_own.replace(own));
    if own && was == Some(false) {
        unhide(app);
    }
}

fn create(app: &AppHandle) -> Result<(), AppError> {
    let win = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("index.html".into()))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        // 키 창이 아닌 패널이라, 끄면 첫 클릭을 창 활성화에 써 버린다.
        .accept_first_mouse(true)
        // 1단계엔 파일을 안 받는다. 2단계 파일 물려주기(§7)에서 켠다.
        .disable_drag_drop_handler()
        .build()?;
    let ns = win.ns_window()? as usize;
    if !on_main(app, move || unsafe { macos::setup(ns as *mut objc2::runtime::AnyObject) })? {
        log::warn!("화면 네코 창을 패널로 못 바꿨어 — 눌렀을 때 키보드를 뺏을 수 있다");
    }
    Ok(())
}

/// 지금 상태대로 창을 올리거나 숨기고, 레벨·자리를 맞춘다. 화면 창에 바뀐 판·멈춤을 알린다.
fn sync(app: &AppHandle) -> Result<(), AppError> {
    let Some(win) = app.get_webview_window(LABEL) else { return Ok(()) };
    let (show, on_top, at) = {
        let st = STATE.lock()?;
        (visible(&st), st.on_top, st.at)
    };
    let ns = win.ns_window()? as usize;
    let (screens, to) = on_main(app, move || unsafe {
        let screens = macos::screens();
        let to = pick(&screens, at);
        macos::place(ns as *mut objc2::runtime::AnyObject, show, on_top, to.map(|s| s.cocoa), false);
        (screens, to)
    })?;
    let info = screens_info(&screens, to.as_ref());
    sync_decor(app, &screens, show, on_top);
    let mut st = STATE.lock()?;
    if st.screens_sent.as_ref() != Some(&info) {
        st.screens_sent = Some(info.clone());
        let _ = app.emit("neko-screens", info);
    }
    st.screens = screens;
    if let Some(s) = to {
        // 붙어 있던 모니터가 빠졌으면 주 모니터로 왔다. 세계는 옮기지 않는다 — 밖에 남은 고양이는 엔진이 걸어 들인다
        st.at = Some(s.rect);
        if st.layout != Some(s.layout) {
            st.layout = Some(s.layout);
            let _ = app.emit_to(LABEL, "neko-screen-layout", s.layout);
        }
    }
    if !show && st.catching {
        st.catching = false;
        st.grabbing = false;
        let _ = win.set_ignore_cursor_events(true);
    }
    if !show {
        st.decor_grab = None;
        if let Some(w) = st.decor_catching.take().and_then(|l| app.get_webview_window(&l)) {
            let _ = w.set_ignore_cursor_events(true);
        }
    }
    let active = show && !st.asleep;
    if st.active != Some(active) {
        st.active = Some(active);
        let _ = app.emit_to(LABEL, "neko-screen-active", active);
    }
    Ok(())
}

/// 모니터마다 선물 창을 띄우고(없으면 만든다) 그 모니터를 덮는다. 빠진 모니터의 창은 숨긴다. 고양이 창보다 한 층
/// 아래다. 그림은 메인 창이 `neko-decor-items` 로 넘긴다(바뀔 때만 그린다).
fn sync_decor(app: &AppHandle, screens: &[Screen], show: bool, on_top: bool) {
    let mut used = Vec::new();
    for s in screens {
        let label = decor_label(&s.id);
        let win = match app.get_webview_window(&label) {
            Some(w) => w,
            None if show => match create_decor(app, &label) {
                Ok(w) => w,
                Err(e) => {
                    log::warn!("마당 선물 창을 못 만들었어: {e}");
                    continue;
                }
            },
            None => continue,
        };
        used.push(label);
        let Ok(ns) = win.ns_window() else { continue };
        let (ns, cocoa) = (ns as usize, s.cocoa);
        let _ = on_main(app, move || unsafe { macos::place(ns as *mut objc2::runtime::AnyObject, show, on_top, Some(cocoa), true) });
    }
    for (label, win) in app.webview_windows() {
        if label.starts_with(DECOR) && !used.contains(&label) {
            if let Ok(ns) = win.ns_window() {
                let ns = ns as usize;
                let _ = on_main(app, move || unsafe { macos::place(ns as *mut objc2::runtime::AnyObject, false, false, None, true) });
            }
        }
    }
}

fn create_decor(app: &AppHandle, label: &str) -> Result<tauri::WebviewWindow, AppError> {
    let win = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::App("index.html".into()))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        // 키 창이 아닌 패널이라, 끄면 첫 클릭(선물 잡기)을 창 활성화에 써 버린다.
        .accept_first_mouse(true)
        // 숨겼다 다시 보일 때 그새 받은 그림부터 바로 그리게. 받을 때만 그리니 깨어 있어도 드는 게 없다
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .disable_drag_drop_handler()
        .build()?;
    let ns = win.ns_window()? as usize;
    on_main(app, move || unsafe { macos::setup(ns as *mut objc2::runtime::AnyObject) })?;
    Ok(win)
}

/// 메인 창이 켤 때 모니터 목록을 가져간다(이벤트를 놓쳤을 때). 화면 창이 없으면 None.
pub fn screens() -> Option<Screens> {
    STATE.lock().ok()?.screens_sent.clone()
}

fn start_poller(app: &AppHandle) -> Result<(), AppError> {
    {
        let mut st = STATE.lock()?;
        if st.poller {
            return Ok(());
        }
        st.poller = true;
    }
    let app = app.clone();
    std::thread::spawn(move || poll(app));
    Ok(())
}

/// 화면 자리가 켜져 있는 동안 돈다. 꺼지면 다음 깸에서 끝난다(다시 켜면 새로 뜬다).
fn poll(app: AppHandle) {
    let mut tick: u32 = 0;
    let mut sent: Option<[f64; 2]> = None;
    let mut away_sent: Option<Side> = None;
    loop {
        let active = match STATE.lock() {
            Ok(st) if st.on => st.active == Some(true),
            Ok(mut st) => {
                st.poller = false;
                return;
            }
            Err(_) => return,
        };
        if !active || tick % SLOW_TICKS == 0 {
            survey(&app);
            watch_front(&app);
        }
        if active {
            follow(&app, &mut sent, &mut away_sent);
            perch_tick(&app);
        } else {
            sent = None;
        }
        if STATE.lock().is_ok_and(|st| st.hidden_at.is_some_and(|t| t.elapsed() > REVEAL_AFTER)) {
            let _ = reveal(&app);
        }
        tick = tick.wrapping_add(1);
        std::thread::sleep(if active { TICK } else { SLOW });
    }
}

/// 커서를 화면 창에 보내고 클릭 통과를 맞춘다(고양이 창·선물 창). 커서가 다른 모니터면 고양이를 잡고 끄는
/// 중엔 창을 그리로 옮기고, 아니면 한동안 머문 뒤 그쪽을 알린다(`neko-screen-away`).
fn follow(app: &AppHandle, sent: &mut Option<[f64; 2]>, away_sent: &mut Option<Side>) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    let Ok(Some(p)) = on_main(app, || unsafe { macos::probe() }) else { return };
    let Ok(mut st) = STATE.lock() else { return };
    let Some(cur) = pick(&st.screens, st.at) else { return };
    // 누른 순간: 그 누름을 받지 않은 창(다른 데 누름)은 띄운 메뉴를 닫는다
    if p.down && !st.was_down {
        let took = if st.catching { Some(LABEL.to_string()) } else { st.decor_catching.clone() };
        press_out(app, took.as_deref());
    }
    st.was_down = p.down;
    (st.grabbing, st.grab_cat) = grab_step(p.down, st.catching, st.grabbing, st.grab_cat, st.catch_cat);
    st.decor_grab = decor_grab_step(p.down, st.decor_grab.take(), st.decor_catching.clone());
    // 선물 창에서 선물을 끄는 동안 고양이 창은 커서를 못 본다 — 끌던 선물로 고양이를 비벼도 쓰다듬기가 아니다
    let [ox, oy, ..] = cur.rect;
    let cursor = (st.decor_grab.is_none() && inside(cur.rect, p.mouse)).then(|| [p.mouse[0] - ox, p.mouse[1] - oy]);
    if cursor != *sent {
        *sent = cursor;
        let _ = app.emit_to(LABEL, "neko-screen-cursor", cursor);
    }
    let under = st.screens.iter().find(|s| inside(s.rect, p.mouse)).copied();
    let mut other = if inside(cur.rect, p.mouse) { None } else { under };
    // 고양이를 끄는 중: 고양이(목덜미)가 다른 모니터에 들어가면 창을 옮긴다 — 경계에서 건너가 튀지 않는다
    if st.grabbing && st.grab_cat {
        let at = drag_point(st.held, [ox, oy], p.mouse);
        if let Some(to) = st.screens.iter().find(|s| s.rect != cur.rect && inside(s.rect, at)).copied() {
            drop(st);
            move_to(app, &win, to, drag_shift(cur.rect, to.rect));
            return;
        }
    }
    // 마당 선물을 끄는 중(고양이 창 = 엔진이 잡은 선물, 아니면 선물 창): 선물은 그 창의 모니터 끝에서 멈추고, 고양이도
    // 커서를 따라 건너가지 않는다. 커서가 다른 모니터면 그 자리를 끄는 창에 알린다 — 놓으면 그 모니터로 옮긴다
    // (remoteNeko). 놓는 순간엔 지우지 않는다(pointerup 이 늦게 닿아도 창이 자리를 알게). 창이 다음에 누를 때 지운다
    let drag = if st.grabbing && !st.grab_cat {
        Some((LABEL.to_string(), cur.rect))
    } else {
        st.decor_grab.as_ref().and_then(|l| st.screens.iter().find(|s| decor_label(&s.id) == *l).map(|s| (l.clone(), s.rect)))
    };
    if let Some((label, home)) = drag {
        let e = under
            .filter(|o| o.rect != home)
            .map(|o| Elsewhere { screen: uuid_str(&o.id), x: p.mouse[0] - o.rect[0], y: p.mouse[1] - o.rect[1] });
        if e != st.elsewhere {
            st.elsewhere = e.clone();
            let _ = app.emit_to(&label, "neko-screen-elsewhere", e);
        }
        other = None;
    } else if !p.down {
        st.elsewhere = None;
    }
    st.away = match (other, st.away) {
        (Some(to), Some((t, since))) if t.rect == to.rect => Some((t, since)),
        (Some(to), _) => Some((to, Instant::now())),
        (None, _) => None,
    };
    let away = st.away.filter(|(_, since)| since.elapsed() >= AWAY_AFTER).map(|(t, _)| side_of(cur.rect, t.rect));
    if away != *away_sent {
        *away_sent = away;
        let _ = app.emit_to(LABEL, "neko-screen-away", away);
    }
    let fresh = st.catch_at.is_some_and(|t| t.elapsed() < CATCH_TTL);
    let want = wants_clicks(st.grabbing, fresh, cursor.is_some(), p.option, p.down);
    if want != st.catching {
        st.catching = want;
        let _ = win.set_ignore_cursor_events(!want);
    }
    // 선물 창: 커서 밑 모니터의 선물 칸 안인가
    let hover = under.and_then(|s| {
        let (label, pt) = (decor_label(&s.id), [p.mouse[0] - s.rect[0], p.mouse[1] - s.rect[1]]);
        st.boxes.iter().any(|(l, b)| *l == label && b.iter().any(|r| inside(*r, pt))).then_some(label)
    });
    let target = decor_target(st.decor_grab.clone(), hover, st.catching, p.option, p.down);
    if target != st.decor_catching {
        for (label, on) in [(&st.decor_catching, false), (&target, true)] {
            if let Some(w) = label.as_ref().and_then(|l| app.get_webview_window(l)) {
                let _ = w.set_ignore_cursor_events(!on);
            }
        }
        st.decor_catching = target;
    }
}

/// 누름을 받지 않은 마당 창들(고양이 창·선물 창)에 다른 데를 눌렀다고 알린다.
fn press_out(app: &AppHandle, took: Option<&str>) {
    for label in app.webview_windows().into_keys() {
        if (label == LABEL || label.starts_with(DECOR)) && Some(label.as_str()) != took {
            let _ = app.emit_to(&label, "neko-screen-press-out", ());
        }
    }
}

/// 캣타워: 창 목록을 읽어 발판·벽을 화면 창에 보낸다(바뀔 때만). 고양이가 창 근처면 0.5초, 멀면 2초마다 다 읽고, 그
/// 사이엔 올라탄 창만 매 틱 읽어 움직였으면 그 창 것만(partial) 보낸다. '항상 위'가 꺼져 있으면(고양이가 창 아래) 비운다.
fn perch_tick(app: &AppHandle) {
    let Ok(st) = STATE.lock() else { return };
    let Some(cur) = pick(&st.screens, st.at) else { return };
    let ground = cur.layout.ground;
    if !st.on_top {
        let empty = Perches::default();
        drop(st);
        send_perches(app, empty, true);
        return;
    }
    let near = st.cat_at.map_or(true, |c| {
        let g = [cur.rect[0] + c[0], cur.rect[1] + c[1]];
        st.wins.iter().any(|w| {
            let [x, y, ww, h] = w.rect;
            g[0] > x - NEAR_PT && g[0] < x + ww + NEAR_PT && g[1] > y - NEAR_PT && g[1] < y + h + NEAR_PT
        })
    });
    let every = if near { PERCH_NEAR } else { PERCH_FAR };
    let (due, perch_win) = (st.perch_at.map_or(true, |t| t.elapsed() >= every), st.perch_win);
    drop(st);
    if due {
        let own = std::process::id() as i32;
        let wins: Vec<Win> = unsafe { crate::capture::macos::windows() }
            .into_iter()
            .map(|t| Win { id: t.id, rect: [t.rect.x, t.rect.y, t.rect.w, t.rect.h], perch: t.pid != own })
            .collect();
        let p = perches(&wins, cur.rect, ground, None);
        if let Ok(mut st) = STATE.lock() {
            st.wins = wins;
            st.perch_at = Some(Instant::now());
        }
        send_perches(app, p, true);
        return;
    }
    // 올라탄 창: 그 창만 매 틱(30Hz) — 사용자가 창을 끌면 고양이가 같이 간다. 닫혔으면 다음 틱에 다 읽는다
    let Some(win) = perch_win else { return };
    let rect = unsafe { crate::neko_perch::macos::window_rect(win) };
    let Ok(mut st) = STATE.lock() else { return };
    let Some(rect) = rect else {
        st.perch_at = None;
        return;
    };
    let Some(w) = st.wins.iter_mut().find(|w| w.id == win) else { return };
    if w.rect == rect {
        return;
    }
    w.rect = rect;
    let p = perches(&st.wins, cur.rect, ground, Some(win));
    if let Some(sent) = st.perches_sent.as_mut() {
        sent.tops.retain(|t| t.win != win);
        sent.walls.retain(|t| t.win != win);
        sent.tops.extend(p.tops.iter().cloned());
        sent.walls.extend(p.walls.iter().cloned());
    }
    drop(st);
    send_perches(app, p, false);
}

/// 발판·벽을 화면 창에(`neko-screen-perches`). 전체(full)는 지난번과 같으면 안 보낸다.
fn send_perches(app: &AppHandle, p: Perches, full: bool) {
    if full {
        let Ok(mut st) = STATE.lock() else { return };
        if st.perches_sent.as_ref() == Some(&p) {
            return;
        }
        st.perches_sent = Some(p.clone());
    }
    let _ = app.emit_to(LABEL, "neko-screen-perches", p);
}

/// 창을 `to` 모니터로 옮기고(숨긴 채) 화면 창에 세계를 옮기라고 알린다.
fn move_to(app: &AppHandle, win: &tauri::WebviewWindow, to: Screen, shift: [f64; 2]) {
    let Ok(ns) = win.ns_window() else { return };
    let ns = ns as usize;
    if on_main(app, move || unsafe { macos::move_to(ns as *mut objc2::runtime::AnyObject, to.cocoa) }).is_err() {
        return;
    }
    if let Ok(mut st) = STATE.lock() {
        st.at = Some(to.rect);
        st.layout = Some(to.layout);
        st.away = None;
        st.held = None;
        st.hidden_at = Some(Instant::now());
        st.perch_at = None; // 새 모니터 좌표로 다시(엔진은 shiftWorld 때 목록을 비운다 — 같아 보여도 꼭 보낸다)
        st.perches_sent = None;
        st.perch_win = None;
        st.cat_at = None;
    }
    let _ = app.emit_to(LABEL, "neko-screen-moved", Moved { layout: to.layout, shift });
    // 고양이가 떠난 모니터엔 선물 창을, 온 모니터의 선물 창은 숨긴다(메인 창이 neko-screens 로 선물을 다시 나눈다)
    let _ = sync(app);
}

/// 화면 창: 고양이가 `side` 쪽 끝을 넘어갔다. 커서가 아직 그쪽 모니터에 있으면 창을 옮기고 true.
/// 그새 커서가 돌아왔으면 false — 화면 창이 벽을 닫아 고양이를 걸어 들인다.
pub fn cross(app: &AppHandle, side: Side) -> Result<bool, AppError> {
    let Some(win) = app.get_webview_window(LABEL) else { return Ok(false) };
    let (from, to) = {
        let st = STATE.lock()?;
        match (pick(&st.screens, st.at), st.away) {
            (Some(from), Some((to, _))) if side_of(from.rect, to.rect) == side => (from, to),
            _ => return Ok(false),
        }
    };
    move_to(app, &win, to, walk_shift(side, from.layout, to.layout));
    Ok(true)
}

/// 화면 창: 세계를 옮기고 새 자리에 그렸다 — 다시 보인다.
pub fn reveal(app: &AppHandle) -> Result<(), AppError> {
    let Some(win) = app.get_webview_window(LABEL) else { return Ok(()) };
    STATE.lock()?.hidden_at = None;
    let ns = win.ns_window()? as usize;
    on_main(app, move || unsafe { macos::reveal(ns as *mut objc2::runtime::AnyObject) })
}

/// 모니터 목록·바닥, 멈춤 조건, 전체화면 영상.
fn survey(app: &AppHandle) {
    if app.get_webview_window(LABEL).is_none() {
        return;
    }
    let Ok(at) = STATE.lock().map(|st| st.at) else { return };
    let Ok(s) = on_main(app, move || unsafe { macos::survey(at) }) else { return };
    let changed = match STATE.lock() {
        Ok(mut st) => {
            let changed = st.asleep != s.asleep || st.video != s.video || st.screens != s.screens;
            st.asleep = s.asleep;
            st.video = s.video;
            changed
        }
        Err(_) => return,
    };
    if changed {
        let _ = sync(app);
    }
}

pub(crate) mod macos {
    use super::Screen;
    use crate::quick::macos::{make_panel, ns_string, to_rust};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSRect;
    use std::ffi::c_void;

    /// make_panel 이 주는 것(모든 Space·전체화면 앱 위)에 더해: Mission Control 에서 옮겨지지
    /// 않고(Stationary), ⌘` 순환에 안 끼고(IgnoresCycle).
    const CAN_JOIN_ALL_SPACES: usize = 1 << 0;
    const STATIONARY: usize = 1 << 4;
    const IGNORES_CYCLE: usize = 1 << 6;
    const FULL_SCREEN_AUXILIARY: usize = 1 << 8;
    /// NSStatusWindowLevel. 메뉴 막대(24)·Dock(20)·전체화면 앱 위.
    const STATUS_WINDOW_LEVEL: isize = 25;
    /// kCGDesktopIconWindowLevelKey. '항상 위' 를 끄면 바탕화면 아이콘 위(선물 창 +1, 고양이 창 +2), 모든 창 아래.
    const DESKTOP_ICON_LEVEL_KEY: i32 = 18;
    const OPTION_KEY: usize = 1 << 19;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowLevelForKey(key: i32) -> i32;
        fn CGSessionCopyCurrentDictionary() -> *const c_void;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayIsAsleep(display: u32) -> u32;
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMCopyAssertionsByProcess(out: *mut *const c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFUUIDGetUUIDBytes(uuid: *const c_void) -> UuidBytes;
    }
    /// CFUUIDBytes(바이트 16개짜리 구조체)
    #[repr(C)]
    struct UuidBytes([u8; 16]);
    #[link(name = "ColorSync", kind = "framework")]
    extern "C" {
        fn CGDisplayCreateUUIDFromDisplayID(display: u32) -> *const c_void;
    }

    /// NSScreen 의 모니터 UUID. 모르면 0 으로 채운 값에 displayID 를 넣는다(그 세션 안에서만 같다).
    unsafe fn display_uuid(screen: *mut AnyObject) -> [u8; 16] {
        let desc: *mut AnyObject = msg_send![screen, deviceDescription];
        let num: *mut AnyObject = msg_send![desc, objectForKey: ns_string(c"NSScreenNumber")];
        if num.is_null() {
            return [0; 16];
        }
        let display: u32 = msg_send![num, unsignedIntValue];
        let uuid = CGDisplayCreateUUIDFromDisplayID(display);
        if uuid.is_null() {
            let mut b = [0; 16];
            b[12..].copy_from_slice(&display.to_be_bytes());
            return b;
        }
        let b = CFUUIDGetUUIDBytes(uuid).0;
        CFRelease(uuid);
        b
    }

    pub struct Probe {
        pub mouse: [f64; 2],
        pub down: bool,
        pub option: bool,
    }

    pub struct Survey {
        pub screens: Vec<Screen>,
        pub asleep: bool,
        pub video: bool,
    }

    /// 패널로 바꾸고 클릭을 흘린다. ⌘H 로 앱을 숨겨도 마당(고양이·선물)은 남는다. main thread 전용.
    pub unsafe fn setup(window: *mut AnyObject) -> bool {
        let ok = make_panel(window, false, false);
        let _: () = msg_send![window, setCollectionBehavior: CAN_JOIN_ALL_SPACES | FULL_SCREEN_AUXILIARY | STATIONARY | IGNORES_CYCLE];
        let _: () = msg_send![window, setIgnoresMouseEvents: Bool::YES];
        let _: () = msg_send![window, setCanHide: Bool::NO];
        ok
    }

    /// 모니터 목록. 0번이 주 모니터(메뉴 막대가 있는 화면). main thread 전용.
    pub unsafe fn screens() -> Vec<Screen> {
        let Some(cls) = AnyClass::get(c"NSScreen") else { return vec![] };
        let list: *mut AnyObject = msg_send![cls, screens];
        let count: usize = msg_send![list, count];
        let mut out = Vec::with_capacity(count);
        let mut main_top = 0.0;
        for i in 0..count {
            let screen: *mut AnyObject = msg_send![list, objectAtIndex: i];
            let frame = rect4(msg_send![screen, frame]);
            let visible = rect4(msg_send![screen, visibleFrame]);
            if i == 0 {
                main_top = frame[1] + frame[3];
            }
            out.push(Screen { id: display_uuid(screen), rect: super::flip(frame, main_top), cocoa: frame, layout: super::layout_of(frame, visible) });
        }
        out
    }

    fn rect4(r: NSRect) -> [f64; 4] {
        [r.origin.x, r.origin.y, r.size.width, r.size.height]
    }

    fn ns_rect([x, y, w, h]: [f64; 4]) -> NSRect {
        NSRect::new(objc2_foundation::NSPoint::new(x, y), objc2_foundation::NSSize::new(w, h))
    }

    /// 레벨을 맞추고 `frame`(AppKit 좌표) 모니터 전체를 덮은 뒤 올리거나 숨긴다. `below`: 한 층 아래(선물 창 — 고양이가
    /// 선물 앞에 오게). main thread 전용.
    pub unsafe fn place(window: *mut AnyObject, show: bool, on_top: bool, frame: Option<[f64; 4]>, below: bool) {
        let top = if on_top { STATUS_WINDOW_LEVEL } else { CGWindowLevelForKey(DESKTOP_ICON_LEVEL_KEY) as isize + 2 };
        let level = top - below as isize;
        let _: () = msg_send![window, setLevel: level];
        if let Some(frame) = frame {
            let now: NSRect = msg_send![window, frame];
            if rect4(now) != frame {
                let _: () = msg_send![window, setFrame: ns_rect(frame), display: false];
            }
        }
        if show {
            let _: () = msg_send![window, orderFrontRegardless];
        } else {
            let _: () = msg_send![window, orderOut: std::ptr::null_mut::<AnyObject>()];
        }
    }

    /// 숨긴 채 다른 모니터로 옮긴다. 옮긴 자리에 옛 그림이 한 프레임 비치지 않게 — 화면 창이 세계를
    /// 옮겨 다시 그린 뒤 `reveal`. main thread 전용.
    pub unsafe fn move_to(window: *mut AnyObject, frame: [f64; 4]) {
        let _: () = msg_send![window, setAlphaValue: 0.0f64];
        let _: () = msg_send![window, setFrame: ns_rect(frame), display: false];
    }

    /// main thread 전용.
    pub unsafe fn reveal(window: *mut AnyObject) {
        let _: () = msg_send![window, setAlphaValue: 1.0f64];
    }

    /// 커서(주 모니터 왼쪽 위 기준)·왼쪽 버튼·⌥. main thread 전용.
    pub unsafe fn probe() -> Option<Probe> {
        let event = AnyClass::get(c"NSEvent")?;
        let mouse = crate::capture::macos::mouse_global()?;
        let buttons: usize = msg_send![event, pressedMouseButtons];
        let flags: usize = msg_send![event, modifierFlags];
        Some(Probe { mouse, down: buttons & 1 != 0, option: flags & OPTION_KEY != 0 })
    }

    /// 모니터 목록, 멈춤 조건, 고양이가 있는 모니터(`at`)의 전체화면 영상. main thread 전용.
    pub unsafe fn survey(at: Option<[f64; 4]>) -> Survey {
        let screens = screens();
        // ponytail: 잠자기는 주 디스플레이만 본다. 모니터마다 따로 자는 일이 잦으면 NSScreenNumber 로
        let asleep = locked() || CGDisplayIsAsleep(CGMainDisplayID()) != 0 || screen_saver();
        let video = super::pick(&screens, at).is_some_and(|s| video(s.rect));
        Survey { screens, asleep, video }
    }

    unsafe fn bool_of(dict: *mut AnyObject, key: &std::ffi::CStr) -> Option<bool> {
        let v: *mut AnyObject = msg_send![dict, objectForKey: ns_string(key)];
        (!v.is_null()).then(|| {
            let b: Bool = msg_send![v, boolValue];
            b.as_bool()
        })
    }

    /// 화면이 잠겼거나 다른 사용자로 넘어갔다. 세션 정보를 못 읽으면(로그인 창) 잠긴 것으로 본다.
    /// `CGSSessionScreenIsLocked` 는 문서에 없는 키다 — 없어지면 디스플레이 잠자기 검사가 대부분 같이 잡는다.
    unsafe fn locked() -> bool {
        let dict = CGSessionCopyCurrentDictionary();
        if dict.is_null() {
            return true;
        }
        let d = dict as *mut AnyObject;
        let locked = bool_of(d, c"CGSSessionScreenIsLocked").unwrap_or(false);
        let on_console = bool_of(d, c"kCGSSessionOnConsoleKey").unwrap_or(true);
        CFRelease(dict);
        locked || !on_console
    }

    unsafe fn screen_saver() -> bool {
        let Some(ws) = AnyClass::get(c"NSWorkspace") else { return false };
        let ws: *mut AnyObject = msg_send![ws, sharedWorkspace];
        let front: *mut AnyObject = msg_send![ws, frontmostApplication];
        if front.is_null() {
            return false;
        }
        let id: *mut AnyObject = msg_send![front, bundleIdentifier];
        to_rust(id).as_deref() == Some("com.apple.ScreenSaver.Engine")
    }

    /// 그 모니터(전역 좌표)의 맨 앞 창이 모니터 전체를 덮고(전체화면), 그 앱이 화면 꺼짐을 막고 있다(영상·발표).
    unsafe fn video(s: [f64; 4]) -> bool {
        let windows = crate::capture::macos::windows();
        let [x, y, w, h] = s;
        let Some(front) =
            windows.iter().find(|t| t.rect.x < x + w && t.rect.y < y + h && t.rect.x + t.rect.w > x && t.rect.y + t.rect.h > y)
        else {
            return false;
        };
        super::covers(&front.rect, s) && keeps_display_awake(front.pid)
    }

    unsafe fn keeps_display_awake(pid: i32) -> bool {
        let mut dict: *const c_void = std::ptr::null();
        if pid <= 0 || IOPMCopyAssertionsByProcess(&mut dict) != 0 || dict.is_null() {
            return false;
        }
        let found = (|| {
            let num: *mut AnyObject = msg_send![AnyClass::get(c"NSNumber")?, numberWithInt: pid];
            let list: *mut AnyObject = msg_send![dict as *mut AnyObject, objectForKey: num];
            if list.is_null() {
                return Some(false);
            }
            let count: usize = msg_send![list, count];
            for i in 0..count {
                let a: *mut AnyObject = msg_send![list, objectAtIndex: i];
                let kind: *mut AnyObject = msg_send![a, objectForKey: ns_string(c"AssertType")];
                if matches!(to_rust(kind).as_deref(), Some("PreventUserIdleDisplaySleep" | "NoDisplaySleepAssertion")) {
                    return Some(true);
                }
            }
            Some(false)
        })()
        .unwrap_or(false);
        CFRelease(dict);
        found
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicks_only_on_a_fresh_hover_unless_grabbing() {
        // 고양이 위(방금 알림), 버튼 안 누름 → 받는다
        assert!(wants_clicks(false, true, true, false, false));
        // 알림이 오래됨(화면 창이 굳음) → 흘린다
        assert!(!wants_clicks(false, false, true, false, false));
        // ⌥ → 흘린다
        assert!(!wants_clicks(false, true, true, true, false));
        // 다른 앱에서 끌던 채로 들어옴 → 흘린다
        assert!(!wants_clicks(false, true, true, false, true));
        // 다른 모니터 → 흘린다
        assert!(!wants_clicks(false, true, false, false, false));
        // 잡고 끄는 중 → 알림이 없고 화면 밖이어도 놓을 때까지 받는다
        assert!(wants_clicks(true, false, false, true, true));
    }

    #[test]
    fn only_a_grabbed_cat_drags_the_window() {
        // 고양이 위에서 눌렀다: 고양이 잡기
        assert_eq!(grab_step(true, true, false, false, true), (true, true));
        // 선물 위에서 눌렀다: 잡기지만 고양이는 아니다. 끄는 길에 고양이 위를 지나가도 그대로다
        assert_eq!(grab_step(true, true, false, false, false), (true, false));
        assert_eq!(grab_step(true, true, true, false, true), (true, false));
        // 받는 중이 아닐 때 눌렀다(다른 앱 클릭): 잡기 아님
        assert_eq!(grab_step(true, false, false, false, true), (false, false));
        // 놓았다
        assert_eq!(grab_step(false, true, true, true, true), (false, false));
    }

    #[test]
    fn ground_sits_on_top_of_the_dock() {
        // 1512×982 화면, 아래 Dock 70pt, 위 메뉴 막대 33pt(AppKit 좌표는 왼쪽 아래 원점)
        let l = layout_of([0.0, 0.0, 1512.0, 982.0], [0.0, 70.0, 1512.0, 879.0]);
        assert_eq!(l, Layout { w: 1512.0, h: 982.0, ground: 912.0 });
        // Dock 이 옆에 있거나 숨으면 화면 맨 아래
        assert_eq!(layout_of([0.0, 0.0, 1512.0, 982.0], [60.0, 0.0, 1452.0, 949.0]).ground, 982.0);
    }

    #[test]
    fn only_a_window_over_the_whole_screen_is_full_screen() {
        use crate::capture::Rect;
        let main = [0.0, 0.0, 1512.0, 982.0];
        assert!(covers(&Rect { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 }, main));
        // 최대화(메뉴 막대 아래부터)는 전체화면이 아니다
        assert!(!covers(&Rect { x: 0.0, y: 33.0, w: 1512.0, h: 879.0 }, main));
        // 오른쪽 모니터의 전체화면 창
        let right = [1512.0, -100.0, 1920.0, 1080.0];
        assert!(covers(&Rect { x: 1512.0, y: -100.0, w: 1920.0, h: 1080.0 }, right));
        assert!(!covers(&Rect { x: 0.0, y: 0.0, w: 1512.0, h: 982.0 }, right));
    }

    fn screen(cocoa: [f64; 4], main_top: f64) -> Screen {
        Screen { id: [cocoa[0] as u8; 16], rect: flip(cocoa, main_top), cocoa, layout: layout_of(cocoa, cocoa) }
    }

    #[test]
    fn every_monitor_keeps_its_own_decor_window() {
        let a = screen([0.0, 0.0, 1440.0, 900.0], 900.0);
        let b = screen([1440.0, 0.0, 1920.0, 1080.0], 900.0);
        let c = screen([-1280.0, 0.0, 1280.0, 800.0], 900.0);
        let labels = |cat| screens_info(&[a, b, c], cat).screens.into_iter().map(|s| s.decor).collect::<Vec<_>>();
        // 고양이가 건너가도 창은 제 모니터에 그대로(라벨이 모니터 UUID)
        assert_eq!(labels(Some(&b)), labels(Some(&a)));
        assert_eq!(labels(None)[1], format!("neko-decor-{}", uuid_str(&b.id)));
        let info = screens_info(&[a, b, c], Some(&b));
        assert_eq!(info.cat, Some(uuid_str(&b.id)));
        assert_eq!(info.main, uuid_str(&a.id));
        assert_eq!(uuid_str(&[0xAB; 16]), "ABABABAB-ABAB-ABAB-ABAB-ABABABABABAB");
    }

    #[test]
    fn decor_window_takes_clicks_only_over_its_gifts() {
        let a = || Some("neko-decor-A".to_string());
        // 선물 위, 버튼 안 누름 → 그 창이 받는다
        assert_eq!(decor_target(None, a(), false, false, false), a());
        // 고양이 창이 받는 중(고양이가 선물 앞) · ⌥ · 누른 채 들어옴 → 안 받는다
        assert_eq!(decor_target(None, a(), true, false, false), None);
        assert_eq!(decor_target(None, a(), false, true, false), None);
        assert_eq!(decor_target(None, a(), false, false, true), None);
        // 끄는 중이면 선물 밖·다른 모니터여도 놓을 때까지 그 창
        assert_eq!(decor_target(a(), None, false, true, true), a());
        // 받던 창에서 눌렀다 → 잡기, 놓으면 끝. 받는 창이 없을 때 눌렀다(다른 앱) → 잡기 아님
        assert_eq!(decor_grab_step(true, None, a()), a());
        assert_eq!(decor_grab_step(true, a(), None), a());
        assert_eq!(decor_grab_step(false, a(), a()), None);
        assert_eq!(decor_grab_step(true, None, None), None);
    }

    #[test]
    fn other_monitors_in_global_coords() {
        // 주 1512×982, 오른쪽에 1920×1080 을 위쪽 끝이 100pt 더 올라가게
        let main = screen([0.0, 0.0, 1512.0, 982.0], 982.0);
        let right = screen([1512.0, -2.0, 1920.0, 1080.0], 982.0);
        assert_eq!(main.rect, [0.0, 0.0, 1512.0, 982.0]);
        assert_eq!(right.rect, [1512.0, -96.0, 1920.0, 1080.0]);
        assert!(inside(right.rect, [1600.0, -50.0]));
        assert!(!inside(main.rect, [1512.0, 10.0]));
        assert_eq!(side_of(main.rect, right.rect), Side::Right);
        assert_eq!(side_of(right.rect, main.rect), Side::Left);
        // 위에 얹은 모니터는 오른쪽으로 나간다
        let above = screen([0.0, 982.0, 1512.0, 982.0], 982.0);
        assert_eq!(side_of(main.rect, above.rect), Side::Right);
        // 붙어 있던 모니터가 빠지면 주 모니터로
        assert_eq!(pick(&[main, right], Some(right.rect)), Some(right));
        assert_eq!(pick(&[main], Some(right.rect)), Some(main));
        assert_eq!(pick(&[], None), None);
    }

    #[test]
    fn a_dragged_cat_crosses_where_the_cat_is_not_the_cursor() {
        // 목덜미를 방금 알렸으면 그 자리(창 원점 + 창 좌표), 오래됐거나 없으면 커서
        let fresh = Some(([1500.0, 300.0], Instant::now()));
        assert_eq!(drag_point(fresh, [0.0, -96.0], [1700.0, 50.0]), [1500.0, 204.0]);
        let stale = Some(([1500.0, 300.0], Instant::now() - Duration::from_secs(1)));
        assert_eq!(drag_point(stale, [0.0, 0.0], [1700.0, 50.0]), [1700.0, 50.0]);
        assert_eq!(drag_point(None, [0.0, 0.0], [1700.0, 50.0]), [1700.0, 50.0]);
    }

    #[test]
    fn crossing_keeps_the_cat_in_place() {
        let a = Layout { w: 1512.0, h: 982.0, ground: 912.0 };
        let b = Layout { w: 1920.0, h: 1080.0, ground: 1080.0 };
        // 오른쪽 끝(x = 1512 + 10)을 넘어 나가면 새 모니터 왼쪽 끝 밖(x = 10)에, 새 바닥 위로
        let [dx, dy] = walk_shift(Side::Right, a, b);
        assert_eq!((1522.0 + dx, 912.0 + dy), (10.0, 1080.0));
        // 왼쪽 끝(x = -10)을 넘어 나가면 새 모니터 오른쪽 끝 밖에
        assert_eq!(-10.0 + walk_shift(Side::Left, b, a)[0], 1502.0);
        // 끌어 넘기면 커서 밑 그대로: 전역 (1600, -50) 은 옛 창에서 (1600, -50), 새 창에서 (88, 46)
        let [dx, dy] = drag_shift([0.0, 0.0, 1512.0, 982.0], [1512.0, -96.0, 1920.0, 1080.0]);
        assert_eq!((1600.0 + dx, -50.0 + dy), (88.0, 46.0));
    }
}
