import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTurn, LlmMessage, LoopEvent } from "./types";

/** 안에서만 쓰는 도구(neko.self): 결과는 모델만 보고, 이벤트·끝 스텝(저장·대화 기록)엔 안 나온다(0.1.28) */

vi.mock("../api/tauri", () => ({
  todosApi: { list: vi.fn(async () => []), listDone: vi.fn(), add: vi.fn(), complete: vi.fn() },
  scheduleApi: { list: vi.fn(async () => []), add: vi.fn(), delete: vi.fn() },
  execHistoryApi: { save: vi.fn(async () => {}) },
  conversationApi: { save: vi.fn() },
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
  fsApi: { check: vi.fn(async (path: string) => ({ kind: "allow" as const, path })) },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../lib/events", () => ({ appEvents: { emit: vi.fn() }, requestWordchainFirstWord: vi.fn() }));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));
vi.mock("../neko/selfState", () => ({ selfStateText: async () => "모습: 치즈\n지금: 캣휠 달리는 중" }));

let turns: AgentTurn[] = [];
let sent: LlmMessage[][] = [];
vi.mock("./llm-client", () => ({
  getModelContextLength: () => 32768,
  agentTurnStream: async function* (messages: LlmMessage[]) {
    sent.push(messages);
    yield { type: "turn" as const, turn: turns.shift() ?? { text: "끝", toolCalls: [] } };
  },
  chatStream: async function* () {
    yield { content: "", done: true };
  },
}));

beforeEach(() => {
  sent = [];
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("neko.self", () => {
  it("이벤트 없이 돌고 결과는 다음 모델 호출에만 — 끝 스텝에도 없다. 같이 부른 다른 도구는 그대로 보인다", async () => {
    turns = [
      { text: "", toolCalls: [{ id: "s1", name: "neko.self", params: {} }, { id: "t1", name: "todo.list", params: {} }] },
      { text: "캣휠 타고 있었어", toolCalls: [] },
    ];
    const { runAgentLoop } = await import("./agent-loop");
    const events: LoopEvent[] = [];
    for await (const ev of runAgentLoop("너 뭐 해?", [])) events.push(ev);

    const tools = events.flatMap((e) => (e.type === "tool_start" ? [e.tool] : e.type === "step_done" || e.type === "step_error" ? [e.step.tool] : []));
    expect(tools).not.toContain("neko.self");
    expect(tools).toContain("todo.list");
    const done = events.find((e) => e.type === "done");
    expect(done?.type === "done" && done.steps.map((s) => s.tool)).toEqual(["todo.list"]);
    expect(JSON.stringify(sent[1])).toContain("캣휠 달리는 중");
  });
});
