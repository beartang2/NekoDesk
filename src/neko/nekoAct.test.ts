// @vitest-environment jsdom
// 한 번짜리 표(toolActivity)가 tool-registry(→ settingsStore 가 localStorage 를 읽는다)를 불러온다
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 네코가 자기 행동을 직접 고른다(neko.act, 0.1.32): 지금 이 자리에서 되는 것만, 안 되면 까닭, 고르면 감독의 '고른 활동'으로 */
const h = vi.hoisted(() => ({ big: "awake" as string }));
vi.mock("./presence", () => ({ bigState: () => h.big }));

import { actOptions, actOptionsText, CHOSEN_MS, nekoAct, setActController } from "./nekoAct";
import { ERRAND_T } from "./nekoErrand";
import { useNekoStore } from "./nekoStore";
import { useNekoGifts } from "./gifts";
import { useNekoFurniture } from "./furniture";
import { useNekoApp } from "./director/stores";
import { useNekoNeeds } from "./director/needsStore";
import type { NekoController } from "./engine/neko-engine";

const ctrlWith = (o: { furniture?: { kind: string; uses?: string[] }[]; decorCount?: number; towerOk?: boolean }) => o as unknown as NekoController;
const why = (k: string) => actOptions().find((o) => o.key === k)?.why;

beforeEach(() => {
  h.big = "awake";
  setActController(ctrlWith({ furniture: [] }));
  useNekoApp.setState({ chosen: null, feeding: null, screenHidden: false });
  useNekoNeeds.setState({ needs: { ...useNekoNeeds.getState().needs, energy: 70 } });
  delete document.documentElement.dataset.holding;
});

describe("고를 수 있는 것", () => {
  it("놓인 가구·자유 가구 쓰임새·놓인 선물에 따라 달라진다", () => {
    expect(why("box")).toBeNull(); // 상자 가구가 없으면 임시 상자를 가져와 들어간다(사용자 결정)
    expect(why("wheel")).toBe("그 가구가 이 자리에 없어");
    expect(why("fperch")).toBe("그 쓰임새를 내주는 가구가 이 자리에 없어");
    expect(why("giftplay")).toBe("이 자리에 놓아 둔 선물이 없어");
    expect(why("yarn")).toBeNull();
    setActController(ctrlWith({ furniture: [{ kind: "box" }, { kind: "free", uses: ["perch"] }], decorCount: 2 }));
    expect(why("box")).toBeNull();
    expect(why("fperch")).toBeNull();
    expect(why("giftplay")).toBeNull();
    expect(why("wheel")).toBe("그 가구가 이 자리에 없어");
    expect(actOptionsText()).toContain("상자(box)");
  });
  it("자는 중·산책·밥·붙잡힘·숨김이면 아무것도 못 하고, 기운이 없으면 기운 쓰는 놀이만 못 한다", () => {
    h.big = "sleep";
    expect(why("yarn")).toBe("자는 중이라 못 해");
    h.big = "walk";
    expect(why("groom")).toBe("산책 나가 있어서 못 해");
    h.big = "awake";
    document.documentElement.dataset.holding = "1";
    expect(why("groom")).toBe("사용자가 잡고 있어서 못 해");
    delete document.documentElement.dataset.holding;
    setActController(ctrlWith({ furniture: [{ kind: "wheel" }] }));
    useNekoNeeds.setState({ needs: { ...useNekoNeeds.getState().needs, energy: 5 } });
    expect(why("wheel")).toMatch(/^기운이 없어/);
    expect(why("groom")).toBeNull();
    setActController(null);
    expect(why("groom")).toBe("지금은 무대에 없어서 못 해");
  });
});

describe("neko.act", () => {
  it("되면 감독의 '고른 활동'으로 넘기고 최근 행동 기록에 남긴다. 안 되면 까닭과 되는 것을 돌려준다", () => {
    setActController(ctrlWith({ furniture: [{ kind: "box" }] }));
    expect(nekoAct("wheel")).toMatch(/^캣휠\(wheel\) 못 해 — 그 가구가 이 자리에 없어\. 지금 할 수 있는 것: .*상자\(box\)/);
    expect(useNekoApp.getState().chosen).toBeNull();
    expect(nekoAct("box")).toMatch(/^고름: 상자\(box\)/);
    const c = useNekoApp.getState().chosen!;
    expect(c.kind).toBe("box");
    expect(c.until - c.since).toBe(CHOSEN_MS);
    expect(localStorage.getItem("neko_self_log")).toContain("직접 고름: 상자");
    expect(nekoAct("없는것")).toMatch(/^모르는 행동/);
  });
  it("상자 가구가 없을 때 상자 놀이를 고르면 임시 상자를 가져와 들어간다는 사실을 결과에 담는다", () => {
    expect(nekoAct({ act: "box" })).toContain("가구 상자가 없어 임시 상자를 가져와 들어간다");
  });
});

// ── 시키는 일(0.1.33): 장소 옮기기·선물 다루기·가구 ──────────────────────────────

type Ev = Record<string, ((p: unknown) => void)[]>;
/** 시험용 엔진: leave 하면 곧 exit, enterFrom(put) 하면 곧 put. 부른 것을 적는다 */
function fakeEngine(o: { furniture?: { id: string; kind: string; uses?: string[] }[]; decorCount?: number; noExit?: boolean } = {}) {
  const ev: Ev = {}, calls: [string, unknown[]][] = [];
  const emit = (k: string, p: unknown) => setTimeout(() => (ev[k] ?? []).slice().forEach((f) => f(p)), 0);
  const c = {
    furniture: o.furniture ?? [], decorCount: o.decorCount ?? 0, towerOk: false,
    on: (k: string, f: (p: unknown) => void) => { (ev[k] ??= []).push(f); return () => { ev[k] = ev[k].filter((x) => x !== f); }; },
    leave: (...a: unknown[]) => { calls.push(["leave", a]); if (!o.noExit) emit("exit", a[0]); },
    enterFrom: (...a: unknown[]) => { calls.push(["enterFrom", a]); const put = (a[1] as { put?: string } | undefined)?.put; if (put) emit("put", { id: put.replace("gift:", ""), surface: "floor", u: 0.4 }); },
    aim: (...a: unknown[]) => { calls.push(["aim", a]); const w = a[0] as { fetch?: boolean } | null; if (w?.fetch) emit("exit", "right"); },
    carry: (...a: unknown[]) => calls.push(["carry", a]),
    drop: (...a: unknown[]) => { calls.push(["drop", a]); return []; },
  };
  return { c: c as unknown as NekoController, calls, names: () => calls.map(([m]) => m) };
}
const gift = (id: string, title: string, at: "sidebar" | "dock" | "screen") =>
  ({ id, title, body: "", at: "2026-11-20T00:00:00Z", shape: { v: 1, parts: [] }, placed: { at, surface: "floor", u: 0.5 } }) as never;
const settle = () => new Promise((ok) => setTimeout(ok, 30));

describe("neko.act 시키는 일", () => {
  beforeEach(() => {
    Object.assign(ERRAND_T, { poll: 1, settle: 0, step: 1, sameEngine: 1, out: 200, fetch: 200, put: 200, away: 0, rest: 0 });
    useNekoStore.setState({ stage: { ...useNekoStore.getState().stage, placement: "dock" } });
    useNekoGifts.setState({ gifts: [gift("g1", "도토리 모자", "screen"), gift("g2", "솔방울", "dock"), { ...(gift("g3", "선물함 것", "dock") as object), placed: undefined } as never] });
  });

  it("neko.self 목록: 이름·자리가 앞, id 는 줄 끝 따로 떨어진 칸", () => {
    const t = actOptionsText();
    expect(t).toContain("갈 수 있는 곳(go): 방(room), 마당(yard)");
    expect(t).toMatch(/- '도토리 모자' — 마당 바닥, 11\/20 받음 \| id=g1/);
    expect(t).not.toContain("선물함 것");
  });

  it("장소 옮기기: 걸어 나가(leave → exit) 자리를 바꾸고 반대쪽에서 걸어 들어온다(enterFrom). 그동안 감독은 활동 없이 기다린다", async () => {
    const e = fakeEngine();
    setActController(e.c);
    expect(nekoAct({ go: "room" })).toMatch(/^간다: 거실 → 방/);
    expect(useNekoApp.getState().chosen).toBeNull(); // 말을 마친 뒤
    await settle();
    expect(useNekoStore.getState().stage.placement).toBe("sidebar");
    const [, [side]] = e.calls.find(([m]) => m === "leave")!;
    const [, [from]] = e.calls.find(([m]) => m === "enterFrom")!;
    expect(from).toBe(side === "left" ? "right" : "left");
    expect(e.names().indexOf("leave")).toBeLessThan(e.names().indexOf("enterFrom"));
    expect(useNekoApp.getState().chosen).toBeNull(); // 끝나면 감독을 놓아준다
    expect(nekoAct({ go: "room" })).toBe("이미 방에 있어");
    expect(nekoAct({ go: "kitchen" })).toMatch(/^모르는 곳/);
  });

  it("다른 자리(마당) 선물 물어 오기: 나갔다가 물고 돌아와 내려놓은 자리에 놓인다", async () => {
    const e = fakeEngine();
    setActController(e.c);
    expect(nekoAct({ gift: "g1", how: "bring" })).toMatch(/^한다: 마당에 있는 '도토리 모자'를 가지러 나갔다가 물고 거실로 돌아온다/);
    expect(nekoAct({ go: "room" })).toMatch(/^아직 하던 심부름/);
    await settle();
    expect(e.names()).toEqual(["leave", "carry", "enterFrom"]);
    expect(useNekoGifts.getState().gifts.find((g) => g.id === "g1")?.placed).toMatchObject({ at: "dock", surface: "floor", u: 0.4 });
    expect(useNekoStore.getState().stage.placement).toBe("dock");
  });

  it("지금 자리 선물을 물고 다른 장소로: 그 선물로 가서 물고 나가(aim fetch) 그 장소로 들어와 내려놓는다", async () => {
    const e = fakeEngine({ decorCount: 1 });
    setActController(e.c);
    expect(nekoAct({ gift: "g2", how: "bring", to: "room" })).toMatch(/^한다: '솔방울'을 물고 방으로 옮긴다/);
    await settle();
    expect(e.calls.find(([m]) => m === "aim")?.[1]).toEqual([{ gift: "g2", fetch: true }]);
    expect(useNekoStore.getState().stage.placement).toBe("sidebar");
    expect(useNekoGifts.getState().gifts.find((g) => g.id === "g2")?.placed).toMatchObject({ at: "sidebar", u: 0.4 });
  });

  it("없는 선물·선물함 선물·다른 자리 선물 놀이·자는 중은 거절하고 까닭을 돌려준다", () => {
    const e = fakeEngine({ decorCount: 1 });
    setActController(e.c);
    expect(nekoAct({ gift: "없음", how: "sniff" })).toMatch(/^그 선물이 없어/);
    expect(nekoAct({ gift: "g3", how: "sniff" })).toBe("'선물함 것'은 선물함에 넣어 둬서 놓여 있지 않아");
    expect(nekoAct({ gift: "g1", how: "bat" })).toMatch(/^'도토리 모자'는 마당에 있어/);
    expect(nekoAct({ gift: "g2", how: "sit_on" })).toMatch(/^고름: '솔방울' 위에 앉기/);
    expect(e.calls.find(([m]) => m === "aim")?.[1]).toEqual([{ gift: "g2", play: "sit_on" }]);
    expect(useNekoApp.getState().chosen?.kind).toBe("giftplay");
    h.big = "sleep";
    expect(nekoAct({ go: "room" })).toBe("못 해 — 자는 중이라 못 해");
    expect(nekoAct({ gift: "g1", how: "bring" })).toBe("못 해 — 자는 중이라 못 해");
  });

  it("가구에서 놀기: 이 자리 가구의 놀이만, 자유 가구는 그 가구로(aim fid)", () => {
    const e = fakeEngine({ furniture: [{ id: "base:sofa", kind: "sofa" }, { id: "walk:a1", kind: "free", uses: ["perch", "inside"] }] });
    setActController(e.c);
    expect(actOptionsText()).toContain("- 소파 — sofa | id=base:sofa");
    expect(nekoAct({ furniture: "walk:a1", act: "fhide" })).toMatch(/^고름: 물어온 가구에서 가구 안에 숨기/);
    expect(e.calls.find(([m]) => m === "aim")?.[1]).toEqual([{ fid: "walk:a1" }]);
    expect(nekoAct({ furniture: "base:sofa", act: "wheel" })).toMatch(/^소파에선 소파에서 쉬기\(sofa\)/);
    expect(nekoAct({ furniture: "없음" })).toMatch(/^그 가구가 이 자리\(거실\)에 없어/);
  });
  it("조명: 지금 켜짐·꺼짐과 바뀔 상태를 결과에 적는다(동작은 한 번 톡 그대로)", () => {
    setActController(fakeEngine({ furniture: [{ id: "base:lamp", kind: "lamp" }] }).c);
    useNekoFurniture.setState({ items: [{ id: "base:lamp", kind: "lamp", place: { at: "dock", slot: 0 }, lamp: true }] as never });
    expect(nekoAct({ act: "lamp" })).toContain("켜진 조명을 끄러 간다");
    useNekoFurniture.setState({ items: [{ id: "base:lamp", kind: "lamp", place: { at: "dock", slot: 0 } }] as never });
    expect(nekoAct({ furniture: "base:lamp" })).toContain("꺼진 조명을 켜러 간다");
  });
});
