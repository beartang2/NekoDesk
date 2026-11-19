import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "./types";

const db = vi.hoisted(() => ({ memories: [] as Memory[], settings: new Map<string, string>(), reply: null as unknown, drops: null as unknown }));
vi.mock("../api/tauri", () => ({
  memoryApi: {
    list: async () => db.memories.slice(),
    save: async (content: string, kind: string) => {
      const have = db.memories.find((m) => m.content === content);
      if (have) return have;
      const m = { id: Math.max(0, ...db.memories.map((x) => x.id)) + 1, kind, content, created_at: "", use_count: 0 };
      db.memories.push(m);
      return m;
    },
    delete: async (id: number) => { db.memories = db.memories.filter((m) => m.id !== id); return true; },
  },
  settingsApi: {
    get: async (k: string) => db.settings.get(k) ?? null,
    set: async (k: string, v: string) => void db.settings.set(k, v),
  },
}));
vi.mock("./memory-merge", () => ({ lookupable: async (t: string) => { if (t.includes("판정 실패")) throw new Error("x"); return t.includes("예약"); } }));
vi.mock("./llm-client", () => ({
  fetchCompletionMessage: async () => ({ text: "", toolCalls: [{ name: "memory_tidy", params: { merges: db.reply, drops: db.drops } }] }),
}));

import { checkDrops, checkMerges, loadTidyLog, tidyMemories } from "./memory-tidy";

const mem = (id: number, content: string, kind = "fact"): Memory => ({ id, kind, content, created_at: "", use_count: 0 });

beforeEach(() => {
  db.memories = [
    mem(1, "율리오는 친구"),
    mem(2, "율리오는 AI 친구", "preference"),
    mem(3, "커피를 좋아한다"),
    mem(4, "서울숲에 은행나무가 많다", "neko"),
  ];
  db.settings.clear();
  db.reply = null;
  db.drops = null;
});

describe("쉴 때 기억 정리", () => {
  it("없는 번호·한 개짜리·두 번 쓴 번호·사용자와 산책 섞기·빈 줄은 버린다", () => {
    const out = checkMerges(
      [
        { ids: [1, 2, 99], content: "율리오는 AI 친구" },
        { ids: [2, 3], content: "다시 쓴 2" },
        { ids: [3], content: "혼자" },
        { ids: [3, 4], content: "섞임" },
        { ids: [1, 3], content: "  " },
      ],
      db.memories,
    );
    expect(out).toEqual([{ ids: [1, 2], content: "율리오는 AI 친구", kind: "preference" }]);
    expect(checkMerges("엉뚱", db.memories)).toEqual([]);
  });

  it("합친 줄을 저장하고 원래 것을 지우며, 같은 줄은 남기고, 기록을 남긴다", async () => {
    db.reply = [{ ids: [1, 2], content: "율리오는 AI 친구" }];
    const rec = await tidyMemories();
    expect(rec?.merges).toEqual([{ from: ["율리오는 친구", "율리오는 AI 친구"], to: "율리오는 AI 친구" }]);
    expect(db.memories.map((m) => m.id)).toEqual([2, 3, 4]); // 2 는 합친 줄과 같아 남는다
    expect((await loadTidyLog())[0].merges).toHaveLength(1);
  });

  it("합칠 게 없으면 아무것도 안 바꾸고 기록도 안 남긴다", async () => {
    db.reply = [];
    expect(await tidyMemories()).toBeNull();
    expect(db.memories).toHaveLength(4);
    expect(await loadTidyLog()).toEqual([]);
  });

  it("지울 번호는 있는 사용자 기억만, 합치는 묶음에 든 건 빼고 받는다", () => {
    expect(checkDrops([3, 3, 4, 99, 1], db.memories, new Set([1]))).toEqual([3]);
    expect(checkDrops("엉뚱", db.memories, new Set())).toEqual([]);
  });

  it("도구로 찾아볼 수 있는 기억을 지우고 기록에 남긴다", async () => {
    db.memories.push(mem(5, "사용자는 11월 20일 치과 예약이 있다"), mem(6, "판정 실패 예약"));
    db.reply = [];
    db.drops = [5, 4, 3, 6]; // 3 은 판정이 저장, 6 은 판정 실패 — 둘 다 남는다
    const rec = await tidyMemories();
    expect(rec?.drops).toEqual(["사용자는 11월 20일 치과 예약이 있다"]);
    expect(db.memories.map((m) => m.id)).toEqual([1, 2, 3, 4, 6]); // 산책 기억 4 는 남는다
    expect((await loadTidyLog())[0].drops).toEqual(["사용자는 11월 20일 치과 예약이 있다"]);
  });

  it("한 번에 5개까지만 지운다", async () => {
    for (let i = 10; i < 18; i++) db.memories.push(mem(i, `예약 ${i}`));
    db.reply = [];
    db.drops = [10, 11, 12, 13, 14, 15, 16, 17];
    expect((await tidyMemories())?.drops).toHaveLength(5);
    expect(db.memories.filter((m) => m.id >= 10).map((m) => m.id)).toEqual([15, 16, 17]);
  });
});
