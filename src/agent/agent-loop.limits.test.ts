import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTurn, ContentPart, LlmMessage, LoopEvent } from "./types";

/**
 * 루프 상한과 실패 사다리를 모델 없이 확인한다.
 * 예전엔 반복 10회 / 같은 실패 2회에 무조건 끊겼다.
 */

vi.mock("../api/tauri", () => ({
  todosApi: { list: vi.fn(async () => []), listDone: vi.fn(), add: vi.fn(), complete: vi.fn() },
  scheduleApi: { list: vi.fn(async () => []), add: vi.fn(), delete: vi.fn() },
  execHistoryApi: { save: vi.fn(async () => {}) },
  conversationApi: { save: vi.fn() },
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
  fsApi: { check: vi.fn(async (path: string) => ({ kind: "allow" as const, path })) },
}));
vi.mock("../lib/events", () => ({ appEvents: { emit: vi.fn() }, requestWordchainFirstWord: vi.fn() }));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));

/** web.search 가 항상 같은 오류로 실패하게 만든다. */
const searchFails = vi.fn(async (): Promise<unknown> => {
  throw new Error("네트워크 오류");
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "web_search") return searchFails();
    return {};
  }),
}));

let nextTurn: (i: number) => AgentTurn = () => ({ text: "끝", toolCalls: [] });
let turnIndex = 0;
/** 모델 호출마다 보낸 메시지. */
let sent: LlmMessage[][] = [];
vi.mock("./llm-client", () => ({
  getModelContextLength: () => 8192,
  agentTurnStream: async function* (messages: LlmMessage[]) {
    sent.push(messages);
    yield { type: "turn" as const, turn: nextTurn(turnIndex++) };
  },
  chatStream: async function* () {
    yield { content: "정리했어", done: true };
  },
}));

async function run(
  input = "해줘",
  takeInterjections?: () => (string | ContentPart[])[]
): Promise<LoopEvent[]> {
  const { runAgentLoop } = await import("./agent-loop");
  const events: LoopEvent[] = [];
  for await (const ev of runAgentLoop(input, [], undefined, undefined, takeInterjections)) events.push(ev);
  return events;
}

const searchTurn = (id: string): AgentTurn => ({
  text: "",
  toolCalls: [{ id, name: "web.search", params: { query: "같은 검색어" } }],
});

beforeEach(() => {
  turnIndex = 0;
  sent = [];
  vi.clearAllMocks();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("루프 반복 상한", () => {
  it("10회를 넘겨서도 계속 돈다 — 예전 상한이었다", async () => {
    // 성공하는 조회를 계속 시킨다. 15번째 턴에서 스스로 끝낸다.
    nextTurn = (i) =>
      i >= 15
        ? { text: "다 봤어", toolCalls: [] }
        : { text: "", toolCalls: [{ id: `c${i}`, name: "todo.list", params: {} }] };

    const events = await run();
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ answer: "다 봤어" });
    expect(events.filter((e) => e.type === "step_done")).toHaveLength(15);
  });

  it("무한히 툴만 부르면 상한에서 끊고 최종 답을 만든다", async () => {
    nextTurn = (i) => ({ text: "", toolCalls: [{ id: `c${i}`, name: "todo.list", params: {} }] });

    const events = await run();
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ answer: "정리했어" });
    // 반복 100회 / 툴 호출 100회 중 먼저 걸리는 쪽에서 멈춘다.
    expect(events.filter((e) => e.type === "step_done").length).toBeLessThanOrEqual(100);
    expect(events.filter((e) => e.type === "step_done").length).toBeGreaterThan(10);
  });
});

describe("실패 사다리", () => {
  it("두 번째 실패에는 시도 이력을 붙여 다시 기회를 준다", async () => {
    nextTurn = (i) => (i < 2 ? searchTurn(`c${i}`) : { text: "포기", toolCalls: [] });

    const events = await run();
    const errors = events.filter((e) => e.type === "step_error");
    expect(errors).toHaveLength(2);
    // 2회차 결과에 이력 힌트가 붙어 컨텍스트로 들어간다.
    expect(errors[1].step.summary).toContain("지금까지 시도한 것");
    // 예전과 달리 여기서 루프가 죽지 않는다.
    expect(events.find((e) => e.type === "done")).toMatchObject({ answer: "포기" });
  });

  it("세 번째 실패면 그 툴을 잠그고, 또 부르면 잠겼다고 알려준다", async () => {
    nextTurn = (i) => (i < 4 ? searchTurn(`c${i}`) : { text: "다른 방법 찾을게", toolCalls: [] });

    const events = await run();
    const errors = events.filter((e) => e.type === "step_error");
    const locked = errors.find((e) => e.step.summary.includes("잠겼어"));
    expect(locked, "잠금 안내가 모델에게 돌아가지 않았다").toBeDefined();
    // 잠긴 뒤에는 툴을 실제로 실행하지 않는다.
    expect(searchFails.mock.calls.length).toBe(3);
  });

  it("네 번째 실패까지 가면 멈추고 시도 이력을 보여준다", async () => {
    // 매번 다른 쿼리로 실패시켜 잠금(같은 실패 3회) 대신 총량 상한에 닿게 한다.
    nextTurn = (i) => ({
      text: "",
      toolCalls: [{ id: `c${i}`, name: "web.search", params: { query: `쿼리${i}` } }],
    });

    const events = await run();
    const done = events.find((e) => e.type === "done");
    expect(done?.answer).toContain("같은 오류가 반복돼서 멈췄어");
    expect(done?.answer).toContain("web.search");
  });
});

describe("같은 웹 조회 반복", () => {
  it("성공한 검색을 또 부르면 실행하지 않고, 두 번 반복하면 모은 결과로 답한다", async () => {
    // 첫 검색만 성공. 모델은 같은 검색만 계속 낸다 — 4B 모델에서 실제로 본 루프.
    searchFails.mockResolvedValueOnce([]);
    nextTurn = (i) => searchTurn(`c${i}`);

    const events = await run();
    expect(searchFails).toHaveBeenCalledTimes(1);
    const repeats = events.filter(
      (e) => e.type === "step_done" && e.step.summary.includes("이미 똑같이 조회했어")
    );
    expect(repeats).toHaveLength(2);
    expect(events.find((e) => e.type === "done")).toMatchObject({ answer: "정리했어" });
  });
});

describe("작업 중에 끼어든 말", () => {
  const listTurn = (i: number): AgentTurn =>
    i >= 2
      ? { text: "다 했어", toolCalls: [] }
      : { text: "", toolCalls: [{ id: `c${i}`, name: "todo.list", params: {} }] };

  it("도구가 끝난 뒤 다음 모델 호출에 실리고, 실었다고 알린다", async () => {
    nextTurn = listTurn;
    // 첫 도구가 도는 사이 한 번 들어온 말.
    const waiting = ["일정도 같이 봐줘"];
    const events = await run("할 일 보여줘", () => waiting.splice(0));

    const lastOf = (messages: LlmMessage[]) => messages[messages.length - 1];
    expect(sent).toHaveLength(3);
    // 첫 호출엔 없다. 둘째 호출의 마지막 메시지가 그 말이다 — 도구 결과 뒤.
    expect(JSON.stringify(sent[0])).not.toContain("일정도 같이 봐줘");
    expect(lastOf(sent[1])).toMatchObject({ role: "user" });
    expect(lastOf(sent[1]).content).toContain("일정도 같이 봐줘");
    // 셋째 호출에도 남아 있다(한 번 싣고 잊지 않는다).
    expect(JSON.stringify(sent[2])).toContain("일정도 같이 봐줘");

    const types = events.map((e) => e.type);
    expect(events.filter((e) => e.type === "user_interjected")).toEqual([
      { type: "user_interjected", stepCount: 1 },
    ]);
    expect(types.indexOf("user_interjected")).toBeGreaterThan(types.indexOf("step_done"));
    expect(events.find((e) => e.type === "done")).toMatchObject({ answer: "다 했어" });
  });

  it("들어온 말이 없으면 아무 일도 없다", async () => {
    nextTurn = listTurn;
    const events = await run("할 일 보여줘", () => []);
    expect(events.some((e) => e.type === "user_interjected")).toBe(false);
  });
});
