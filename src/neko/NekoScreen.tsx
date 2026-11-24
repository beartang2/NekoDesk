import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { shelfApi, type ShelfItem } from "../api/tauri";
import { createNeko, type NekoController, type NekoEvents, type NekoMood, type NekoPose } from "./engine/neko-engine";
import { useTrackpadPet } from "../hooks/useTrackpadPet";
import { useNekoStore } from "./nekoStore";
import type { NekoCmd, NekoEvt } from "./remoteNeko";
import { useKeepInside } from "./keepInside";
import { NekoFileArch, type NekoArchItem } from "./NekoFileArch";
import { NekoSays } from "./NekoSays";
import "./NekoScreen.css";

/**
 * 화면 창(neko-screen) — 주 모니터 전체를 덮는 투명 창에서 네코가 산다(docs/neko-screen-mode.md).
 *
 * - 엔진은 앱에서 여기 하나만 돈다. 메인 창 감독이 `neko-cmd` 로 부리고, 엔진 이벤트는 `neko-evt` 로 돌려준다.
 * - 클릭은 평소 뒤로 지나간다. Rust 가 커서를 보내 주면(`neko-screen-cursor`) 여기서 hit 로 고양이
 *   위인지 보고 `neko_screen_catch` 로 알린다. 클릭 통과를 켜고 끄는 건 Rust 만 한다.
 * - 쓰다듬기(문지르기)도 그 커서로 센다 — 키 창이 아닌 창이라 웹뷰가 mousemove 를 못 받을 수 있다.
 * - 여러 모니터: 커서가 다른 모니터에 한동안 있으면(`neko-screen-away`) 그쪽으로 걸어 나간다. 끝을 넘으면
 *   Rust 가 창을 그 모니터로 옮기고(`neko-screen-moved`, 잡고 끌 때도) 여기서 세계를 옮긴다.
 * - 마당 선물은 모니터마다 선물 창(NekoDecorScreen)이 그린다. 여기 엔진은 갖고 노느라 잡은 것만 그리고 `decorHeld` 로 알린다.
 * - 파일 물려주기(§7): 입 = 보관함. 보관함 최근 3개를 문다. 파일을 끌면(Rust `neko-screen-file-drag`) 커서 쪽으로 오고,
 *   몸·입에 놓으면 Rust 가 놓기 이벤트의 경로로 보관함에 넣는다. 얼굴에 잠깐(ARCH_HOLD_MS) 머물면 머리 위 아치(NekoFileArch)를 펴고,
 *   거기서 끌어내 놓으면 꺼낸다(끌기는 Rust 가 연다).
 */

interface Layout { w: number; h: number; ground: number }
type Side = "left" | "right";
interface Moved { layout: Layout; shift: [number, number] }
type Perches = Parameters<NekoController["setPerches"]>[0];
/** 개발 빌드 캣타워 표시(설정 › 개발자, 기본 꺼짐): 창마다 자리·앱·층·발판이 없는 까닭과 그때 발판·벽(Rust neko-screen-perch-debug) */
interface PerchDebug { win: number; owner: string; layer: number; rect: [number, number, number, number]; why: string | null }
interface PerchDebugFrame { wins: PerchDebug[]; perches: Perches }

/** 잡고 끄는 동안은 설정과 상관없이 60. 졸 때는 설정의 절반 */
const HELD_FPS = 60;
/** 졸거나 식빵·누워 자는 동안(가만히 있다). 설정 fps 보다 낮을 때만 */
const REST_FPS = 15;
/** 쉬는 중이라도 이만큼은 설정 fps 로(창에서 떨어짐·쓰다듬기·활동 바뀜) */
const WAKE_MS = 2000;
/** 커서가 이 화면에 없고 잡혀 있지 않으면 이 간격으로만 본다(커서는 Rust 가 고양이 근처일 때만 보낸다) */
const IDLE_CHECK_MS = 200;
/** 놓은 뒤 떨어지는 동안은 부드럽게 */
const FALL_MS = 1500;
/** 고양이 위에 있는 동안 이 간격으로 Rust 에 다시 알린다(Rust 는 0.25초 안에 소식이 없으면 클릭을 흘린다) */
const CATCH_EVERY_MS = 100;
/** 커서가 가만있어도 고양이가 그 밑으로 걸어오거나 떠난다 — 이 간격으로 hit 를 다시 본다 */
const CHECK_EVERY_MS = 33;
/** 화면 창이 스스로 다루는 것. 메인 창 명령으로는 부르지 않는다 */
const LOCAL_ONLY: ReadonlySet<string> = new Set([
  "pause", "resume", "resize", "destroy", "setMaxFps", "setScale", "setGround", "on", "shiftWorld", "setEdges", "walkOut", "setPerches",
]);
/** 고양이 자리를 Rust 에 다시 알리는 움직임(px). 캣타워 '창 근처' 판단용이라 거칠어도 된다 */
const CAT_AT_STEP = 60;
const CLOSED = { left: false, right: false } as const;
/** 다른 모니터로 걸어 나가라고 다시 이르는 간격(하던 활동이 끝나 한가해졌을 때 이어 가게) */
const WALK_OUT_EVERY_MS = 1000;
const FORWARD: (keyof NekoEvents)[] = ["pet", "nyang", "annoyed", "grab", "drop", "activity", "label", "error", "decorMove", "decorPlayed", "decorHeld", "play"];
/** 엔진이 파일 물려주기(§7)에 더하는 것(집사). 엔진이 아직 없으면 건너뛴다 */
interface FileDragApi {
  fileDrag(at: [number, number] | null): void;
  readonly mouth: { x: number; y: number; r: number };
  readonly head: { x: number; y: number; r: number };
}
type Circle = { x: number; y: number; r: number };
const inCircle = (c: Circle | undefined, x: number, y: number, k = 1) => !!c && Math.hypot(x - c.x, y - c.y) <= c.r * k;
/** 입에 무는 보관함 파일 id 머리(선물은 decor:) */
const FILE = "file:";
/** 입에 무는 수(보관함 최근 것부터)와 아치에 펴는 수 */
const CARRY_MAX = 3;
const ARCH_MAX = 12;
/** 얼굴에 이만큼 머물면 아치를 편다(실제로 뜨기까지 여기에 폴러·확인 간격 ≤ 0.07초가 더해진다, docs/neko-screen-mode.md §7).
 *  아치·머리에서 이만큼 떠나 있으면 접는다 */
const ARCH_HOLD_MS = 600;
const ARCH_LEAVE_MS = 800;
/** 머리에서 세기 시작한 뒤(또는 편 뒤)엔 머리 원의 이 배수 안이면 머문 것으로 본다 — 고양이가 커서 쪽으로 돌아서거나
 *  움찔해 머리가 조금 움직였다고 처음부터 다시 세지 않게 */
const ARCH_STAY = 1.5;
/** 마당 선물 '정리' 버튼이 저절로 닫히는 때 */
const MENU_MS = 6000;

const toMain = (e: NekoEvt) => void emitTo("main", "neko-evt", e).catch(() => {});

export function NekoScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<NekoController | null>(null);
  // 우클릭 메뉴 버튼 하나. 마당 선물이면 그 오른쪽 위에 '정리'(NekoSlot 과 같다, 누르면 메인 창이 선물함으로 치운다),
  // 고양이면 누른 자리에 '숨기기'(마당을 숨긴다 — 이 앱이 맨 앞으로 오면 다시 보인다). 다른 데 누르거나 몇 초 뒤 닫힌다
  const [menu, setMenu] = useState<{ id?: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  useKeepInside(menuRef, menu); // 화면 가장자리에서 열어도 창 안에 다 보이게
  // 개발 빌드 캣타워 표시(켰을 때만): 발판(초록)·벽(파랑)·창마다 빠진 까닭을 화면에 그린다
  const [debug, setDebug] = useState<{ wins: PerchDebug[]; p: Perches } | null>(null);
  const debugOn = useRef(false);
  // 엔진이 본 창마다 창 탐험 가능 여부(지금 고양이 자리 기준, 0.5초마다)
  const [towerWhy, setTowerWhy] = useState<Map<number, { why: string; ok: boolean }>>(new Map());
  // 머리 위 꺼내기 아치(열고 닫기·끌어내기는 아래 효과가 한다)
  const [arch, setArch] = useState<{ items: NekoArchItem[]; head: Circle } | null>(null);
  // 첫마디 말풍선(메인 창 remoteNeko 가 보낸다): 머리 위를 따라다니고 모니터 밖으로 안 나간다, 7초
  const [says, setSays] = useState<string | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const un = listen<string>("neko-screen-says", (e) => {
      if (typeof e.payload !== "string") return;
      setSays(e.payload);
      clearTimeout(t);
      t = setTimeout(() => setSays(null), 7000);
    });
    return () => { clearTimeout(t); void un.then((f) => f()).catch(() => {}); };
  }, []);
  const dragOutRef = useRef<(item: NekoArchItem) => void>(() => {});
  useEffect(() => {
    if (!menu) return;
    const t = setTimeout(() => setMenu(null), MENU_MS);
    return () => clearTimeout(t);
  }, [menu]);
  const { onBodyMove, onBodyLeave, setHeld, setPressed } = useTrackpadPet(() => {
    // 너무 오래 만져 짜증 나면(react 가 false) 놀이 게이지는 오르지 않는다
    if (ctrlRef.current?.react("pet")) toMain({ ev: "pet" });
  });
  const petRef = useRef({ onBodyMove, onBodyLeave, setHeld, setPressed });
  petRef.current = { onBodyMove, onBodyLeave, setHeld, setPressed };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 세계 모드(설계 §2): 세계는 창 전체 = 주 모니터. 캔버스는 고양이 둘레만 덮고 엔진이 매 프레임 옮긴다.
    // 좌표는 Rust 커서·포인터·hit 모두 창 좌표 그대로다
    const ctrl = createNeko(canvas, {
      transparent: true,
      world: true,
      scale: useNekoStore.getState().stage.screenScale,
      appearance: useNekoStore.getState().appearance,
    });
    ctrlRef.current = ctrl;
    const eng = ctrl as NekoController & Partial<FileDragApi>;

    let mood: NekoMood = "idle";
    let pose: NekoPose = "stand";
    let held = false;
    let fallTimer: ReturnType<typeof setTimeout> | undefined;
    let maxFps: number = useNekoStore.getState().stage.screenFps; // 곧 메인 창 설정값이 온다(neko-screen-fps)
    // 잡힌 동안 60, 졸거나 식빵·누워 자는 동안 15(CPU, docs/neko-perf.md §3 #4). 쉬는 중이라도 창에서 떨어지거나 쓰다듬거나
    // 활동이 바뀌면 WAKE_MS 동안은 설정 fps 로 — 움직임이 뚝뚝 끊기지 않게
    let wakeUntil = 0;
    let wakeTimer: ReturnType<typeof setTimeout> | undefined;
    const fps = () => {
      const resting = (mood === "sleepy" || pose === "loaf" || pose === "lie") && performance.now() >= wakeUntil;
      ctrl.setMaxFps(held ? HELD_FPS : resting ? Math.min(maxFps, REST_FPS) : maxFps);
    };
    const wake = () => {
      wakeUntil = performance.now() + WAKE_MS;
      clearTimeout(wakeTimer);
      wakeTimer = setTimeout(fps, WAKE_MS);
      fps();
    };
    fps();

    // 커서 → 고양이 위인지
    let cursor: [number, number] | null = null;
    let over: "cat" | "other" | null = null;
    let sentAt = 0;
    let active = true;
    // 고양이·갖고 노느라 잡은 마당 선물(엔진이 그린다 — 나머지는 선물 창 몫)·메뉴 버튼 위면 클릭을 받는다
    const overMenu = (x: number, y: number) => {
      const r = menuRef.current?.getBoundingClientRect();
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    // 고양이 위인지도 같이 알린다 — 잡고 다른 모니터로 끌 때 창이 따라가는 건 고양이뿐이다(선물은 이 화면 끝에서 멈춘다)
    // 파일을 끄는 중(Rust): 받는 자리는 고양이 몸이나 입 원. 그동안 쓰다듬기는 안 센다(over 가 "cat" 이 아니다)
    let fileDrag: [number, number] | null = null;
    let pressed = false;
    // 아치: 칸(data-neko-arch-hit) 위도 클릭 받는 자리
    let archOn = false;
    let headSince = 0;
    let awaySince = 0;
    const overArch = (x: number, y: number) =>
      archOn && Array.from(document.querySelectorAll("[data-neko-arch-hit]")).some((el) => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
    const closeArch = () => {
      headSince = awaySince = 0;
      if (!archOn) return;
      archOn = false;
      setArch(null);
    };
    // 얼굴에 ARCH_HOLD_MS 머물면 펴고(누르는·끄는 중·보관함이 비면 안 편다), 아치·머리에서 ARCH_LEAVE_MS 떠나 있으면 접는다
    const archStep = (now: number, x: number, y: number) => {
      const onHead = !!cursor && active && !fileDrag && !pressed && inCircle(eng.head, x, y, archOn || headSince ? ARCH_STAY : 1);
      if (archOn) {
        if (onHead || overArch(x, y)) awaySince = 0;
        else if (!awaySince) awaySince = now;
        else if (now - awaySince > ARCH_LEAVE_MS) closeArch();
      } else if (onHead && shelf.length) {
        if (!headSince) headSince = now;
        else if (now - headSince >= ARCH_HOLD_MS) { headSince = 0; void openArch(); }
      } else headSince = 0;
    };
    const check = () => {
      const now = performance.now();
      const [x, y] = cursor ?? [0, 0];
      archStep(now, x, y);
      const o = !active || !cursor ? null
        : fileDrag ? (ctrl.hit(x, y) || inCircle(eng.mouth, x, y) ? "other" : null)
        : ctrl.hit(x, y) ? "cat" : ctrl.hitDecor(x, y) !== null || overMenu(x, y) || overArch(x, y) ? "other" : null;
      if (o === over && !(o && now - sentAt > CATCH_EVERY_MS)) return;
      if (o === "cat" && over !== "cat") wake(); // 쓰다듬기 시작
      over = o;
      sentAt = now;
      void invoke("neko_screen_catch", { on: o !== null, cat: o === "cat" }).catch(() => {});
    };
    // 커서가 있는 다른 모니터 쪽. 한가하면(잡혀 있지 않고 활동이 없으면) 그쪽 끝 너머로 걸어간다
    let away: Side | null = null;
    let outAt = 0;
    const followAway = () => {
      const now = performance.now();
      if (!away || held || ctrl.activity !== null || now - outAt < WALK_OUT_EVERY_MS) return;
      outAt = now;
      ctrl.walkOut(away);
    };
    // 잡힌 목덜미 자리를 Rust 에 알린다(바뀔 때만, 놓으면 null). 끌어 건너갈 때 창은 커서가 아니라 고양이가 다른 모니터에
    // 들어갈 때 옮긴다 — 빠르게 끌면 고양이가 커서보다 한참 뒤라, 커서 기준이면 고양이가 옛 화면에서 사라져 튀었다
    let heldSent: string | null = null;
    const reportHeld = () => {
      const h = ctrl.held, key = h ? `${Math.round(h[0])},${Math.round(h[1])}` : null;
      if (key === heldSent) return;
      heldSent = key;
      void invoke("neko_screen_held", { at: h }).catch(() => {});
    };
    // 캣타워(neko_perch.rs): 고양이 자리(크게 움직였을 때만)와 올라탄 창 번호를 Rust 에 — 근처면 창을 자주 읽고, 올라탄 창은 30Hz 로 따라 읽는다
    let catSent: [number, number] | null = null;
    let perchSent: number | null = null;
    const reportCat = () => {
      const r = ctrl.region, at: [number, number] = [r.x + r.w / 2, r.y + r.h * 0.7];
      const win = ctrl.perch ? Number(ctrl.perch.split(":")[0]) : null, perch = Number.isFinite(win) ? win : null;
      const moved = !catSent || Math.hypot(at[0] - catSent[0], at[1] - catSent[1]) > CAT_AT_STEP;
      if (!moved && perch === perchSent) return;
      if (perch !== perchSent) wake(); // 창에 올라타거나 떨어짐
      if (moved) catSent = at;
      perchSent = perch;
      void invoke("neko_screen_cat", { at: moved ? at : null, perch }).catch(() => {});
    };
    // 창 탐험(tower)을 할 만한가를 메인 창(감독이 혼자 놀 거리를 고를 때)에 — 바뀔 때만
    let towerSent: boolean | null = null;
    const reportTower = () => {
      const ok = ctrl.towerOk;
      if (ok === towerSent) return;
      towerSent = ok;
      void emitTo("main", "neko-screen-tower", ok).catch(() => {});
    };
    // 커서가 이 화면(고양이 근처)에 있거나 잡혀 있으면 30Hz, 아니면 IDLE_CHECK_MS 로만
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      reportHeld(); reportCat(); reportTower();
      if (cursor) check(); else { followAway(); closeArch(); }
      timer = setTimeout(tick, cursor || held ? CHECK_EVERY_MS : IDLE_CHECK_MS);
    };
    timer = setTimeout(tick, CHECK_EVERY_MS);
    const whyTimer = import.meta.env.DEV
      ? setInterval(() => { if (debugOn.current) setTowerWhy(new Map(ctrl.towerWhy().map((w) => [w.win, w] as const))); }, 500)
      : undefined;
    // 입 = 보관함(§7): 최근 CARRY_MAX 개를 macOS 아이콘으로 문다. 아이콘은 경로·크기마다 한 번만 만든다
    let shelf: ShelfItem[] = [];
    const urls = new Map<string, Promise<string | null>>();
    const bitmaps = new Map<string, Promise<ImageBitmap | null>>();
    const keyOf = (it: ShelfItem) => `${it.path}|${it.size}`;
    const urlOf = (it: ShelfItem) => {
      const k = keyOf(it);
      if (!urls.has(k)) urls.set(k, shelfApi.icon(it.path).catch(() => null));
      return urls.get(k)!;
    };
    const bitmapOf = (it: ShelfItem) => {
      const k = keyOf(it);
      if (!bitmaps.has(k)) bitmaps.set(k, urlOf(it).then((u) => (u ? fetch(u).then((r) => r.blob()).then(createImageBitmap) : null)).catch(() => null));
      return bitmaps.get(k)!;
    };
    let syncSeq = 0;
    const syncCarry = async () => {
      const seq = ++syncSeq;
      const list = await shelfApi.list().catch(() => null);
      if (!list || seq !== syncSeq) return;
      shelf = list;
      if (!list.length) closeArch();
      list.slice(0, ARCH_MAX).forEach(urlOf); // 아치 아이콘을 미리 — 처음 펼 때 아이콘 만드느라 늦지 않게
      const top = list.slice(0, CARRY_MAX);
      const imgs = await Promise.all(top.map(bitmapOf));
      if (seq !== syncSeq) return;
      // 오래된 것부터 넣어야 가장 최근 것이 맨 위에 그려진다. 순서가 바뀌었으면 파일만 다 빼고 다시 문다(선물 decor: 은 그대로)
      const want = top.map((it, i) => ({ id: FILE + it.name, image: imgs[i] })).filter((w) => w.image).reverse();
      const have = ctrl.carried().filter((c) => c.id.startsWith(FILE)).map((c) => c.id);
      if (have.join("\n") === want.map((w) => w.id).join("\n")) return;
      have.forEach((id) => ctrl.drop(id));
      if (want.length) ctrl.carry(want.map((w) => ({ id: w.id, kind: "image" as const, image: w.image! })));
    };
    void syncCarry();
    const openArch = async () => {
      const head = eng.head;
      if (!head) return;
      const items = (await Promise.all(shelf.slice(0, ARCH_MAX).map(async (it) => ({ name: it.name, path: it.path, dir: it.dir, icon: (await urlOf(it)) ?? "" }))))
        .filter((it) => it.icon);
      if (!items.length || fileDrag) return;
      archOn = true;
      awaySince = 0;
      setArch({ items, head: { x: head.x, y: head.y, r: head.r } });
    };
    // 아치에서 끌어내기: Rust 가 보관함 이름으로 끌기를 열고, 끄는 동안 클릭을 흘리고(아래 Finder 에 놓이게), 놓았으면 꺼낸다.
    // 실패는 Rust 가 로그에 남긴다
    dragOutRef.current = (item) => {
      closeArch();
      void invoke("neko_screen_drag_out", { name: item.name }).catch(() => {});
    };
    // 끝을 넘었다 — 커서가 아직 그쪽이면 Rust 가 창을 옮긴다(neko-screen-moved). 그새 돌아왔으면 걸어 들어온다
    const offMenu = ctrl.on("decorMenu", setMenu);
    // 고양이 우클릭: 엔진은 선물만 메뉴를 띄우고(기본 메뉴를 막음) 고양이엔 안 띄운다. 오른쪽 버튼 누름은 엔진에
    // 안 넘긴다 — 넘기면 쓰다듬기(탭)·선물 끌기로 샌다. ⌃클릭도 우클릭이다
    const isRight = (e: MouseEvent) => e.button === 2 || (e.button === 0 && e.ctrlKey);
    const onRightDown = (e: PointerEvent) => { if (isRight(e)) e.stopPropagation(); };
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented || !ctrl.hit(e.clientX, e.clientY)) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("pointerdown", onRightDown, true);
    window.addEventListener("contextmenu", onContext);
    // 누른 채 움직이는 동안은 쓰다듬기가 아니다(선물을 끌어 고양이 위를 비빔). 고양이 잡기는 grab·drop 이 따로 막는다
    // 끌던 선물이 다른 모니터 위에 있나(Rust neko-screen-elsewhere). 놓을 때 엔진의 decorMove(이 화면 끝 자리) 대신
    // 그 모니터로 옮긴다. 새로 누를 때 지운다
    let elsewhere: { screen: string; x: number; y: number } | null = null;
    const onPress = () => { elsewhere = null; pressed = true; petRef.current.setPressed(true); };
    const onRelease = () => { pressed = false; petRef.current.setPressed(false); };
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("pointerup", onRelease, true);
    window.addEventListener("pointercancel", onRelease, true);
    const offEdge = ctrl.on("edge", (side) => {
      void invoke<boolean>("neko_screen_cross", { side })
        .then((moved) => { if (!moved) { outAt = 0; ctrl.setEdges(CLOSED); } })
        .catch(() => ctrl.setEdges(CLOSED));
    });

    const offEngine = FORWARD.map((ev) =>
      ctrl.on(ev, (payload: unknown) => {
        // 잡고 흔드는 건 쓰다듬기가 아니다: 잡힌 동안과 떨어지는 동안(held)은 결을 세지 않는다
        if (ev === "grab") { held = true; petRef.current.setHeld(true); clearTimeout(fallTimer); fps(); }
        if (ev === "drop") fallTimer = setTimeout(() => { held = false; petRef.current.setHeld(false); fps(); }, FALL_MS);
        if (ev === "error") {
          // 엔진이 멈췄다: 클릭을 막은 채 굳지 않게 숨는다
          void invoke("neko_screen_catch", { on: false }).catch(() => {});
          void getCurrentWindow().hide().catch(() => {});
        }
        if (ev === "decorMove" && elsewhere) {
          void emitTo("main", "neko-screen-put-on", { id: (payload as { id: string }).id, ...elsewhere }).catch(() => {});
          elsewhere = null;
          return;
        }
        toMain({ ev, payload: ev === "error" ? String(payload) : payload });
      }),
    );

    // 이 창 앞으로 온 것만 듣는다. 그냥 listen 은 대상이 Any 라 다른 창(다른 모니터 선물 창) 앞 이벤트까지 받는다
    const me = getCurrentWindow();
    const offs = [
      me.listen<NekoCmd>("neko-cmd", ({ payload: { m, args } }) => {
        const fn = (ctrl as unknown as Record<string, unknown>)[m];
        if (LOCAL_ONLY.has(m) || typeof fn !== "function") return;
        (fn as (...a: unknown[]) => unknown).apply(ctrl, args);
        if (m === "setMood") { mood = args[0] as NekoMood; fps(); }
        if (m === "setPose") { pose = args[0] as NekoPose; fps(); }
        if (m === "act") wake();
      }),
      me.listen<[number, number] | null>("neko-screen-cursor", ({ payload }) => {
        const prev = cursor;
        cursor = payload;
        check();
        // 고양이 몸 위일 때만(마당 선물 위는 아니다). 누른 채(선물 끌기)면 hook 이 거른다
        if (over === "cat" && prev && payload) petRef.current.onBodyMove(payload[0] - prev[0], payload[1] - prev[1]);
        else petRef.current.onBodyLeave();
      }),
      // 파일을 끄는 중이면 커서 자리(창 좌표), 끝나면 null — 고양이가 커서 쪽으로 오고 입 가까이면 입을 벌린다
      me.listen<[number, number] | null>("neko-screen-file-drag", ({ payload }) => {
        fileDrag = payload;
        eng.fileDrag?.(payload);
        if (payload) { closeArch(); wake(); }
        check();
      }),
      // 몸·입에 놓았다(받는 자리에서만 클릭을 받으니 거기서만 온다). 넣기는 Rust 가 놓기 이벤트의 경로로 한다(웹뷰는 경로를
      // 넘기지 않는다) — 입은 shelf-changed 로 맞춰지고, 2GB 넘는 등 못 넣으면 neko-screen-drop-refused 로 고개를 돌린다
      getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type !== "drop") return;
        fileDrag = null;
        eng.fileDrag?.(null);
      }),
      // 못 넣었다(디스크·2GB 넘음 — 까닭은 Rust 가 로그에): 끄기를 끝내고 토라진다(sulk). 놓기 이벤트보다 먼저 올 수 있다
      me.listen<string>("neko-screen-drop-refused", () => {
        fileDrag = null;
        eng.fileDrag?.(null);
        ctrl.react("sulk");
      }),
      listen("shelf-changed", () => void syncCarry()),
      me.listen<boolean>("neko-screen-active", ({ payload }) => {
        active = payload;
        if (active) ctrl.resume();
        else { ctrl.pause(); cursor = null; check(); }
      }),
      me.listen<Layout>("neko-screen-layout", ({ payload }) => ctrl.setGround(payload.ground)),
      me.listen<Side | null>("neko-screen-away", ({ payload }) => {
        away = payload;
        if (!away && outAt) { outAt = 0; ctrl.setEdges(CLOSED); }
      }),
      // 창이 다른 모니터로 옮겨졌다(숨긴 채). 세계를 옮기면 엔진이 바로 한 번 그린다 — 다음 프레임에 보인다
      me.listen<Moved>("neko-screen-moved", ({ payload: { layout, shift } }) => {
        // 새 바닥은 shiftWorld 에 같이 — setGround 를 따로 부르면 dy 에 든 바닥 차이만큼 세계를 한 번 더 옮겨 움찔·튀었다
        ctrl.shiftWorld(shift[0], shift[1], layout.ground);
        ctrl.setEdges(CLOSED);
        away = null;
        outAt = 0;
        cursor = null;
        requestAnimationFrame(() => void invoke("neko_screen_reveal").catch(() => {}));
      }),
      // 캣타워 발판·벽(Rust, 바뀔 때만. partial 이면 그 창 것만)
      me.listen<Perches>("neko-screen-perches", ({ payload }) => {
        ctrl.setPerches(payload);
        if (import.meta.env.DEV && debugOn.current) setDebug((d) => {
          if (!d) return d;
          const keep = <T extends { win: number }>(a: T[], b: T[]) => (payload.partial === undefined ? b : [...a.filter((o) => o.win !== payload.partial), ...b]);
          return { wins: d.wins, p: { tops: keep(d.p.tops, payload.tops), walls: keep(d.p.walls, payload.walls) } };
        });
      }),
      ...(import.meta.env.DEV
        ? [me.listen<PerchDebugFrame | null>("neko-screen-perch-debug", ({ payload }) => {
          debugOn.current = !!payload;
          setDebug(payload ? { wins: payload.wins, p: payload.perches } : null);
          if (!payload) setTowerWhy(new Map());
        })]
        : []),
      me.listen<number>("neko-screen-scale", ({ payload }) => ctrl.setScale(payload)),
      me.listen<number>("neko-screen-fps", ({ payload }) => { maxFps = payload; fps(); }),
      me.listen("neko-screen-ping", () => { towerSent = null; void emitTo("main", "neko-screen-ready").catch(() => {}); }),
      me.listen("neko-screen-press-out", () => { setMenu(null); closeArch(); }), // 다른 데를 눌렀다
      me.listen<{ screen: string; x: number; y: number } | null>("neko-screen-elsewhere", ({ payload }) => { elsewhere = payload; }),
    ];
    void invoke<Layout | null>("neko_screen_layout").then((l) => { if (l) ctrl.setGround(l.ground); }).catch(() => {});
    void invoke<Perches | null>("neko_screen_perches").then((p) => { if (p) ctrl.setPerches(p); }).catch(() => {});
    // 준비됐다 — 메인 창이 대리를 세우고 감독이 계획을 처음부터 보낸다
    void Promise.all(offs).then(() => emitTo("main", "neko-screen-ready")).catch(() => {});
    // 첫 화면을 그렸다 — 투명도 0 으로 만든 창을 보인다(그리기 전 한 프레임이 모니터를 덮지 않게, 안 부르면 Rust 가 조금 뒤 보인다)
    requestAnimationFrame(() => requestAnimationFrame(() => void invoke("neko_screen_reveal").catch(() => {})));

    return () => {
      clearTimeout(timer);
      clearTimeout(wakeTimer);
      clearInterval(whyTimer);
      clearTimeout(fallTimer);
      offEdge();
      offMenu();
      window.removeEventListener("pointerdown", onRightDown, true);
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("pointerup", onRelease, true);
      window.removeEventListener("pointercancel", onRelease, true);
      offEngine.forEach((off) => off());
      offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
      ctrl.destroy();
      ctrlRef.current = null;
    };
  }, []);

  return (
    <>
      {import.meta.env.DEV && debug && (
        <svg className="neko-screen__perch-debug" aria-hidden="true">
          {debug.wins.map((w) => (
            <g key={w.win}>
              <rect x={w.rect[0]} y={w.rect[1]} width={w.rect[2]} height={w.rect[3]} fill="none" stroke={w.why ? "#e5484d" : "#8b8d98"} strokeDasharray="6 4" />
              <text x={w.rect[0] + 4} y={w.rect[1] + 14} fill={w.why ? "#e5484d" : "#8b8d98"} fontSize="11">{`${w.owner} #${w.win} L${w.layer}${w.why ? ` — ${w.why}` : ""}`}</text>
              {towerWhy.get(w.win) && (
                <text x={w.rect[0] + 4} y={w.rect[1] + 28} fill={towerWhy.get(w.win)!.ok ? "#30a46c" : "#f76b15"} fontSize="11">{`탐험: ${towerWhy.get(w.win)!.why}`}</text>
              )}
            </g>
          ))}
          {debug.p.tops.map((t) => <line key={t.id} x1={t.x0} x2={t.x1} y1={t.y} y2={t.y} stroke="#30a46c" strokeWidth="3" />)}
          {debug.p.walls.map((w) => <line key={w.id} x1={w.x} x2={w.x} y1={w.y0} y2={w.y1} stroke="#0090ff" strokeWidth="3" />)}
        </svg>
      )}
      <canvas ref={canvasRef} className="neko-screen__canvas" tabIndex={-1} aria-hidden="true" />
      {arch && <NekoFileArch items={arch.items} head={arch.head} onDragOut={(item) => dragOutRef.current(item)} />}
      {says && <NekoSays text={says} mode="stage" fixed head={() => ctrlRef.current?.head} />}
      {menu && (
        <button
          ref={menuRef}
          type="button"
          className="neko-screen__tidy"
          style={{ left: menu.x + 2, top: Math.max(2, menu.y - 4) }}
          onClick={() => {
            if (menu.id) void emitTo("main", "neko-screen-put", menu.id).catch(() => {});
            else void invoke("neko_screen_hide").catch(() => {});
            setMenu(null);
          }}
        >
          {menu.id ? "정리" : "숨기기"}
        </button>
      )}
    </>
  );
}
