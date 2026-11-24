// @vitest-environment jsdom
// 한 번짜리 표(toolActivity)가 tool-registry(→ settingsStore 가 localStorage 를 읽는다)를 불러온다
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 네코가 자기 행동을 직접 고른다(neko.act, 0.1.32): 지금 이 자리에서 되는 것만, 안 되면 까닭, 고르면 감독의 '고른 활동'으로 */
const h = vi.hoisted(() => ({ big: "awake" as string }));
vi.mock("./presence", () => ({ bigState: () => h.big }));

import { actOptions, actOptionsText, CHOSEN_MS, nekoAct, setActController } from "./nekoAct";
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
    expect(why("box")).toBe("그 가구가 이 자리에 없어");
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
});
