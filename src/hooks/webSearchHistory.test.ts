// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildHistory, parseMeta, serializeMeta, type ChatMessage } from "./useAgentLoop";
import { AgentContext, historyBudget } from "../agent/agent-context";
import { estimateMessagesTokens } from "../agent/token-estimate";
import type { AgentStep } from "../agent/types";

const step = (id: number, tool: string, summary: string): AgentStep =>
  ({ id, thought: "", tool, params: { query: "q" }, result: null, summary, status: "done" });

/**
 * 지난 웹 검색 정리는 다음 요청에도 끝까지 실린다(0.1.35). 2000자로 자르니 뒤쪽 항목이 안 보여 유르미가 제 답을
 * "검색 결과에 없던 내용" 이라며 철회했다. 다른 도구(긁어 온 페이지)는 예전처럼 저장 길이로 자른다.
 */
describe("지난 웹 검색 정리", () => {
  it("2000자를 넘어도 저장·다시 열기·다음 요청의 도구 결과에 끝까지 실린다", () => {
    const search = `${"앞쪽 항목. ".repeat(500)}\n- 맨 끝 항목\n\n출처:\n- 끝 출처 (https://example.com/last)`;
    const page = `${"페이지 글 ".repeat(800)}페이지 끝`;
    expect(search.length).toBeGreaterThan(2000);

    // 저장했다 다시 연 답(대화 DB 의 meta)
    const meta = parseMeta(serializeMeta({ steps: [step(1, "web.search", search), step(2, "web.scrape", page)] }));
    expect(meta.steps?.[0].summary).toBe(search);
    expect(meta.steps?.[1].summary.length).toBeLessThan(page.length);

    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "이번 달 테크 제품", time: "" },
      { id: "a1", role: "assistant", content: "찾은 제품들", time: "", steps: meta.steps },
    ];
    const sent = new AgentContext(buildHistory(messages), "다음 질문", true, 128_000, true).toMessages();
    const results = sent.filter((m) => m.role === "tool").map((m) => String(m.content));
    expect(results).toHaveLength(2);
    expect(results[0]).toContain(search);
    expect(results[0]).toContain("끝 출처 (https://example.com/last)");
    expect(results[1]).not.toContain("페이지 끝");
  });

  it("예산이 모자라면 예전처럼 첫·끝 줄로 줄이거나 빼고, 예산을 넘지 않는다", () => {
    const search = `${"앞쪽 항목. ".repeat(500)}\n- 맨 끝 항목`;
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "질문", time: "" },
      { id: "a1", role: "assistant", content: "답", time: "", steps: [step(1, "web.search", search)] },
    ];
    const sent = new AgentContext(buildHistory(messages), "다음 질문", true, 2048).toMessages();
    expect(estimateMessagesTokens(sent)).toBeLessThanOrEqual(historyBudget(2048, false));
    expect(sent.some((m) => String(m.content).includes(search))).toBe(false);
  });
});
