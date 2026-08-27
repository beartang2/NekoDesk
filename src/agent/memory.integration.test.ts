import { describe, it, expect, vi, beforeAll } from "vitest";
import type { Memory } from "./types";

/**
 * 기억이 실제 모델의 답에 반영되는지 확인한다. 저장은 인메모리로 흉내내지만
 * (Rust 쪽은 cargo test 가 덮는다), 회상된 문장이 모델에게 닿아 답이 달라지는지는
 * 실제 모델이 아니면 확인할 수 없다.
 */
const LLM_URL = "http://127.0.0.1:8803";
const serverUp = await fetch(`${LLM_URL}/health`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

const store: Memory[] = [];

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../lib/events", () => ({ appEvents: { emit: vi.fn() }, requestWordchainFirstWord: vi.fn() }));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));
vi.mock("../api/tauri", () => ({
  todosApi: { list: vi.fn(async () => []), listDone: vi.fn(), add: vi.fn(), complete: vi.fn() },
  scheduleApi: { list: vi.fn(async () => []), add: vi.fn(), delete: vi.fn() },
  execHistoryApi: { save: vi.fn(async () => {}) },
  conversationApi: { save: vi.fn() },
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
  fsApi: { check: vi.fn(async (path: string) => ({ kind: "allow" as const, path })) },
  memoryApi: {
    save: vi.fn(async (content: string, kind = "fact") => {
      const m = { id: store.length + 1, kind, content, created_at: "", use_count: 0 };
      store.push(m);
      return m;
    }),
    // 아주 단순한 부분 문자열 매칭. 실제 랭킹은 Rust 쪽 테스트가 덮는다.
    search: vi.fn(async (query: string) =>
      store.filter((m) => [...query].some((c) => /[가-힣a-z]/i.test(c) && m.content.includes(c)))
    ),
    list: vi.fn(async () => store),
    delete: vi.fn(async () => true),
  },
}));

beforeAll(() => {
  const kv = new Map<string, string>([["nekodesk_llm_url", LLM_URL]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => kv.get(k) ?? null,
    setItem: (k: string, v: string) => void kv.set(k, v),
    removeItem: (k: string) => void kv.delete(k),
  });
});

describe.skipIf(!serverUp)("기억 — 실서버", () => {
  it(
    "저장해둔 사실이 다음 요청의 답에 반영된다",
    async () => {
      const { runAgentLoop } = await import("./agent-loop");
      const { useSettingsStore } = await import("../stores/settingsStore");
      const { memoryApi } = await import("../api/tauri");
      useSettingsStore.getState().setToolMode("native");

      // 이전 세션에서 알게 된 것.
      await memoryApi.save("사용자가 키우는 고양이 이름은 나비다", "fact");

      // 완전히 새 대화(이력 없음)에서 물어본다.
      let answer = "";
      for await (const ev of runAgentLoop("내 고양이 이름이 뭐였지?", [])) {
        if (ev.type === "done") answer = ev.answer;
        if (ev.type === "error") throw new Error(ev.message);
      }

      expect(answer, `기억이 답에 반영되지 않았다: ${answer}`).toContain("나비");
    },
    240_000
  );
});
