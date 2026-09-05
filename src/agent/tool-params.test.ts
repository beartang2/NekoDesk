import { describe, it, expect } from "vitest";
import { getTool, validateToolParams, ToolParamError } from "./tool-registry";

/**
 * GBNF 는 JSON 형태만 강제한다. 여기서는 "의미" 검증 — 필수 필드 누락, 타입
 * 불일치, 잘못된 enum, action 별 조건부 필수 — 이 실행 전에 걸리는지 확인한다.
 */

function validate(tool: Parameters<typeof getTool>[0], params: Record<string, unknown>) {
  return validateToolParams(getTool(tool), params);
}

describe("필수 필드 누락", () => {
  it("todo.add 는 content 가 없으면 거부한다", () => {
    expect(() => validate("todo.add", {})).toThrow(ToolParamError);
  });

  it("schedule.add 는 start_at 이 없으면 거부한다", () => {
    expect(() => validate("schedule.add", { title: "회의" })).toThrow(ToolParamError);
  });

  it("code.exec 는 빈 코드를 거부한다", () => {
    expect(() => validate("code.exec", { code: "" })).toThrow(ToolParamError);
  });

  it("오류 메시지에 문제 필드명이 들어간다", () => {
    expect(() => validate("todo.add", {})).toThrow(/content/);
  });
});

describe("타입 교정", () => {
  it("todo.complete 의 문자열 id 를 숫자로 바꾼다", () => {
    expect(validate("todo.complete", { id: "3" })).toEqual({ id: 3 });
  });

  it("schedule.delete 의 문자열 id 배열도 받아준다", () => {
    expect(validate("schedule.delete", { ids: ["1", "2"] })).toEqual({ ids: [1, 2] });
  });

  it("소수 id 는 거부한다", () => {
    expect(() => validate("todo.complete", { id: 1.5 })).toThrow(ToolParamError);
  });
});

describe("enum 검증", () => {
  it("schedule.list 의 잘못된 range 를 거부한다", () => {
    expect(() => validate("schedule.list", { range: "tomorrow" })).toThrow(ToolParamError);
  });

  it("schedule.list 는 range 생략을 허용한다", () => {
    expect(() => validate("schedule.list", {})).not.toThrow();
  });

  it("code.exec 의 알 수 없는 language 를 거부한다", () => {
    expect(() => validate("code.exec", { code: "print(1)", language: "ruby" })).toThrow(
      ToolParamError
    );
  });
});

describe("URL 검증", () => {
  it("web.scrape 는 URL 이 아닌 값을 거부한다", () => {
    expect(() => validate("web.scrape", { url: "삼성SDS 홈페이지" })).toThrow(ToolParamError);
  });

  it("정상 URL 은 통과시킨다", () => {
    expect(() => validate("web.scrape", { url: "https://example.com" })).not.toThrow();
  });
});

describe("action 별 조건부 필수", () => {
  it("file write 는 content 가 없으면 거부한다", () => {
    expect(() => validate("file", { action: "write", path: "/tmp/a.txt" })).toThrow(
      /content/
    );
  });

  it("file read 는 content 없이 통과한다", () => {
    expect(() => validate("file", { action: "read", path: "/tmp/a.txt" })).not.toThrow();
  });

  it("file 은 알 수 없는 action 을 거부한다", () => {
    expect(() => validate("file", { action: "delete", path: "/tmp/a.txt" })).toThrow(
      ToolParamError
    );
  });

  it("clipboard write 는 text 가 없으면 거부한다", () => {
    expect(() => validate("clipboard", { action: "write" })).toThrow(/text/);
  });

  it("clipboard read 는 text 없이 통과한다", () => {
    expect(() => validate("clipboard", { action: "read" })).not.toThrow();
  });
});

describe("math.eval", () => {
  it("빈 수식을 거부한다", () => {
    expect(() => validate("math.eval", { expression: "" })).toThrow(ToolParamError);
  });

  it("지나치게 긴 수식을 거부한다", () => {
    expect(() => validate("math.eval", { expression: "1+".repeat(300) + "1" })).toThrow(
      ToolParamError
    );
  });

  it("정상 수식을 통과시킨다", () => {
    expect(validate("math.eval", { expression: "1234*56" })).toEqual({
      expression: "1234*56",
    });
  });
});

describe("파라미터 없는 툴", () => {
  it("todo.list 는 빈 params 를 통과시킨다", () => {
    expect(() => validate("todo.list", {})).not.toThrow();
  });

  it("todo.list 는 모델이 붙인 잉여 필드를 무시하고 통과시킨다", () => {
    expect(() => validate("todo.list", { limit: 5 })).not.toThrow();
  });
});
