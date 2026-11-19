import { useEffect, useRef } from "react";
import { IS_PHONE } from "../lib/platform";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { NekoActivity, NekoController, NekoDecorSpot, NekoEvents } from "./engine/neko-engine";
import { useNekoApp } from "./director/stores";
import { useNekoStore } from "./nekoStore";
import { decorItems, useNekoGifts, type NekoGift, type ScreenPick } from "./gifts";
import { decorDims, sizeK, spotOf } from "./engine/decor-draw";
import { validateShape } from "./engine/gift-shape";

/**
 * 메인 창 쪽 '모니터 화면' 자리 연결(docs/neko-screen-mode.md §4).
 *
 * 화면 자리면 엔진은 화면 창(neko-screen)에만 있다. 감독은 메인 창에 그대로 두고, 컨트롤러 자리에
 * 대리(remoteNeko)를 넣는다: 메서드를 부르면 `neko-cmd` 로 넘기고, 화면 창 엔진의 이벤트는
 * `neko-evt` 로 돌려받는다. 감독의 입력(세션·앱 상황·배고픔)을 화면 창으로 다 옮기는 것보다 작다.
 */

export const SCREEN_LABEL = "neko-screen";
export interface NekoCmd { m: string; args: unknown[] }
export interface NekoEvt { ev: keyof NekoEvents; payload?: unknown }

/** 화면 고양이를 만진 것도 '앱을 쓰는 중'(5분 졸음 시계를 다시 건다). 다른 앱 입력은 세지 않는다 */
const TOUCH: ReadonlySet<string> = new Set(["pet", "nyang", "annoyed", "grab"]);

type Send = (cmd: NekoCmd) => void;
const sendToScreen: Send = (cmd) => void emitTo(SCREEN_LABEL, "neko-cmd", cmd).catch(() => {});

const listeners = new Map<string, Set<(p: unknown) => void>>();
function addListener(ev: string, fn: (p: unknown) => void): () => void {
  let s = listeners.get(ev);
  if (!s) listeners.set(ev, (s = new Set()));
  s.add(fn);
  return () => s.delete(fn);
}
let remote: NekoController | null = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((fn) => fn());

export const getRemoteNeko = (): NekoController | null => remote;
export function onRemoteNeko(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** 화면 창에서 온 엔진 이벤트를 대리의 on(...) 구독자에게 */
export function dispatchEvt({ ev, payload }: NekoEvt): void {
  if (TOUCH.has(ev)) useNekoApp.getState().markActive();
  listeners.get(ev)?.forEach((fn) => fn(payload));
}

/**
 * 대리 컨트롤러. 따로 다루는 것 말고는 무엇을 부르든 그대로 화면 창에 넘긴다(엔진에 메서드가 늘어도
 * 여기를 안 고쳐도 되게). 값을 돌려줘야 하는 것만 여기서 답한다.
 */
export function createRemoteNeko(send: Send = sendToScreen): NekoController {
  // 스케줄러가 act() 직후 동기로 읽는다. 먼저 바꿔 두고 화면 창의 activity 이벤트로 바로잡는다 —
  // 안 바로잡으면 엔진이 끝낸 한 번짜리(발도장·간식)를 아직 하는 줄 알아 다시 시키지 못한다
  let activity: NekoActivity | null = null;
  addListener("activity", (a) => { activity = (a as NekoActivity | null) ?? null; });
  // 곁들임(docs/neko-activity-mix.md §1.12)도 같다: 보내면서 바꿔 두고, 화면 창이 거절하거나 끝내면 side 이벤트로 바로잡는다.
  // 화면 창이 새로 준비되면 감독이 새 스케줄러로 처음부터 다시 보내므로 따로 다시 보낼 것은 없다
  let side: NekoActivity | null = null;
  addListener("side", (a) => { side = (a as NekoActivity | null) ?? null; });
  // 감독이 혼자 놀 거리를 고를 때 읽는 값. 대리가 함수를 돌려주면 늘 참으로 읽혀 선물이 없어도 선물 놀이를 골랐다
  // — 선물 수는 엔진에 넘긴 마당 선물(pushDecor)로, 창 탐험 가능은 화면 창이 알린 값(neko-screen-tower)으로 답한다
  const own: Record<string, unknown> = {
    on: addListener,
    // 선물 창 그림자 색도 맞추게 적어 둔다
    setTheme: (t: { dark: boolean }) => { dark = !!t?.dark; send({ m: "setTheme", args: [t] }); pushDecor(); },
    act: (a: NekoActivity | null) => { activity = a ?? null; send({ m: "act", args: [a] }); },
    mix: (a: NekoActivity | null) => { side = a ?? null; send({ m: "mix", args: [a] }); return true; },
    // 반환값을 쓰는 곳은 NekoSlot 문지르기뿐이다. 화면 자리에선 화면 창이 직접 문지른다
    react: (k: string) => { send({ m: "react", args: [k] }); return true; },
    hit: () => false,
    hitCarry: () => null,
    carryRect: () => null,
    carried: () => [],
    drop: (id?: string) => { send({ m: "drop", args: [id] }); return []; },
    getAppearance: () => useNekoStore.getState().appearance,
    reroll: () => useNekoStore.getState().appearance.seed,
  };
  return new Proxy({} as NekoController, {
    get(_, key) {
      if (key === "activity") return activity;
      if (key === "side") return side;
      if (key === "carrying") return false;
      if (key === "decorCount") return engineDecor;
      if (key === "towerOk") return towerOk;
      if (typeof key !== "string" || key === "then") return undefined; // await·Promise 판별에 걸리지 않게
      return own[key] ?? ((...args: unknown[]) => send({ m: key, args }));
    },
  });
}

// ── 모니터별 마당 선물(docs/neko-screen-mode.md §8-1) ──────────────────────────────
// 모니터마다(고양이가 있는 모니터도) 선물 창이 그 모니터의 선물을 그리고 직접 받는다(끌기·'정리'). 엔진은 고양이
// 모니터 선물을 다 알지만(놀 거리 고르기) 갖고 노는 동안 잡은 것(decorHeld)만 그린다 — 그건 선물 창에서 뺀다.

interface ScreenInfo { id: string; layout: { w: number; h: number; ground: number }; decor: string }
interface Screens { screens: ScreenInfo[]; main: string; cat: string | null }
/** Rust 가 알린 모니터 목록(neko-screens). 모르면 null — 그땐 모니터를 가리지 않는다(예전처럼) */
let screens: Screens | null = null;
let dark = false;
/** 엔진(고양이 모니터)에 넘긴 선물 수·창 탐험을 할 만한가(화면 창 엔진 towerOk). 대리 컨트롤러가 답한다 */
let engineDecor = 0;
let towerOk = false;
/** 엔진이 갖고 노느라 잡은 선물(고양이 모니터). 엔진이 새로 뜨거나 고양이가 건너가면 비운다 */
let held = new Set<string>();
const pickFor = (id: string): ScreenPick | undefined =>
  screens ? { id, main: screens.main, known: screens.screens.map((s) => s.id) } : undefined;

/**
 * 엔진엔 고양이 모니터 선물을, 선물 창엔 저마다 자기 모니터 선물을 넘긴다(고양이 모니터는 잡은 것 빼고). 선물 창은
 * 받을 때만 다시 그린다. heldOnly: 잡은 것만 바뀌었다 — 고양이 모니터 선물 창에만
 */
function pushDecor(heldOnly = false): void {
  const gifts = useNekoGifts.getState().gifts;
  if (!heldOnly) {
    const items = decorItems(gifts, "screen", screens ? pickFor(screens.cat ?? screens.main) : undefined);
    engineDecor = items.length;
    remote?.setDecor(items);
  }
  if (!screens) return;
  const scale = useNekoStore.getState().stage.screenScale;
  for (const s of screens.screens) {
    if (heldOnly && s.id !== screens.cat) continue;
    const all = decorItems(gifts, "screen", pickFor(s.id));
    const items = s.id === screens.cat ? all.filter((d) => !held.has(d.id)) : all;
    const frame = { items, W: s.layout.w, H: s.layout.h, floorY: s.layout.ground, scale, dark, screen: s.id };
    void emitTo(s.decor, "neko-decor-items", frame).catch(() => {});
  }
}

/** 화면 창·선물 창에서 끌던 선물을 다른 모니터 위에서 놓았다: 그 모니터 자리(x, y 는 그 모니터 왼쪽 위 기준)로 옮긴다 */
function putOn({ id, screen, x, y }: { id: string; screen: string; x: number; y: number }): void {
  const s = screens?.screens.find((o) => o.id === screen);
  const g = useNekoGifts.getState().gifts.find((o) => o.id === id);
  if (!s || !g) return;
  const S = Math.min(1.4, Math.max(0.35, useNekoStore.getState().stage.screenScale));
  const geom = { W: s.layout.w, floorY: s.layout.ground, S };
  const h = decorDims(validateShape(g.shape), sizeK(g.size), S).h;
  // 커서가 물건 바닥 가운데쯤이다. 바닥 근처면 바닥, 위면 벽(spotOf 가 정한다)
  useNekoGifts.getState().place(id, spotOf(x, y + h / 2, h, geom), "screen", screen);
}

let linked = false;
/** 화면 창에 준비 신호를 다시 달라고 한다. 창이 아직 없으면 아무도 안 받는다 — 그땐 창이 뜨며 스스로 보낸다 */
const ping = () => void emitTo(SCREEN_LABEL, "neko-screen-ping").catch(() => {});

/** 메인 창에서 한 번. 화면 창이 준비되면 대리를 세우고, 자리를 떠나면 내린다 */
export function link(): void {
  if (linked) return;
  linked = true;
  const isScreen = () => useNekoStore.getState().stage.placement === "screen";
  void listen<NekoEvt>("neko-evt", (e) => { if (remote) dispatchEvt(e.payload); }).catch(() => {});
  void listen("neko-screen-ready", () => {
    if (!isScreen()) return;
    remote = createRemoteNeko();
    held = new Set(); // 새 엔진은 아무것도 안 잡았다(바뀔 때만 알린다)
    remote.setAppearance(useNekoStore.getState().appearance);
    const { screenScale, screenFps } = useNekoStore.getState().stage;
    void emitTo(SCREEN_LABEL, "neko-screen-scale", screenScale).catch(() => {});
    void emitTo(SCREEN_LABEL, "neko-screen-fps", screenFps).catch(() => {});
    pushDecor(); // 마당에 놓인 선물(이 모니터 것)
    remote.setAway(awayNow, { music: awayMusic }); // 산책 중이면 팻말(음악을 듣다 나갔으면 음표)
    notify(); // useNekoController 가 대리를 주고, 감독이 새 스케줄러로 계획을 처음부터 다시 그린다
  }).catch(() => {});
  // 마당 선물: 바뀌면 다시 넘기고, 화면 창에서 끌어 옮기거나 갖고 놀거나 '정리'를 누르면 선물함에 적는다
  void useNekoGifts.getState().load();
  useNekoGifts.subscribe((s, p) => {
    if (s.gifts === p.gifts) return;
    // 선물함 '놓기·걸기·여기로'는 모니터를 모른다(다른 창): 마당에 새로 놓인 것은 고양이가 있는 모니터로 — 주 모니터로
    // 가면 고양이가 다른 모니터에 있을 때 사용자가 못 본다. 이미 마당에 있던 것(예전에 놓아 모니터가 없는 것)·막 불러온 것은 그대로
    const cat = screens?.cat;
    const moved = (g: NekoGift) => { const was = p.gifts.find((o) => o.id === g.id); return !!was && was.placed?.at !== "screen"; };
    const fresh = cat ? s.gifts.filter((g) => g.placed?.at === "screen" && !g.placed.screen && moved(g)) : [];
    if (fresh.length) { for (const g of fresh) useNekoGifts.getState().place(g.id, "auto", "screen", cat!); return; } // 다시 불려 그때 넘긴다
    pushDecor();
  });
  // 모니터 목록·고양이가 건너감·선물 창이 새로 뜸: 다시 나눈다
  void listen<Screens>("neko-screens", (e) => {
    if (e.payload.cat !== screens?.cat) held = new Set();
    screens = e.payload;
    pushDecor();
  }).catch(() => {});
  void invoke<Screens | null>("neko_screen_screens").then((s) => { if (s && !screens) { screens = s; pushDecor(); } }).catch(() => {});
  void listen("neko-decor-ready", () => pushDecor()).catch(() => {});
  void listen<{ id: string; screen: string; x: number; y: number }>("neko-screen-put-on", (e) => putOn(e.payload)).catch(() => {});
  // 선물 창에서 끌어 옮김(그 모니터 안)
  void listen<{ id: string; screen: string } & NekoDecorSpot>("neko-decor-move", (e) => {
    const { id, screen, ...spot } = e.payload;
    useNekoGifts.getState().place(id, spot, "screen", screen);
  }).catch(() => {});
  addListener("decorHeld", (p) => { held = new Set(p as string[]); pushDecor(true); });
  // 엔진 안에서 끌어 옮김(갖고 노느라 잡은 것) = 고양이가 있는 모니터 안. 그 모니터로 적는다(빠진 모니터 것을 주 모니터에서 옮기면 주 모니터 것이 된다)
  addListener("decorMove", (p) => { const { id, ...spot } = p as { id: string } & NekoDecorSpot; useNekoGifts.getState().place(id, spot, undefined, screens?.cat ?? undefined); });
  addListener("decorPlayed", (p) => { const { id, at } = p as { id: string; at: number }; useNekoGifts.getState().played(id, at); });
  void listen<string>("neko-screen-put", (e) => useNekoGifts.getState().place(e.payload, null)).catch(() => {});
  void listen<boolean>("neko-screen-tower", (e) => { towerOk = e.payload === true; }).catch(() => {});
  // 고양이 메뉴 '숨기기'·다시 보임(Rust). 감독은 숨긴 동안 아무 활동도 안 시킨다
  void listen<boolean>("neko-screen-hidden", (e) => useNekoApp.getState().setScreenHidden(e.payload)).catch(() => {});
  useNekoStore.subscribe((s, p) => {
    if (s.appearance !== p.appearance) remote?.setAppearance(s.appearance);
    if (s.stage.screenScale !== p.stage.screenScale) pushDecor();
    if (s.stage.placement !== p.stage.placement) {
      if (s.stage.placement !== "screen") remote = null;
      // 다른 자리에 갔다 돌아왔다: 화면 창은 숨겨 둔 채 살아 있어서 준비 신호를 다시 보내지 않는다.
      // 다시 달라고 해야 대리가 서고 외형·감독 명령이 넘어간다
      else if (!remote) ping();
      notify();
    }
  });
  // 메인 창이 다시 떴는데 화면 창은 살아 있을 때(개발 중 새로 고침): 준비 신호를 다시 받는다
  ping();
}

// 아이폰의 userAgent 에도 "like Mac OS X" 가 있어 폰은 따로 뺀다
const IS_MAC = !IS_PHONE && typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
/** 지금 산책 중인가. 화면 창이 새로 준비되면(다른 자리에서 돌아옴 등) 그때도 팻말 상태를 맞춰 준다 */
let awayNow = false;
let awayMusic = false;

/** App 에서: 자리·산책·'항상 위'·크기에 맞춰 화면 창을 띄우거나 숨긴다 */
export function useNekoScreen(away: boolean, music = false): void {
  const placement = useNekoStore((s) => s.stage.placement);
  const onTop = useNekoStore((s) => s.stage.screenOnTop);
  const scale = useNekoStore((s) => s.stage.screenScale);
  const fps = useNekoStore((s) => s.stage.screenFps);
  // 산책 중에도 화면 창은 둔다: 고양이 대신 마당에 팻말이 선다(엔진 setAway). 팻말은 누를 수 없어 클릭은 지나간다
  const on = IS_MAC && placement === "screen";
  const shown = useRef(false);
  useEffect(() => { awayNow = away; awayMusic = music; getRemoteNeko()?.setAway(away, { music }); }, [away, music]);

  useEffect(() => { if (IS_MAC) link(); }, []);
  useEffect(() => {
    if (!on && !shown.current) return; // 한 번도 안 띄웠으면 창을 만들지 않는다
    shown.current = true;
    invoke("neko_screen_show", { on, onTop }).catch(console.warn);
  }, [on, onTop]);
  useEffect(() => {
    if (on) void emitTo(SCREEN_LABEL, "neko-screen-scale", scale).catch(() => {});
  }, [on, scale]);
  useEffect(() => {
    if (on) void emitTo(SCREEN_LABEL, "neko-screen-fps", fps).catch(() => {});
  }, [on, fps]);
}
