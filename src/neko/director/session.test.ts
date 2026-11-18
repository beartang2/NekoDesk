// @vitest-environment jsdom
// 도구 표가 tool-registry(→ settingsStore 가 localStorage 를 읽는다)를 불러온다

import { describe, expect, it } from "vitest";
import { IDLE_SESSION, judgeResult, reduceSession, resultLook } from "./session";
import type { NekoSessionState, NekoSignal, Reaction } from "./types";

/** [시각(초), 신호] 순서를 차례로 넣고 마지막 상태와 반응 목록(시각 포함)을 돌려준다 */
function run(seq: Array<[number, NekoSignal]>, start: NekoSessionState = IDLE_SESSION) {
  let s = start;
  const reactions: Array<[number, Reaction]> = [];
  const states: NekoSessionState[] = [];
  for (const [t, sig] of seq) {
    const out = reduceSession(s, sig, t * 1000);
    if (out.state !== s) states.push(out.state);
    s = out.state;
    for (const r of out.reactions) reactions.push([t, r]);
  }
  return { s, reactions, states };
}
const kinds = (rs: Array<[number, Reaction]>) => rs.map(([, r]) => (r.type === "react" ? r.kind : `tail:${r.sign}`));

describe("세션 상태", () => {
  it("생각 → 도구 → 생각 → 답 → 결과(쓰기 도구 성공 = 떨기, 여운 뒤)", () => {
    const { s, reactions } = run([
      [0, { type: "run_start" }],
      [0.1, { type: "thinking" }],
      [1, { type: "tool_start", tool: "todo.add" }],
      [1.2, { type: "tool_end", tool: "todo.add" }],
      [1.3, { type: "thinking" }],
      [2, { type: "answering" }],
      [3, { type: "done", petState: null }],
    ]);
    expect(s.phase).toBe("result");
    expect(s.result).toMatchObject({ kind: "wrote", at: 3000 });
    expect(kinds(reactions)).toEqual(["cheer"]);
    expect(reactions[0][1]).toMatchObject({ gate: "result" });
  });

  it("도구가 끝나고 생각으로 가면 방금 도구를 기억한다(이어 가기용)", () => {
    const { s } = run([[0, { type: "run_start" }], [1, { type: "tool_start", tool: "web.search" }], [1.5, { type: "tool_end", tool: "web.search" }], [1.6, { type: "thinking" }]]);
    expect(s.phase).toBe("thinking");
    expect(s.lastTool).toMatchObject({ cue: { activity: "window" }, endedAt: 1600 });
    expect(s.tool).toBeNull();
  });

  it("토큰이 수백 번 와도 상태는 단계가 바뀔 때만 바뀐다", () => {
    const seq: Array<[number, NekoSignal]> = [[0, { type: "run_start" }]];
    for (let i = 0; i < 300; i++) seq.push([0.01 * i, { type: "thinking" }]);
    for (let i = 0; i < 300; i++) seq.push([3 + 0.01 * i, { type: "answering" }]);
    const { states } = run(seq);
    expect(states.length).toBe(2); // run_start, answering
  });

  it("중간 오류는 그 자리에서 탁탁, 다시 시도해 성공하면 결과는 성공", () => {
    const { s, reactions } = run([
      [0, { type: "run_start" }],
      [1, { type: "tool_start", tool: "fs.write" }],
      [2, { type: "step_error", tool: "fs.write", cancelled: false }],
      [2.1, { type: "thinking" }],
      [3, { type: "tool_start", tool: "fs.write" }],
      [4, { type: "tool_end", tool: "fs.write" }],
      [5, { type: "done", petState: null }],
    ]);
    expect(kinds(reactions)).toEqual(["sulk", "cheer"]);
    expect(reactions[0][1].gate).toBeUndefined(); // 중간 오류는 바로
    expect(s.result?.kind).toBe("wrote");
  });

  it("마지막 도구가 실패하고 끝나면 실패", () => {
    const { s } = run([[0, { type: "run_start" }], [1, { type: "tool_start", tool: "web.scrape" }], [2, { type: "step_error", tool: "web.scrape", cancelled: false }], [3, { type: "done", petState: null }]]);
    expect(s.result?.kind).toBe("failed");
  });

  it("위험한 확인은 꼬리펑 → 기다림, 보통 확인은 반응 없이 기다림", () => {
    const a = run([[0, { type: "run_start" }], [1, { type: "wait", kind: "confirm", danger: true }]]);
    expect(a.s).toMatchObject({ phase: "waiting", wait: { kind: "confirm", danger: true } });
    expect(kinds(a.reactions)).toEqual(["startle"]);
    const b = run([[0, { type: "run_start" }], [1, { type: "wait", kind: "clarify", danger: false }]]);
    expect(b.s.phase).toBe("waiting");
    expect(b.reactions).toEqual([]);
  });

  it("확인을 승인하면 다시 생각 → 도구", () => {
    const { s } = run([[0, { type: "run_start" }], [1, { type: "wait", kind: "confirm", danger: false }], [3, { type: "wait_end", approved: true }], [3, { type: "tool_start", tool: "code.exec" }]]);
    expect(s).toMatchObject({ phase: "tool", wait: null, tool: { activity: "typing" } });
  });

  it("실행을 취소하면 결과는 '취소'(내리기), 탁탁은 없다", () => {
    const { s, reactions } = run([
      [0, { type: "run_start" }],
      [1, { type: "wait", kind: "confirm", danger: false }],
      [2, { type: "wait_end", approved: false }],
      [2, { type: "step_error", tool: "code.exec", cancelled: true }],
      [2, { type: "answering" }],
      [2.1, { type: "done", petState: null }],
    ]);
    expect(s.result?.kind).toBe("cancelled");
    expect(kinds(reactions)).toEqual(["down"]);
  });

  it("PET_STATE 는 성공의 반응을 바꾸지만 실패는 덮지 못한다", () => {
    const ok = run([[0, { type: "run_start" }], [1, { type: "answering" }], [2, { type: "done", petState: "proud" }]]);
    expect(ok.s.result).toMatchObject({ kind: "plain", petState: "proud" });
    expect(kinds(ok.reactions)).toEqual(["proud"]);
    const bad = run([[0, { type: "run_start" }], [1, { type: "tool_start", tool: "web.search" }], [2, { type: "step_error", tool: "web.search", cancelled: false }], [3, { type: "done", petState: "happy" }]]);
    expect(bad.s.result).toMatchObject({ kind: "failed", petState: null });
    expect(kinds(bad.reactions)).toEqual(["sulk", "sulk"]);
  });

  it("루프 실패는 꼬리펑 → 1.2초 뒤 내리기", () => {
    const { s, reactions } = run([[0, { type: "run_start" }], [1, { type: "loop_error" }]]);
    expect(s.result?.kind).toBe("error");
    expect(kinds(reactions)).toEqual(["startle", "down"]);
    expect(reactions[1][1]).toMatchObject({ delay: 1200 });
  });

  it("멈추면 다 비운다", () => {
    const { s, reactions } = run([[0, { type: "run_start" }], [1, { type: "tool_start", tool: "web.search" }], [2, { type: "abort" }]]);
    expect(s).toMatchObject({ phase: "idle", tool: null, run: null, result: null });
    expect(reactions).toEqual([]);
  });
});

describe("결과 판정", () => {
  it("순서: 취소 > 마지막 실패 > 쓰기 > 도구 > 답만", () => {
    const base = { startedAt: 0, tools: 0, wrote: false, errors: 0, lastFailed: false, cancelled: false };
    expect(judgeResult(null, "done")).toBe("plain");
    expect(judgeResult({ ...base, tools: 2 }, "done")).toBe("used");
    expect(judgeResult({ ...base, tools: 2, wrote: true }, "done")).toBe("wrote");
    expect(judgeResult({ ...base, tools: 2, wrote: true, lastFailed: true }, "done")).toBe("failed");
    expect(judgeResult({ ...base, cancelled: true, lastFailed: true }, "done")).toBe("cancelled");
    expect(judgeResult(base, "loop_error")).toBe("error");
    expect(judgeResult(base, "abort")).toBe("aborted");
  });

  it("결과 모습: 바꿨으면 기뻐하고, 찾아보기만 했으면 기본 표정으로 앉고, 답만이면 바로 기본", () => {
    expect(resultLook("wrote", null)).toMatchObject({ mood: "happy" });
    expect(resultLook("used", null)).toEqual({ mood: "idle", pose: "sit", holdMs: 2500 });
    expect(resultLook("used", "proud")).toMatchObject({ mood: "happy", pose: "sit" });
    expect(resultLook("plain", null).holdMs).toBe(0);
    expect(resultLook("plain", "sleepy")).toMatchObject({ mood: "sleepy", pose: "loaf" });
  });
});
