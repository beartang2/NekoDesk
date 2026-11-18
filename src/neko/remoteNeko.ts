import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { NekoActivity, NekoController, NekoDecorSpot, NekoEvents } from "./engine/neko-engine";
import { useNekoApp } from "./director/stores";
import { useNekoStore } from "./nekoStore";
import { decorItems, useNekoGifts } from "./gifts";

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
  const own: Record<string, unknown> = {
    on: addListener,
    act: (a: NekoActivity | null) => { activity = a ?? null; send({ m: "act", args: [a] }); },
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
      if (key === "carrying") return false;
      if (typeof key !== "string" || key === "then") return undefined; // await·Promise 판별에 걸리지 않게
      return own[key] ?? ((...args: unknown[]) => send({ m: key, args }));
    },
  });
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
    remote.setAppearance(useNekoStore.getState().appearance);
    const { screenScale, screenFps } = useNekoStore.getState().stage;
    void emitTo(SCREEN_LABEL, "neko-screen-scale", screenScale).catch(() => {});
    void emitTo(SCREEN_LABEL, "neko-screen-fps", screenFps).catch(() => {});
    remote.setDecor(decorItems(useNekoGifts.getState().gifts, "screen")); // 마당에 놓인 선물
    remote.setAway(awayNow); // 산책 중이면 팻말
    notify(); // useNekoController 가 대리를 주고, 감독이 새 스케줄러로 계획을 처음부터 다시 그린다
  }).catch(() => {});
  // 마당 선물: 바뀌면 다시 넘기고, 화면 창에서 끌어 옮기거나 갖고 놀거나 '정리'를 누르면 선물함에 적는다
  void useNekoGifts.getState().load();
  useNekoGifts.subscribe((s, p) => { if (s.gifts !== p.gifts) remote?.setDecor(decorItems(s.gifts, "screen")); });
  addListener("decorMove", (p) => { const { id, ...spot } = p as { id: string } & NekoDecorSpot; useNekoGifts.getState().place(id, spot); });
  addListener("decorPlayed", (p) => { const { id, at } = p as { id: string; at: number }; useNekoGifts.getState().played(id, at); });
  void listen<string>("neko-screen-put", (e) => useNekoGifts.getState().place(e.payload, null)).catch(() => {});
  useNekoStore.subscribe((s, p) => {
    if (s.appearance !== p.appearance) remote?.setAppearance(s.appearance);
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

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
/** 지금 산책 중인가. 화면 창이 새로 준비되면(다른 자리에서 돌아옴 등) 그때도 팻말 상태를 맞춰 준다 */
let awayNow = false;

/** App 에서: 자리·산책·'항상 위'·크기에 맞춰 화면 창을 띄우거나 숨긴다 */
export function useNekoScreen(away: boolean): void {
  const placement = useNekoStore((s) => s.stage.placement);
  const onTop = useNekoStore((s) => s.stage.screenOnTop);
  const scale = useNekoStore((s) => s.stage.screenScale);
  const fps = useNekoStore((s) => s.stage.screenFps);
  // 산책 중에도 화면 창은 둔다: 고양이 대신 마당에 팻말이 선다(엔진 setAway). 팻말은 누를 수 없어 클릭은 지나간다
  const on = IS_MAC && placement === "screen";
  const shown = useRef(false);
  useEffect(() => { awayNow = away; getRemoteNeko()?.setAway(away); }, [away]);

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
