import { describe, it, expect } from "vitest";
import { AgentContext, type ContextTurn } from "./agent-context";
import { estimateMessagesTokens } from "./token-estimate";
import type { AgentStep, LlmMessage } from "./types";

function step(tool: string, summary: string): AgentStep {
  return { id: 1, thought: "", tool, params: {}, result: null, summary, status: "done" };
}

function turn(tool: string, summary: string, id = "c1"): ContextTurn {
  return {
    text: "",
    calls: [{ call: { id, name: tool, params: {} }, step: step(tool, summary) }],
  };
}

function history(n: number): LlmMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `지난 대화 ${i} — ${"내용".repeat(20)}`,
  }));
}

describe("AgentContext 예산", () => {
  it("현재 사용자 메시지는 예산이 빠듯해도 항상 들어간다", () => {
    const ctx = new AgentContext(history(50), "지금 물어본 것", true, 2048);
    const messages = ctx.toMessages();
    expect(messages.some((m) => m.content === "지금 물어본 것")).toBe(true);
  });

  it("예산 안에서 최근 대화부터 채운다 — 오래된 것이 먼저 밀린다", () => {
    const ctx = new AgentContext(history(50), "질문", true, 4096);
    const kept = ctx.toMessages().filter((m) => typeof m.content === "string" && m.content.startsWith("지난 대화"));

    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(50);
    // 남은 것들은 뒤쪽(최근) 것이어야 한다.
    const indices = kept.map((m) => Number((m.content as string).match(/지난 대화 (\d+)/)![1]));
    expect(Math.min(...indices)).toBeGreaterThan(0);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it("컨텍스트가 크면 더 많이 싣는다 — 고정 6개 컷이 아니다", () => {
    const small = new AgentContext(history(50), "질문", true, 4096).toMessages().length;
    const large = new AgentContext(history(50), "질문", true, 32768).toMessages().length;
    expect(large).toBeGreaterThan(small);
  });

  it("전체 추정 토큰이 예산 안에 든다", () => {
    const ctx = new AgentContext(history(100), "질문", true, 8192);
    for (let i = 0; i < 20; i++) ctx.addTurn(turn("web.search", "결과 ".repeat(200), `c${i}`));

    const used = estimateMessagesTokens(ctx.toMessages());
    expect(used).toBeLessThanOrEqual(Math.floor(8192 * 0.35));
  });

  it("최근 툴 결과는 전문, 오래된 것은 줄여 싣는다", () => {
    const ctx = new AgentContext([], "질문", true, 32768);
    // condense 임계값(200자)을 확실히 넘겨야 줄이는 동작이 드러난다.
    const long = Array.from({ length: 40 }, (_, i) => `줄 ${i} ${"내용".repeat(10)}`).join("\n");
    for (let i = 0; i < 6; i++) ctx.addTurn(turn("code.exec", long, `c${i}`));

    const toolMessages = ctx.toMessages().filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(6);
    const oldest = toolMessages[0].content as string;
    const newest = toolMessages[toolMessages.length - 1].content as string;

    expect(newest).toContain("줄 39");
    expect(oldest).not.toContain("줄 20");
    expect(oldest).toContain("…");
  });

  it("턴이 잘리면 생략됐다고 알린다 — 조용히 사라지면 모델이 헷갈린다", () => {
    const ctx = new AgentContext([], "질문", true, 2048);
    for (let i = 0; i < 30; i++) ctx.addTurn(turn("web.search", "결과 ".repeat(300), `c${i}`));

    const notice = ctx.toMessages().find(
      (m) => typeof m.content === "string" && m.content.includes("생략됨")
    );
    expect(notice).toBeDefined();
  });

  it("작업 중에 덧붙인 말은 그 턴의 도구 결과 바로 뒤에 실린다", () => {
    const ctx = new AgentContext([], "질문", true, 32768);
    ctx.addTurn(turn("web.search", "결과 1", "a"));
    ctx.addFollowUp("아 그리고 가격도 봐줘");
    ctx.addTurn(turn("web.search", "결과 2", "b"));

    const roles = ctx.toMessages().map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user", "assistant", "tool"]);
    expect(ctx.toMessages()[3].content).toBe("아 그리고 가격도 봐줘");
  });

  it("덧붙인 말은 그 턴이 예산에 밀려 접혀도 남는다", () => {
    const ctx = new AgentContext([], "질문", true, 2048);
    ctx.addTurn(turn("web.search", "결과 ".repeat(300), "first"));
    ctx.addFollowUp("이건 잊으면 안 돼");
    for (let i = 0; i < 30; i++) ctx.addTurn(turn("web.search", "결과 ".repeat(300), `c${i}`));

    const messages = ctx.toMessages();
    expect(messages.some((m) => m.role === "tool" && m.tool_call_id === "first")).toBe(false);
    expect(messages.some((m) => m.content === "이건 잊으면 안 돼")).toBe(true);
  });

  it("native 모드는 tool_call_id 로 결과를 짝짓는다", () => {
    const ctx = new AgentContext([], "질문", true, 32768);
    ctx.addTurn({
      text: "조회할게",
      calls: [
        { call: { id: "a", name: "todo.list", params: {} }, step: step("todo.list", "할 일 1") },
        { call: { id: "b", name: "schedule.list", params: {} }, step: step("schedule.list", "일정 1") },
      ],
    });

    const messages = ctx.toMessages();
    const assistant = messages.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls?.map((c) => c.id)).toEqual(["a", "b"]);
    expect(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["a", "b"]);
  });

  it("json 모드는 tool_calls 없이 예전 형식을 쓴다", () => {
    const ctx = new AgentContext([], "질문", false, 32768);
    ctx.addTurn(turn("todo.list", "할 일 1"));

    const messages = ctx.toMessages();
    expect(messages.find((m) => m.role === "assistant")?.tool_calls).toBeUndefined();
    expect(messages.find((m) => m.role === "tool")?.tool_call_id).toBeUndefined();
  });
});

describe("buildToolContext", () => {
  it("예산 안에서 최신 결과를 우선한다", () => {
    const ctx = new AgentContext([], "질문", true, 2048);
    for (let i = 0; i < 30; i++) ctx.addTurn(turn("web.search", `결과${i} ${"내용".repeat(50)}`, `c${i}`));

    const text = ctx.buildToolContext();
    expect(text).toContain("결과29");
    expect(text).not.toContain("결과0 ");
  });

  it("실패한 스텝은 넣지 않는다", () => {
    const ctx = new AgentContext([], "질문", true, 32768);
    const failed = step("code.exec", "터졌음");
    failed.status = "error";
    ctx.addTurn({ text: "", calls: [{ call: { id: "a", name: "code.exec", params: {} }, step: failed }] });
    expect(ctx.buildToolContext()).toBe("");
  });
});
