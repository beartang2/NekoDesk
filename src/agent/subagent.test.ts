// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTurn, LlmMessage } from "./types";

// vi.mock 은 파일 맨 위로 끌어올려지므로 팩토리 안에서 쓸 값은 vi.hoisted 로 만든다.
const { completion, todoAdd } = vi.hoisted(() => ({
  completion: vi.fn(),
  todoAdd: vi.fn(async () => ({ id: 1 })),
}));

vi.mock("./llm-client", () => ({
  fetchCompletionMessage: (...a: unknown[]) => completion(...(a as [LlmMessage[], unknown])),
}));
vi.mock("../api/tauri", () => ({
  todosApi: { list: vi.fn(async () => []), listDone: vi.fn(), add: todoAdd, complete: vi.fn() },
  scheduleApi: { list: vi.fn(async () => []), add: vi.fn(), delete: vi.fn() },
  execHistoryApi: { save: vi.fn() },
  fsApi: {},
  memoryApi: {},
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => [{ title: "결과", url: "https://x", snippet: "요약" }]),
}));
vi.mock("../lib/events", () => ({ appEvents: { emit: vi.fn() }, requestWordchainFirstWord: vi.fn() }));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));

import { runSubagent } from "./subagent";

const turn = (text: string, toolCalls: AgentTurn["toolCalls"] = []) => ({
  text, reasoning: "", toolCalls,
});

beforeEach(() => { completion.mockReset(); todoAdd.mockClear(); });

describe("조사 하위 에이전트", () => {
  it("툴 없이 답하면 그게 결과다", async () => {
    completion.mockResolvedValueOnce(turn("아무것도 못 찾았어"));
    expect(await runSubagent("뭔가 조사해")).toBe("아무것도 못 찾았어");
  });

  it("조회 툴 결과를 다시 모델에게 넘기고 요약을 돌려준다", async () => {
    completion
      .mockResolvedValueOnce(turn("", [{ id: "a", name: "web.search", params: { query: "x" } }]))
      .mockResolvedValueOnce(turn("요약: 결과 하나 찾음"));

    expect(await runSubagent("검색해줘")).toBe("요약: 결과 하나 찾음");

    // 두 번째 호출에 tool 결과가 실려 있어야 한다.
    const second = completion.mock.calls[1][0] as LlmMessage[];
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("요약");
    expect(toolMsg?.tool_call_id).toBe("a");
  });

  it("쓰기 툴은 실행하지 않고 이유를 돌려준다", async () => {
    completion
      .mockResolvedValueOnce(turn("", [{ id: "a", name: "todo.add", params: { content: "x" } }]))
      .mockResolvedValueOnce(turn("알겠어, 조회만 할게"));

    await runSubagent("할 일 추가해");

    expect(todoAdd, "쓰기 툴이 실제로 실행됐다").not.toHaveBeenCalled();
    const second = completion.mock.calls[1][0] as LlmMessage[];
    expect(second.find((m) => m.role === "tool")?.content).toContain("조회만 가능해");
  });

  it("모델에게 조회 툴만 보여준다 — 재귀도 이걸로 막힌다", async () => {
    completion.mockResolvedValueOnce(turn("끝"));
    await runSubagent("x");

    const tools = (completion.mock.calls[0][1] as { tools: Array<{ function: { name: string } }> }).tools;
    const names = tools.map((t) => t.function.name);
    expect(names).toContain("web.search");
    expect(names).not.toContain("todo.add");
    expect(names).not.toContain("code.exec");
    expect(names, "하위 에이전트가 또 위임할 수 있으면 무한 재귀다").not.toContain("agent.delegate");
  });

  it("상한에 닿으면 툴을 빼앗아 요약을 강제한다", async () => {
    // 계속 툴만 부르는 모델.
    completion.mockResolvedValue(
      turn("", [{ id: "a", name: "web.search", params: { query: "x" } }])
    );
    const out = await runSubagent("끝없이 검색해");

    const last = completion.mock.calls[completion.mock.calls.length - 1][1] as { tools?: unknown };
    expect(last.tools, "마지막 호출에도 툴을 줬다").toBeUndefined();
    expect(out).toContain("상한");
  });

  it("툴이 던져도 하위 에이전트는 계속 돈다", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("네트워크 끊김"));
    completion
      .mockResolvedValueOnce(turn("", [{ id: "a", name: "web.search", params: { query: "x" } }]))
      .mockResolvedValueOnce(turn("검색이 안 됐어"));

    expect(await runSubagent("검색")).toBe("검색이 안 됐어");
    const second = completion.mock.calls[1][0] as LlmMessage[];
    expect(second.find((m) => m.role === "tool")?.content).toContain("오류");
  });
});
