import { beforeEach, describe, expect, it, vi } from "vitest";

/** 주변 살피기(neko.look, 0.1.33): 방·거실은 가구(조명 켜짐)·선물 수·창밖, 마당은 창 수·대략 위치·크기. 한 줄이 실패해도 나머지 */
const h = vi.hoisted(() => {
  const kv = new Map<string, string>();
  globalThis.localStorage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) } as Storage;
  return { weather: null as unknown, perches: null as unknown, perchFail: false, reply: null as unknown, asked: 0 };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd !== "neko_screen_perches") return null;
    if (h.perchFail) throw new Error("없는 명령");
    return h.perches;
  },
}));
vi.mock("@tauri-apps/api/event", () => {
  const subs = new Map<string, ((e: { payload: unknown }) => void)[]>();
  return {
    listen: async (ev: string, fn: (e: { payload: unknown }) => void) => { subs.set(ev, [...(subs.get(ev) ?? []), fn]); return () => subs.set(ev, (subs.get(ev) ?? []).filter((f) => f !== fn)); },
    emitTo: async (_to: string, ev: string) => {
      if (ev !== "neko-look-ask") return;
      h.asked++;
      if (h.reply) setTimeout(() => (subs.get("neko-look") ?? []).forEach((f) => f({ payload: h.reply })), 0);
    },
    emit: async () => {},
  };
});
vi.mock("./weatherNow", () => ({ weatherNowSnapshot: () => h.weather }));

import { lookAroundText, windowBoxes, windowLine1 } from "./nekoLook";
import { useNekoStore } from "./nekoStore";
import { useNekoFurniture } from "./furniture";
import { useNekoGifts } from "./gifts";

const at = (p: "sidebar" | "dock" | "screen") => useNekoStore.setState({ stage: { ...useNekoStore.getState().stage, placement: p } });
beforeEach(() => {
  Object.assign(h, { weather: null, perches: null, perchFail: false, reply: null, asked: 0 });
  useNekoGifts.setState({ gifts: [
    { id: "g1", title: "솔방울", body: "", at: "", shape: { v: 1, parts: [] }, placed: { at: "dock", surface: "floor", u: 0.3 } },
    { id: "g2", title: "액자", body: "", at: "", shape: { v: 1, parts: [] }, placed: { at: "screen", surface: "floor", u: 0.6 } },
  ] as never });
});

describe("방·거실", () => {
  it("놓인 가구(조명은 켜짐·꺼짐, 이름이 앞·id 는 줄 끝)·선물 수·창밖. 날씨를 모르면 커튼이 닫혀 있다는 사실", async () => {
    at("dock");
    useNekoFurniture.setState({ items: [
      { id: "base:lamp", kind: "lamp", place: { at: "dock", slot: 0 }, lamp: true },
      { id: "base:sofa", kind: "sofa", place: { at: "dock", slot: 1 } },
      { id: "walk:a", kind: "free", title: "낡은 사다리", place: { at: "dock", slot: 2 } },
      { id: "base:wheel", kind: "wheel", place: { at: "sidebar", slot: 0 } },
    ] as never });
    const t = await lookAroundText();
    expect(t).toContain("있는 곳: 거실");
    expect(t).toContain("- 조명 — 켜짐 | id=base:lamp");
    expect(t).toContain("- 소파 | id=base:sofa");
    expect(t).toContain("- '낡은 사다리'(물어온 가구) | id=walk:a");
    expect(t).not.toContain("캣휠"); // 다른 장소 가구
    expect(t).toContain("놓인 선물: 1개");
    expect(t).toContain("창밖: 커튼이 닫혀 있다");
    h.weather = { label: "맑음", temp: 4.4, is_day: false, sunrise: null, sunset: null };
    expect(await lookAroundText()).toContain("창밖: 밤, 맑음 4°");
  });
});

describe("마당", () => {
  const P = { tops: [{ win: 1, x0: 100, x1: 1100, y: 200 }, { win: 2, x0: 1500, x1: 1700, y: 400 }], walls: [{ win: 1, x: 100, y0: 200, y1: 800 }, { win: 3, x: 50, y0: 900, y1: 950 }] };
  it("보이는 창 수와 네코 기준 대략 위치·크기(창 이름·내용 없음), 올라앉은 창 표시", async () => {
    at("screen");
    h.perches = P;
    h.reply = { cat: [1200, 1000], w: 2000, h: 1100, perch: 2 };
    const t = await lookAroundText();
    expect(t).toContain("있는 곳: 마당");
    expect(t).toContain("보이는 창: 3개");
    expect(t).toContain("- 큰 창: 네코 왼쪽 위");
    expect(t).toContain("- 작은 창: 네코 오른쪽 위(지금 올라앉은 창)");
    expect(t).toContain("놓인 선물: 1개");
    expect(t).not.toMatch(/가구|창밖/);
  });
  it("한 줄이 실패해도(명령 없음) 나머지를 돌려주고, 고양이 자리를 모르면 화면 기준으로", async () => {
    at("screen");
    h.perchFail = true;
    const t = await lookAroundText();
    expect(t).toBe("있는 곳: 마당\n보이는 창: 알 수 없음\n놓인 선물: 1개");
    const [b] = windowBoxes(P);
    expect(windowLine1(b, { w: 2000, h: 1100 }, null, null)).toBe("- 큰 창: 화면 왼쪽 위");
    expect(windowBoxes({ tops: [{ win: 1, x0: NaN, x1: 1, y: 1 }], walls: [] } as never)).toEqual([]);
  });
});
