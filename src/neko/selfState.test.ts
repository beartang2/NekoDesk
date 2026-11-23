import { beforeEach, describe, expect, it, vi } from "vitest";

/** 네코가 제 상태를 안다(0.1.28): 최근 행동 기록과 내부 도구 결과 */
const h = vi.hoisted(() => {
  const kv = new Map<string, string>();
  globalThis.localStorage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) } as Storage;
  return { kv, settings: new Map<string, string>(), notes: [] as { at: string; kind: string; text: string }[] };
});
vi.mock("../api/tauri", () => ({
  settingsApi: { get: async (k: string) => h.settings.get(k) ?? null, set: async () => {} },
  syncApi: { status: async () => ({}) },
  giftsApi: {},
}));
vi.mock("../agent/neko-mind", () => ({ loadMind: async () => ({ v: 1, notes: h.notes, topics: [] }) }));

const T = Date.parse("2026-11-23T05:00:00Z"); // 14:00 KST
const min = (n: number) => T + n * 60_000;
/** 지금 상태(모듈 안)를 테스트마다 새로 */
const fresh = async () => { vi.resetModules(); return { ...(await import("./selfState")), ...(await import("./nekoStore")) }; };

beforeEach(() => { h.kv.clear(); h.settings.clear(); h.notes = []; });

describe("최근 행동 기록", () => {
  it("20초 넘게 이어진 것만 시작·끝과 함께 남고, 몇 초씩 오간 쉬기·걷기는 안 남는다. 같은 것이 금방 다시 오면 한 줄", async () => {
    const { noteLabel, recentDoings } = await fresh();
    noteLabel("캣휠 달리는 중", min(0));
    noteLabel("쉬는 중", min(10));
    noteLabel("걷는 중", min(10) + 3000);
    noteLabel("쉬는 중", min(10) + 6000);
    noteLabel("자는 중", min(10) + 15_000);
    noteLabel("쉬는 중", min(40));
    noteLabel("자는 중", min(40) + 5000);
    noteLabel("식빵 굽는 중", min(70));
    expect(await recentDoings(min(71))).toBe("- 14:00–14:10 캣휠 달리는 중\n- 14:10–15:10 자는 중\n- 15:10– 식빵 굽는 중(지금)");
  });

  it("산책 기록과 꿈 노트를 시각 순으로 이어 붙이고, 6시간 넘은 것은 뺀다", async () => {
    const { recentDoings } = await fresh();
    h.settings.set("neko_walk", JSON.stringify({ home: null, onMap: false, places: [], path: [[0, 0, min(-60)], [0, 0, min(-30)]], done: true }));
    h.notes = [
      { at: new Date(min(-400)).toISOString(), kind: "dream", text: "오래된 꿈" },
      { at: new Date(min(-20)).toISOString(), kind: "dream", text: "소파가 구름이 되는 꿈" },
      { at: new Date(min(-10)).toISOString(), kind: "wonder", text: "궁금" },
    ];
    expect(await recentDoings(min(0))).toBe("- 13:00–13:30 산책\n- 13:40 꿈: 소파가 구름이 되는 꿈");
  });
});

describe("neko.self 결과", () => {
  it("모습·털 색·자리·지금 하는 일·게이지·최근 기록을 사람이 읽는 말로", async () => {
    const { noteLabel, selfStateText, setShownNeeds, useNekoStore } = await fresh();
    useNekoStore.setState({ appearance: { ...useNekoStore.getState().appearance, coat: "cheese", patterns: ["tabby"], eye: "green", ear: "fold", tail: "bob", legs: "short" } });
    useNekoStore.setState({ stage: { ...useNekoStore.getState().stage, placement: "dock" } });
    setShownNeeds({ hunger: 42, play: 15 });
    noteLabel("캣휠 달리는 중", min(0));
    const text = await selfStateText(min(1));
    expect(text).toContain("모습: 치즈 · 줄무늬 · 연두 눈");
    expect(text).toContain("접힌 귀 · 짧은 꼬리 · 짧은 다리");
    expect(text).toContain("털 색: #e2984a");
    expect(text).toContain("있는 곳: 거실");
    expect(text).toContain("지금: 캣휠 달리는 중");
    expect(text).toContain("상태: 깨어 있음");
    expect(text).toContain("배고픔 42(낮을수록 배고픔) · 놀이 15(낮을수록 심심함)");
    expect(text).toContain("- 14:00– 캣휠 달리는 중(지금)");
  });
});
