import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "./types";

/** 저장할 때 거르기(memory-merge saveMemory). 판정 모델은 가짜: 글에 따라 "저장"/"안함" 또는 실패 */
const db = vi.hoisted(() => ({ memories: [] as Memory[], judge: (_: string): Promise<string> => Promise.resolve("저장"), asked: [] as string[] }));
vi.mock("../api/tauri", () => ({
  memoryApi: {
    list: async () => db.memories.slice(),
    save: async (content: string, kind: string) => {
      const m = { id: db.memories.length + 1, kind, content, created_at: "", use_count: 0 };
      db.memories.push(m);
      return m;
    },
    delete: async () => true,
  },
}));
vi.mock("./llm-client", () => ({
  fetchCompletion: async (messages: { role: string; content: string }[]) => {
    const text = messages[1].content;
    if (messages[0].content.startsWith("기억으로 남길지")) { db.asked.push(text); return db.judge(text); }
    return "따로"; // 겹침 판정
  },
}));

import { noteCreated, saveMemory, SKIP_LOOKUP } from "./memory-merge";

const LOOKUP = ["치과 예약", "배터리", "보고서.pdf", "다크 모드"];
beforeEach(() => {
  db.memories = [];
  db.asked = [];
  db.judge = async (t) => (LOOKUP.some((w) => t.includes(w)) ? "안함" : "저장");
});

describe("saveMemory 거르기", () => {
  it("판정이 안함이면 저장하지 않고 이유를 돌려준다", async () => {
    for (const c of ["사용자는 11월 20일 치과 예약이 있다", "맥 배터리가 40%다", "다운로드에 보고서.pdf 가 있다", "앱이 다크 모드로 설정돼 있다"])
      expect(await saveMemory(c, "fact")).toEqual({ skipped: SKIP_LOOKUP, content: c });
    expect(db.memories).toEqual([]);
  });

  it("취향·관계·습관은 저장한다", async () => {
    for (const c of ["사용자는 민트초코를 싫어한다", "사용자의 동생 이름은 하린이다", "사용자는 아침마다 달린다"])
      expect(await saveMemory(c, "preference")).toMatchObject({ content: c, replaced: [] });
    expect(db.memories).toHaveLength(3);
  });

  it("판정이 실패하거나 시간이 지나면 저장한다", async () => {
    db.judge = async () => { throw new Error("서버 꺼짐"); };
    expect(await saveMemory("사용자는 11월 20일 치과 예약이 있다", "fact")).toHaveProperty("replaced");
    db.judge = async () => { throw new DOMException("timed out", "TimeoutError"); };
    expect(await saveMemory("맥 배터리가 40%다", "fact")).toHaveProperty("replaced");
    expect(db.memories).toHaveLength(2);
  });

  it("방금 만든 일정·할 일과 겹치면 판정 없이 막고, 안 겹치면 판정으로 넘긴다", async () => {
    db.judge = async () => "저장";
    noteCreated("엄마랑 저녁 약속");
    noteCreated("우유 사기");
    expect(await saveMemory("사용자는 금요일에 엄마랑 저녁 약속이 있다", "project")).toHaveProperty("skipped");
    expect(await saveMemory("우유 사기를 미리 알림에 넣었다", "fact")).toHaveProperty("skipped");
    expect(db.asked).toEqual([]);
    expect(await saveMemory("사용자는 엄마를 좋아한다", "preference")).toHaveProperty("replaced");
    expect(db.asked).toEqual(["사용자는 엄마를 좋아한다"]);
  });

  it("산책 기억은 거르지 않는다", async () => {
    db.judge = async () => "안함";
    expect(await saveMemory("산책하다 알게 됨: 서울숲 배터리 공원", "neko")).toHaveProperty("replaced");
    expect(db.asked).toEqual([]);
  });
});
