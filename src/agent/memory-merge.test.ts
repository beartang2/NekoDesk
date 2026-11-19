import { describe, it, expect, vi } from "vitest";
import type { Memory } from "./types";
import { similarMemories } from "./memory-merge";

const mem = (id: number, content: string): Memory => ({ id, kind: "fact", content, created_at: "", use_count: 0 });

describe("similarMemories", () => {
  it("겹치는 게 많은 순, 안 겹치면 빼고, 같은 글은 뺀다", () => {
    const all = [mem(1, "참치는 비싸다"), mem(2, "엄마 생일은 3월 2일"), mem(3, "아빠 생일은 3월 2일"), mem(4, "XYZ")];
    expect(similarMemories("아빠 생일은 3월 2일", all).map((m) => m.id)).toEqual([2]);
    expect(similarMemories("우리 아빠 생일 3월", all).map((m) => m.id)).toEqual([3, 2]);
  });
});

/** 같은 사실인지 정하는 건 모델이다. 실제 모델로 확인한다. */
const LLM_URL = "http://127.0.0.1:8803";
// llm-client 가 불러올 때 설정 저장소가 localStorage 를 읽는다. import 보다 먼저 둔다.
vi.hoisted(() => {
  const kv = new Map<string, string>([["nekodesk_llm_url", "http://127.0.0.1:8803"]]);
  globalThis.localStorage = {
    getItem: (k: string) => kv.get(k) ?? null,
    setItem: (k: string, v: string) => void kv.set(k, v),
    removeItem: (k: string) => void kv.delete(k),
  } as Storage;
});
const serverUp = await fetch(`${LLM_URL}/health`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

let store: Memory[] = [];
vi.mock("../api/tauri", () => ({
  memoryApi: {
    list: vi.fn(async () => store),
    save: vi.fn(async (content: string, kind: string) => {
      const m = { id: store.length + 100, kind, content, created_at: "", use_count: 0 };
      store = [...store, m];
      return m;
    }),
    delete: vi.fn(async (id: number) => {
      store = store.filter((m) => m.id !== id);
      return true;
    }),
  },
}));

describe.skipIf(!serverUp)("saveMemory — 실서버", () => {
  it("말만 바꾼 같은 사실·바뀐 사실은 대신하고, 다른 사람 이야기는 남긴다", async () => {
    const { saveMemory } = await import("./memory-merge");
    const replaced = async (c: string, k: string) => { const r = await saveMemory(c, k); return "replaced" in r ? r.replaced : null; };
    store = [mem(1, "엄마 생일은 3월 2일"), mem(2, "사용자는 커피를 좋아한다"), mem(3, "사용자의 친구 율리오는 보라색 로봇 아이콘을 쓴다")];

    expect(await replaced("아빠 생일은 3월 2일", "fact")).toEqual([]);
    expect(await replaced("사용자는 이제 커피를 싫어한다", "preference")).toEqual(["사용자는 커피를 좋아한다"]);
    expect(await replaced("율리오는 사용자의 AI 친구로, 보라색 로봇 아이콘을 쓴다", "fact")).toHaveLength(1);
    expect(store.map((m) => m.content)).toEqual([
      "엄마 생일은 3월 2일",
      "아빠 생일은 3월 2일",
      "사용자는 이제 커피를 싫어한다",
      "율리오는 사용자의 AI 친구로, 보라색 로봇 아이콘을 쓴다",
    ]);
  }, 60_000);
});

describe.skipIf(!serverUp)("saveMemory 거르기 — 실서버", () => {
  it("도구로 찾아볼 수 있는 건 안 남기고, 취향·관계는 남긴다", async () => {
    const { saveMemory } = await import("./memory-merge");
    store = [];
    for (const c of ["사용자는 11월 20일 오후 3시에 치과 예약이 있다", "내일 아침 9시에 약 먹으라는 미리 알림을 등록했다", "사용자의 맥 배터리가 지금 40%다", "다운로드 폴더에 보고서.pdf 가 있다"])
      expect(await saveMemory(c, "fact"), c).toHaveProperty("skipped");
    for (const c of ["사용자는 민트초코를 싫어한다", "사용자의 동생 이름은 하린이다", "사용자는 아침마다 달리기를 한다"])
      expect(await saveMemory(c, "preference"), c).toHaveProperty("replaced");
  }, 60_000);
});
