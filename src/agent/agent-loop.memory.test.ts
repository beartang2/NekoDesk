import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTurn, LlmMessage, LoopEvent } from "./types";

/** 요청마다 관련 기억이 자동으로 떠올라 프롬프트에 붙는지 확인한다. */

const memorySearch = vi.fn(async () => [
  { id: 1, kind: "preference", content: "사용자는 아침에 커피를 마신다", created_at: "", use_count: 0 },
]);

vi.mock("../api/tauri", () => ({
  todosApi: { list: vi.fn(async () => []), listDone: vi.fn(), add: vi.fn(), complete: vi.fn() },
  scheduleApi: { list: vi.fn(async () => []), add: vi.fn(), delete: vi.fn() },
  execHistoryApi: { save: vi.fn(async () => {}) },
  conversationApi: { save: vi.fn() },
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
  fsApi: { check: vi.fn(async (path: string) => ({ kind: "allow" as const, path })) },
  memoryApi: { search: memorySearch, save: vi.fn(), list: vi.fn(), delete: vi.fn() },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../lib/events", () => ({ appEvents: { emit: vi.fn() }, requestWordchainFirstWord: vi.fn() }));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));

/** agentTurnStream 이 받은 인자를 기록한다. */
const seenCalls: Array<{ messages: LlmMessage[]; memories: string }> = [];
let turns: AgentTurn[] = [];
vi.mock("./llm-client", () => ({
  getModelContextLength: () => 32768,
  agentTurnStream: async function* (
    messages: LlmMessage[],
    _userInput: string,
    _seq: number,
    memories: string
  ) {
    seenCalls.push({ messages, memories });
    yield { type: "turn" as const, turn: turns.shift() ?? { text: "끝", toolCalls: [] } };
  },
  chatStream: async function* () {
    yield { content: "", done: true };
  },
}));

async function run(input: string): Promise<LoopEvent[]> {
  const { runAgentLoop } = await import("./agent-loop");
  const events: LoopEvent[] = [];
  for await (const ev of runAgentLoop(input, [])) events.push(ev);
  return events;
}

beforeEach(() => {
  seenCalls.length = 0;
  turns = [];
  vi.clearAllMocks();
  memorySearch.mockResolvedValue([
    { id: 1, kind: "preference", content: "사용자는 아침에 커피를 마신다", created_at: "", use_count: 0 },
  ]);
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("기억 자동 회상", () => {
  it("떠올린 기억이 프롬프트로 넘어간다", async () => {
    turns = [{ text: "커피 얘기", toolCalls: [] }];
    await run("아침에 뭐 마실까");

    expect(memorySearch).toHaveBeenCalledWith("아침에 뭐 마실까");
    expect(seenCalls[0].memories).toContain("커피");
    expect(seenCalls[0].memories).toContain("[preference]");
  });

  it("한 요청 안에서는 한 번만 검색한다 — 턴마다 IPC 를 태우지 않는다", async () => {
    turns = [
      { text: "", toolCalls: [{ id: "c1", name: "todo.list", params: {} }] },
      { text: "", toolCalls: [{ id: "c2", name: "todo.list", params: {} }] },
      { text: "끝", toolCalls: [] },
    ];
    await run("할 일 보여줘");

    expect(seenCalls.length).toBe(3);
    expect(memorySearch).toHaveBeenCalledTimes(1);
    // 매 턴 같은 기억을 그대로 쓴다.
    expect(new Set(seenCalls.map((c) => c.memories)).size).toBe(1);
  });

  it("기억이 없으면 빈 문자열이 넘어간다", async () => {
    memorySearch.mockResolvedValue([]);
    turns = [{ text: "끝", toolCalls: [] }];
    await run("처음 보는 얘기");
    expect(seenCalls[0].memories).toBe("");
  });

  it("기억 조회가 실패해도 대화는 계속된다", async () => {
    memorySearch.mockRejectedValue(new Error("DB 오류"));
    turns = [{ text: "괜찮아", toolCalls: [] }];

    const events = await run("안녕");
    expect(events.find((e) => e.type === "done")).toMatchObject({ answer: "괜찮아" });
    expect(seenCalls[0].memories).toBe("");
  });
});
