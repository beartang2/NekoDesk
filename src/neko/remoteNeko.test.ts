// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { useNekoApp } from "./director/stores";
import { useNekoStore } from "./nekoStore";
import { useNekoGifts, type GiftPlacement } from "./gifts";
import { validateShape } from "./engine/gift-shape";
import { createRemoteNeko, dispatchEvt, getRemoteNeko, link, type NekoCmd } from "./remoteNeko";

const tauri = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  sent: [] as [string, string, unknown][],
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (ev: string, fn: (e: { payload: unknown }) => void) => { tauri.handlers.set(ev, fn); return () => {}; },
  emitTo: async (to: string, ev: string, payload?: unknown) => { tauri.sent.push([to, ev, payload]); },
}));

describe("remoteNeko(대리 컨트롤러)", () => {
  it("부른 것을 그대로 화면 창에 넘기고, 값이 필요한 것만 여기서 답한다", () => {
    const sent: NekoCmd[] = [];
    const neko = createRemoteNeko((c) => sent.push(c));
    neko.setMood("sleepy");
    neko.tail("up", 2);
    expect(sent).toEqual([{ m: "setMood", args: ["sleepy"] }, { m: "tail", args: ["up", 2] }]);
    // 스케줄러는 act() 직후 activity 를 동기로 읽는다
    neko.act("typing");
    expect(neko.activity).toBe("typing");
    expect(neko.react("pet")).toBe(true);
    expect(neko.drop()).toEqual([]);
    expect(neko.hit(1, 2)).toBe(false);
    // 화면 창 엔진이 활동을 끝내면(한 번짜리 끝·잡힘) 바로잡는다 — 그래야 스케줄러가 다시 시킬 수 있다
    dispatchEvt({ ev: "activity", payload: null });
    expect(neko.activity).toBeNull();
    // await 해도 thenable 로 오인되지 않는다
    expect((neko as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("화면 창 이벤트를 구독자에게 넘기고, 만지면 '앱을 쓰는 중'으로 친다", () => {
    const neko = createRemoteNeko(() => {});
    const got: unknown[] = [];
    const off = neko.on("activity", (a) => got.push(a));
    useNekoApp.setState({ lastActiveAt: 0 });
    dispatchEvt({ ev: "activity", payload: "box" });
    expect(got).toEqual(["box"]);
    expect(useNekoApp.getState().lastActiveAt).toBe(0); // 활동 바뀜은 만진 게 아니다
    dispatchEvt({ ev: "pet" });
    expect(useNekoApp.getState().lastActiveAt).toBeGreaterThan(0);
    off();
    dispatchEvt({ ev: "activity", payload: null });
    expect(got).toEqual(["box"]);
  });

  it("곁들임: mix 는 보내면서 바꿔 두고, 화면 창의 side 이벤트로 바로잡는다", () => {
    const sent: NekoCmd[] = [];
    const r = createRemoteNeko((c) => sent.push(c));
    expect(r.side).toBeNull();
    expect(r.mix("music")).toBe(true);
    expect(r.side).toBe("music");
    expect(sent[sent.length - 1]).toEqual({ m: "mix", args: ["music"] });
    dispatchEvt({ ev: "side", payload: null }); // 화면 창이 거절함(누워 자는 중)
    expect(r.side).toBeNull();
  });

  it("다른 자리에 갔다 화면으로 돌아오면 준비 신호를 다시 받아 대리를 세우고 외형을 넘긴다", () => {
    const ready = () => tauri.handlers.get("neko-screen-ready")?.({ payload: undefined });
    const sentNow = () => tauri.sent.splice(0).map(([, ev, p]) => (ev === "neko-cmd" ? (p as NekoCmd).m : ev));
    useNekoStore.setState((s) => ({ stage: { ...s.stage, placement: "screen" } }));
    link();
    expect(sentNow()).toEqual(["neko-screen-ping"]);
    ready();
    expect(getRemoteNeko()).not.toBeNull();
    expect(sentNow()).toEqual(["setAppearance", "neko-screen-scale", "neko-screen-fps", "setDecor", "setAway"]); // 산책 중이면 팻말

    useNekoStore.getState().setPlacement("sidebar");
    expect(getRemoteNeko()).toBeNull();
    useNekoStore.getState().setPlacement("screen");
    expect(sentNow()).toEqual(["neko-screen-ping"]); // 숨겨 둔 화면 창에 다시 달라고 한다
    ready();
    expect(getRemoteNeko()).not.toBeNull();
    expect(sentNow()).toEqual(["setAppearance", "neko-screen-scale", "neko-screen-fps", "setDecor", "setAway"]);

    useNekoStore.getState().setAppearance({ soft: 0.3 });
    expect(tauri.sent[tauri.sent.length - 1]?.[2]).toMatchObject({ m: "setAppearance", args: [expect.objectContaining({ soft: 0.3 })] });
  });

  it("선물 창: 모니터마다 제 선물, 고양이 모니터는 엔진이 갖고 노느라 잡은 것만 뺀다. 고양이가 건너가면 잡은 목록을 비운다", () => {
    const at = (u: number, screen: string): GiftPlacement => ({ surface: "floor", u, at: "screen", screen });
    const gift = (id: string, placed: GiftPlacement) => ({ id, at: "", title: id, body: "", shape: validateShape(null), placed });
    useNekoGifts.setState({ gifts: [gift("a", at(0.1, "A")), gift("b", at(0.2, "A")), gift("c", at(0.3, "B"))] });
    const scr = (cat: string) => ({ main: "A", cat, screens: ["A", "B"].map((id) => ({ id, layout: { w: 800, h: 600, ground: 560 }, decor: `neko-decor-${id}` })) });
    const items = () => Object.fromEntries(tauri.sent.splice(0).filter(([, ev]) => ev === "neko-decor-items")
      .map(([to, , p]) => [to, (p as { items: { id: string }[] }).items.map((d) => d.id)]));
    tauri.sent.splice(0);
    tauri.handlers.get("neko-screens")?.({ payload: scr("A") });
    expect(items()).toEqual({ "neko-decor-A": ["a", "b"], "neko-decor-B": ["c"] });
    dispatchEvt({ ev: "decorHeld", payload: ["b"] });
    expect(items()).toEqual({ "neko-decor-A": ["a"] }); // 잡은 것만 바뀌면 고양이 모니터 창에만
    tauri.handlers.get("neko-screens")?.({ payload: scr("B") });
    expect(items()).toEqual({ "neko-decor-A": ["a", "b"], "neko-decor-B": ["c"] });
    // 선물 창에서 끌어 옮김은 그 모니터 자리로 적는다
    tauri.handlers.get("neko-decor-move")?.({ payload: { id: "a", screen: "B", surface: "floor", u: 0.5 } });
    expect(useNekoGifts.getState().gifts.find((g) => g.id === "a")?.placed).toMatchObject({ at: "screen", screen: "B", u: 0.5 });
    expect(items()).toEqual({ "neko-decor-A": ["b"], "neko-decor-B": ["a", "c"] });
    // 감독이 혼자 놀 거리를 고를 때 읽는 값: 함수가 아니라 엔진에 넘긴 선물 수, 화면 창이 알린 창 탐험 가능
    const r = createRemoteNeko(() => {});
    expect(r.decorCount).toBe(2);
    expect(r.towerOk).toBe(false);
    tauri.handlers.get("neko-screen-tower")?.({ payload: true });
    expect(r.towerOk).toBe(true);
  });

  it("선물함에서 마당에 새로 놓으면(모니터 모름) 고양이가 있는 모니터로 적는다. 이미 마당에 있던 건 그대로", () => {
    const gift = (id: string, placed?: GiftPlacement) => ({ id, at: "", title: id, body: "", shape: validateShape(null), ...(placed ? { placed } : {}) });
    const scr = { main: "A", cat: "B", screens: ["A", "B"].map((id) => ({ id, layout: { w: 800, h: 600, ground: 560 }, decor: `neko-decor-${id}` })) };
    tauri.handlers.get("neko-screens")?.({ payload: scr });
    // 막 불러온 것(예전에 놓아 모니터가 없음)은 건드리지 않는다
    useNekoGifts.setState({ gifts: [gift("old", { surface: "floor", u: 0.2, at: "screen" }), gift("new")] });
    expect(useNekoGifts.getState().gifts[0].placed?.screen).toBeUndefined();
    tauri.sent.splice(0);
    useNekoGifts.getState().place("new", "auto", "screen"); // 선물함 창이 부르는 꼴(모니터 없음)
    useNekoGifts.getState().place("old", { surface: "floor", u: 0.6 }); // 마당 안에서 옮김
    const by = (id: string) => useNekoGifts.getState().gifts.find((g) => g.id === id)?.placed;
    expect(by("new")).toMatchObject({ at: "screen", screen: "B" });
    expect(by("old")).toMatchObject({ at: "screen", u: 0.6 });
    expect(by("old")?.screen).toBeUndefined();
    const last = tauri.sent.filter(([to, ev]) => to === "neko-decor-B" && ev === "neko-decor-items").pop();
    expect((last?.[2] as { items: { id: string }[] }).items.map((d) => d.id)).toContain("new");
  });
});
