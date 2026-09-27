import { describe, it, expect } from "vitest";
import { buildDecisionGrammar, createDecisionTracker, toolFromPrefix, JSON_RULES } from "./decision";
import type { TokenLogprob } from "./types";

const TOOLS = ["todo.list", "todo.add", "code.exec", "web.search", "file", "file.upload", "user.ask", "none"];

/** 토큰 하나. alts 는 그 자리에서 모델이 고려한 다른 후보들(확률). */
function tok(token: string, p: number, alts: Record<string, number> = {}): TokenLogprob {
  const top = Object.entries({ [token]: p, ...alts }).map(([t, q]) => ({ token: t, logprob: Math.log(q) }));
  return { token, logprob: Math.log(p), top_logprobs: top };
}

describe("buildDecisionGrammar", () => {
  const g = buildDecisionGrammar(TOOLS);

  it("도구 이름을 허용 목록으로만 제한한다", () => {
    expect(g).toContain('tool ::= "todo.list" | "todo.add" | "code.exec"');
    // none 은 별도 분기라 tool 목록에 들어가지 않는다
    expect(g).not.toMatch(/tool ::=.*"none"/);
  });

  it("none 이면 finalAnswer 를, 도구면 params 를 쓰게 한다", () => {
    expect(g).toContain('"{\\"tool\\":\\"none\\",\\"params\\":{},\\"finalAnswer\\":" ws string');
    expect(g).toContain('"{\\"tool\\":\\"" tool "\\",\\"params\\":" ws object');
  });

  it("생각(thought) 필드를 쓸 자리가 없다", () => {
    expect(g).not.toContain("thought");
  });

  it("JSON 값 규칙을 그대로 쓴다", () => {
    expect(g.endsWith(JSON_RULES)).toBe(true);
  });
});

describe("createDecisionTracker", () => {
  it("유효한 도구 후보끼리 다시 정규화해서 확신도를 낸다", () => {
    const t = createDecisionTracker(TOOLS);
    const d = t.push([
      tok('{"', 0.9),
      tok("tool", 0.6, { thought: 0.4 }),
      tok('":"', 1),
      // "music" 은 도구가 아니므로 분모에서 빠진다
      tok("code", 0.9, { web: 0.05, todo: 0.03, music: 0.02 }),
      tok(".exec", 0.99),
      tok('","', 1),
    ]);
    expect(d?.tool).toBe("code.exec");
    expect(d?.confidence).toBeCloseTo(0.9 / 0.98, 3);
  });

  it("강제된 접두부({\"tool\":\")의 확률은 확신도에 넣지 않는다", () => {
    // 같은 접두부를 다른 토큰 경계로 쓸 수도 있다({" 대신 {). 둘 다 유효해 보이지만
    // 문법이 강제한 자리라 도구 선택과 무관하다. 모델이 원래 thought 를 쓰고 싶어 한 것도 마찬가지.
    const t = createDecisionTracker(TOOLS);
    const d = t.push([
      tok('{"', 0.6, { "{": 0.4 }),
      tok("tool", 0.05, { thought: 0.95 }),
      tok('":"', 0.7, { '":': 0.3 }),
      tok("none", 1),
      tok('","', 1),
    ]);
    expect(d).toEqual({ tool: "none", confidence: 1 });
  });

  it("이름이 겹치는 도구(file / file.upload)는 끝맺는 토큰에서 갈린다", () => {
    const t = createDecisionTracker(TOOLS);
    const d = t.push([tok('{"tool":"', 1), tok("file", 1), tok('","', 0.6, { ".upload": 0.4 })]);
    expect(d?.tool).toBe("file");
    expect(d?.confidence).toBeCloseTo(0.6, 3);
  });

  it("여러 번 나눠 들어와도 같은 결과를 낸다", () => {
    const t = createDecisionTracker(TOOLS);
    expect(t.push([tok('{"tool":"', 1), tok("web", 0.7, { todo: 0.3 })])).toBeNull();
    const d = t.push([tok(".search", 1), tok('"', 1)]);
    expect(d?.tool).toBe("web.search");
    expect(d?.confidence).toBeCloseTo(0.7, 3);
  });

  it("확률 토큰이 빠져 재구성이 어긋나면 판단하지 않는다(확신도 모름)", () => {
    const t = createDecisionTracker(TOOLS);
    // '":"' 토큰이 빠졌다
    expect(t.push([tok('{"', 1), tok("tool", 1), tok("code", 1), tok(".exec", 1), tok('"', 1)])).toBeNull();
  });
});

describe("toolFromPrefix", () => {
  it("이름이 닫혀야 도구로 본다", () => {
    expect(toolFromPrefix('{"tool":"code.ex')).toBeNull();
    expect(toolFromPrefix('{"tool":"code.exec","params":')).toBe("code.exec");
  });
});
