import { describe, it, expect } from "vitest";
import { FailureTracker, failureKey } from "./failure-tracker";
import type { AgentStep } from "./types";

function execStep(code: string, exitCode = 1): AgentStep {
  return {
    id: 1,
    thought: "",
    tool: "code.exec",
    params: { code, language: "shell" },
    result: { stdout: "", stderr: "command not found: ffmpeg", exit_code: exitCode, truncated: false },
    summary: "exit_code: 1",
    status: "error",
  };
}

function toolStep(tool: string, params: Record<string, unknown>, error: string): AgentStep {
  return {
    id: 1, thought: "", tool, params, result: null,
    summary: `오류: ${error}`, status: "error", errorMessage: error,
  };
}

describe("failureKey", () => {
  it("code.exec 는 work_dir 이 달라도 같은 실패로 본다", () => {
    const a = execStep("ffmpeg -i a.mp4");
    const b = execStep("ffmpeg -i a.mp4");
    b.params = { ...b.params, work_dir: "/tmp" };
    expect(failureKey(a)).toBe(failureKey(b));
  });

  it("코드가 다르면 다른 실패다", () => {
    expect(failureKey(execStep("a"))).not.toBe(failureKey(execStep("b")));
  });
});

describe("FailureTracker 사다리", () => {
  it("1회는 아무 힌트도 덧붙이지 않는다 — 기본 힌트로 충분하다", () => {
    const t = new FailureTracker();
    expect(t.record(execStep("ffmpeg -i a.mp4"))).toEqual({
      hint: "", toolLocked: false, stop: false,
    });
  });

  it("2회는 시도 이력을 보여주고 접근을 바꾸라고 한다", () => {
    const t = new FailureTracker();
    t.record(execStep("ffmpeg -i a.mp4"));
    const advice = t.record(execStep("ffmpeg -i a.mp4"));

    expect(advice.stop).toBe(false);
    expect(advice.hint).toContain("지금까지 시도한 것");
    expect(advice.hint).toContain("ffmpeg -i a.mp4");
    expect(advice.hint).toContain("command not found: ffmpeg");
  });

  it("3회는 그 툴을 잠근다", () => {
    const t = new FailureTracker();
    for (let i = 0; i < 2; i++) t.record(execStep("ffmpeg -i a.mp4"));
    const advice = t.record(execStep("ffmpeg -i a.mp4"));

    expect(advice.toolLocked).toBe(true);
    expect(t.isLocked("code.exec")).toBe(true);
    expect(advice.hint).toContain("더 쓰지 마");
    expect(advice.stop).toBe(false);
  });

  it("4회에야 중단한다 — 예전엔 2회에 끊겼다", () => {
    const t = new FailureTracker();
    for (let i = 0; i < 3; i++) expect(t.record(execStep("x")).stop).toBe(false);
    expect(t.record(execStep("x")).stop).toBe(true);
  });

  it("서로 다른 실패만 계속 쌓여도 총량으로 끊는다", () => {
    const t = new FailureTracker();
    let stopped = false;
    for (let i = 0; i < 8; i++) {
      stopped = t.record(execStep(`try-${i}`)).stop;
    }
    expect(stopped).toBe(true);
  });

  it("성공하면 그 툴의 이력이 지워져 다시 시도할 수 있다", () => {
    const t = new FailureTracker();
    for (let i = 0; i < 3; i++) t.record(execStep("ffmpeg"));
    expect(t.isLocked("code.exec")).toBe(true);

    t.recordSuccess("code.exec");
    expect(t.isLocked("code.exec")).toBe(false);
    // 카운터도 초기화돼 다시 1회부터 센다.
    expect(t.record(execStep("ffmpeg")).hint).toBe("");
  });

  it("툴마다 따로 센다 — 한 툴의 실패가 다른 툴을 잠그지 않는다", () => {
    const t = new FailureTracker();
    for (let i = 0; i < 3; i++) t.record(toolStep("web.search", { query: "x" }, "네트워크 오류"));
    expect(t.isLocked("web.search")).toBe(true);
    expect(t.isLocked("code.exec")).toBe(false);
  });

  it("중단 요약에 최근 시도들이 담긴다", () => {
    const t = new FailureTracker();
    t.record(execStep("first"));
    t.record(execStep("second"));
    expect(t.summary()).toContain("first");
    expect(t.summary()).toContain("second");
  });
});
