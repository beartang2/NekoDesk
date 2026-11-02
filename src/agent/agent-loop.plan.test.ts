import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTurn, LlmMessage, LoopEvent } from "./types";

/** plan.* 가 루프 안에서 상태를 들고, 결과가 모델에게 되돌아가는지 확인한다. */

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

let turns: AgentTurn[] = [];
/** 턴마다 모델에게 보낸 메시지. */
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

async function run(): Promise<LoopEvent[]> {
  const { runAgentLoop } = await import("./agent-loop");
  const events: LoopEvent[] = [];
  for await (const ev of runAgentLoop("여러 단계 작업", [])) events.push(ev);
  return events;
}

const setPlan = (steps: string[], id = "p1"): AgentTurn => ({
  text: "", toolCalls: [{ id, name: "plan.set", params: { steps } }],
});
const completeStep = (index: number, id = "p2"): AgentTurn => ({
  text: "", toolCalls: [{ id, name: "plan.complete", params: { index } }],
});

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("plan 툴", () => {
  it("계획 전체를 툴 결과로 되돌려준다 — 모델이 매 턴 다시 읽는다", async () => {
    turns = [setPlan(["파일 찾기", "요약하기"]), { text: "했어", toolCalls: [] }];

    const events = await run();
    const step = events.find((e) => e.type === "step_done")!.step;
    expect(step.summary).toContain("1. [ ] 파일 찾기");
    expect(step.summary).toContain("2. [ ] 요약하기");
    expect(step.summary).toContain("남은 단계 2개");
  });

  it("완료하면 UI 용 이벤트가 나간다", async () => {
    turns = [setPlan(["a", "b"]), completeStep(1), { text: "했어", toolCalls: [] }];

    const events = await run();
    const updates = events.filter((e) => e.type === "plan_updated");
    expect(updates).toHaveLength(2);
    expect(updates[1].steps).toEqual([
      { text: "a", status: "done" },
      { text: "b", status: "pending" },
    ]);
  });

  it("잘못된 번호는 루프를 죽이지 않고 모델에게 이유를 돌려준다", async () => {
    turns = [setPlan(["a"]), completeStep(9), { text: "다시 할게", toolCalls: [] }];

    const events = await run();
    const error = events.find((e) => e.type === "step_error")!;
    expect(error.step.summary).toContain("1~1");
    expect(events.find((e) => e.type === "done")).toMatchObject({ answer: "다시 할게" });
  });

  it("남은 계획을 다른 툴 결과 뒤에 다시 붙인다 — 모델이 plan.complete 를 잊지 않게", async () => {
    const listTodos: AgentTurn = { text: "", toolCalls: [{ id: "t1", name: "todo.list", params: {} }] };
    turns = [setPlan(["a", "b"]), listTodos, completeStep(2), listTodos, { text: "했어", toolCalls: [] }];
    await run();

    const lastOf = (i: number) => String(sent[i][sent[i].length - 1].content);
    // plan.set 결과 자체가 계획이라 겹쳐 붙이지 않는다.
    expect(lastOf(1).match(/\[계획\]/g)).toBeNull();
    expect(lastOf(2)).toMatch(/^\[todo\.list 결과\][\s\S]*\[계획\]\n1\. \[ \] a/);
    // 다 끝났으면 더 붙이지 않는다.
    expect(lastOf(4)).not.toContain("[계획]");
  });
});
