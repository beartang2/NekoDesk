import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "./types";

const db = vi.hoisted(() => ({ memories: [] as Memory[], settings: new Map<string, string>(), reply: null as unknown }));
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
vi.mock("./llm-client", () => ({
  fetchCompletionMessage: async () => ({ text: "", toolCalls: [{ name: "memory_tidy", params: { merges: db.reply } }] }),
}));

import { checkMerges, loadTidyLog, tidyMemories } from "./memory-tidy";

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
});
