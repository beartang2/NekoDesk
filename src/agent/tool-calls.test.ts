import { describe, it, expect } from "vitest";
import {
  ToolCallAccumulator,
  fromWireToolCalls,
  parseArguments,
  toWireToolCalls,
} from "./tool-calls";
import type { RawToolCallDelta } from "./types";

/**
 * 실제 llama-server(b9630, Qwen3.5 + --jinja)가 보낸 델타 시퀀스.
 * 병렬 호출 2개가 index 로 구분되고, 첫 조각만 id·name 을 싣는다.
 */
const REAL_DELTAS: RawToolCallDelta[][] = [
  [{ index: 0, id: "0rct", name: "todo.list", argumentsFragment: "{" }],
  [{ index: 0, argumentsFragment: "}" }],
  [{ index: 1, id: "g8WL", name: "schedule.list", argumentsFragment: "{" }],
  [{ index: 1, argumentsFragment: '"range":"' }],
  [{ index: 1, argumentsFragment: "today" }],
  [{ index: 1, argumentsFragment: '"' }],
  [{ index: 1, argumentsFragment: "}" }],
];

describe("ToolCallAccumulator", () => {
  it("조각난 병렬 툴 호출을 index 별로 조립한다", () => {
    const acc = new ToolCallAccumulator();
    for (const batch of REAL_DELTAS) acc.push(batch);

    expect(acc.finish()).toEqual([
      { id: "0rct", name: "todo.list", params: {} },
      { id: "g8WL", name: "schedule.list", params: { range: "today" } },
    ]);
  });

  it("델타가 하나도 없으면 비어 있다", () => {
    const acc = new ToolCallAccumulator();
    expect(acc.isEmpty).toBe(true);
    expect(acc.finish()).toEqual([]);
  });

  it("index 가 뒤섞여 도착해도 index 순서로 돌려준다", () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 2, id: "c", name: "third", argumentsFragment: "{}" }]);
    acc.push([{ index: 0, id: "a", name: "first", argumentsFragment: "{}" }]);
    acc.push([{ index: 1, id: "b", name: "second", argumentsFragment: "{}" }]);

    expect(acc.finish().map((c) => c.name)).toEqual(["first", "second", "third"]);
  });

  it("한 청크에 여러 index 가 함께 와도 처리한다", () => {
    const acc = new ToolCallAccumulator();
    acc.push([
      { index: 0, id: "a", name: "todo.list", argumentsFragment: "{}" },
      { index: 1, id: "b", name: "weather.get", argumentsFragment: '{"location":"서울"}' },
    ]);

    expect(acc.finish()).toEqual([
      { id: "a", name: "todo.list", params: {} },
      { id: "b", name: "weather.get", params: { location: "서울" } },
    ]);
  });

  it("name 이 끝내 안 온 슬롯은 버린다", () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, argumentsFragment: "{}" }]);
    expect(acc.finish()).toEqual([]);
  });

  it("id 가 없으면 index 기반 id 를 만든다 — 결과 메시지의 짝을 맞춰야 한다", () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, name: "todo.list", argumentsFragment: "{}" }]);
    expect(acc.finish()[0].id).toBe("call_0");
  });

  it("arguments 가 깨져도 호출을 버리지 않는다 (빈 params 로 실행 → 에러가 모델에게 돌아간다)", () => {
    const acc = new ToolCallAccumulator();
    acc.push([{ index: 0, id: "a", name: "weather.get", argumentsFragment: '{"location":' }]);
    expect(acc.finish()).toEqual([{ id: "a", name: "weather.get", params: {} }]);
  });
});

describe("parseArguments", () => {
  it("빈 문자열과 공백은 빈 객체", () => {
    expect(parseArguments("")).toEqual({});
    expect(parseArguments("   ")).toEqual({});
  });

  it("객체가 아닌 JSON 은 빈 객체", () => {
    expect(parseArguments("[1,2]")).toEqual({});
    expect(parseArguments('"문자열"')).toEqual({});
    expect(parseArguments("42")).toEqual({});
  });

  it("이스케이프된 따옴표를 포함한 코드도 파싱한다", () => {
    const args = JSON.stringify({
      code: 'tell application "Music" to play',
      language: "applescript",
    });
    expect(parseArguments(args)).toEqual({
      code: 'tell application "Music" to play',
      language: "applescript",
    });
  });
});

describe("wire 변환", () => {
  it("비스트리밍 응답의 tool_calls 를 그대로 받는다", () => {
    expect(
      fromWireToolCalls([
        { id: "x", type: "function", function: { name: "todo.list", arguments: "{}" } },
      ])
    ).toEqual([{ id: "x", name: "todo.list", params: {} }]);
  });

  it("undefined·빈 배열은 빈 결과", () => {
    expect(fromWireToolCalls(undefined)).toEqual([]);
    expect(fromWireToolCalls([])).toEqual([]);
  });

  it("대화 이력에 다시 실을 때 왕복해도 값이 유지된다", () => {
    const calls = [{ id: "a", name: "schedule.add", params: { title: "치과", start_at: "2026-08-27" } }];
    expect(fromWireToolCalls(toWireToolCalls(calls))).toEqual(calls);
  });
});
