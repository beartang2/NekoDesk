// @vitest-environment jsdom
// 도구 표가 tool-registry(→ settingsStore 가 localStorage 를 읽는다)를 불러온다

import { describe, expect, it } from "vitest";
import { deriveNeko } from "./derive";
import { createScheduler } from "./scheduler";
import { IDLE_SESSION, reduceSession } from "./session";
import { FakeClock, FakeCtrl } from "./testing/fakes";
import type { DirectorInput, NekoSignal, Reaction } from "./types";

/** 가짜 시계·엔진 위에 감독을 올린다. 시각은 초 */
function world(init: Partial<DirectorInput> = {}) {
  const clock = new FakeClock();
  const ctrl = new FakeCtrl(clock);
  const input: DirectorInput = {
    session: IDLE_SESSION, feeding: null, fedAt: null, playCue: null, game: null,
    needs: { hunger: 100, play: 60 }, lastActiveAt: 0, outside: { typing: false, at: -Infinity, activity: null }, box: null, ...init,
  };
  const sch = createScheduler(ctrl, clock, (now) => deriveNeko(input, now));
  sch.update();
  ctrl.calls = []; // 처음 자리 잡기는 빼고 본다
  const to = (sec: number) => clock.advanceTo(Math.round(sec * 1000));
  return {
    clock, ctrl, input, sch, to,
    sig(sec: number, s: NekoSignal) {
      to(sec);
      const out = reduceSession(input.session, s, clock.now());
      input.session = out.state;
      if (out.reactions.length) sch.react(out.reactions); else sch.update();
    },
    set(sec: number, patch: Partial<DirectorInput>) { to(sec); Object.assign(input, patch); sch.update(); },
    react(sec: number, rs: Reaction[]) { to(sec); sch.react(rs); },
  };
}

describe("스케줄러 시간표(설계 §8.1)", () => {
  it("1) 검색 → 페이지 읽기가 빨리 와도 창밖을 4초 보인 뒤 신문으로 한 번만, 앉았다 서지 않음", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "tool_start", tool: "web.search" });
    w.sig(0.3, { type: "thinking" });
    w.sig(0.4, { type: "tool_start", tool: "web.scrape" });
    w.to(5);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:window", "4.0 act:reading"]);
    expect(w.ctrl.seen("pose:sit").filter((x) => !x.startsWith("0.0"))).toEqual([]);
  });

  it("2) 위험한 확인 → 꼬리펑·물음표 기다림 → 승인 → 타이핑 → 끝 0.6초 뒤 떨기, 결과 2.5초 뒤 기본", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0.8, { type: "wait", kind: "confirm", danger: true });
    w.sig(3, { type: "wait_end", approved: true });
    w.sig(3, { type: "tool_start", tool: "fs.write" });
    w.sig(4, { type: "tool_end", tool: "fs.write" });
    w.sig(4.1, { type: "thinking" });
    w.sig(4.5, { type: "done", petState: null });
    w.to(9);
    expect(w.ctrl.seen("react:")).toEqual(["0.8 react:startle", "5.1 react:cheer"]);
    expect(w.ctrl.seen("tail:question")).toContain("0.8 tail:question:3");
    // 생각이 0.5초 이어지면 골똘히 → 확인을 기다림(골똘히 머무름에 안 밀림) → 승인하면 잠깐 정리하고 타이핑 →
    // 타이핑은 4초 보이고 정리(떨기·행복은 그동안 제때 나온다)
    expect(w.ctrl.seen("act:")).toEqual(["0.5 act:think", "0.8 act:wait", "3.0 act:null", "3.0 act:typing", "7.0 act:null"]);
    expect(w.ctrl.seen("mood:")).toEqual(["0.0 mood:curious", "3.0 mood:idle", "4.5 mood:happy", "7.6 mood:idle"]);
  });

  it("3) 타이핑 중 오류가 연달아 와도 탁탁은 한 번, 타이핑은 계속", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "answering" });
    w.sig(2, { type: "step_error", tool: "code.exec", cancelled: false });
    w.sig(2.5, { type: "step_error", tool: "code.exec", cancelled: false });
    w.to(4);
    expect(w.ctrl.seen("react:")).toEqual(["2.0 react:sulk"]);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:typing"]);
  });

  it("4) 발도장은 끝까지 찍고, 끝나고 0.6초 뒤 떨기", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "tool_start", tool: "todo.complete" });
    w.sig(0.2, { type: "tool_end", tool: "todo.complete" });
    w.sig(0.3, { type: "done", petState: null });
    w.to(8);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:stamp"]);
    expect(w.ctrl.seen("end")).toEqual(["4.3 end"]);
    expect(w.ctrl.seen("react:")).toEqual(["4.9 react:cheer"]);
  });

  it("5) 도구 없이 답만 쓰면 타이핑 → 끝나도 4초는 채우고 정리, 반응 없음", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0.2, { type: "answering" });
    w.sig(3, { type: "done", petState: null });
    w.to(6);
    expect(w.ctrl.seen("act:")).toEqual(["0.2 act:typing", "4.2 act:null"]);
    expect(w.ctrl.seen("react:")).toEqual([]);
  });

  it("6) 세션을 바꾸면 머무름을 무시하고 바로 새 세션 계획, 이전 세션 반응은 버린다", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "tool_start", tool: "todo.add" });
    w.sig(0.5, { type: "done", petState: null }); // 떨기가 1.1초에 나올 차례
    w.to(0.8);
    w.input.session = IDLE_SESSION;
    w.sch.resetSession();
    w.to(3);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:typing", "0.8 act:null"]);
    expect(w.ctrl.seen("react:")).toEqual([]);
  });

  it("7) 밥 주기(요약 20초): 끝날 때까지 밥 먹기 → 다 먹으면 세수 + 떨기", () => {
    const w = world();
    w.set(0, { feeding: { since: 0 } });
    w.set(20, { feeding: null, fedAt: 20000 });
    w.react(20, [{ type: "react", kind: "cheer", gate: "result" }]);
    w.to(32);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:meal", "20.0 act:groom", "23.5 act:null"]);
    expect(w.ctrl.seen("react:")).toEqual(["20.6 react:cheer"]);
    expect(w.ctrl.seen("mood:")).toEqual(["20.0 mood:happy", "23.5 mood:idle"]);
  });

  it("8) 5분 무활동 → 식빵 졸림 → 6분 누워 자기 → 돌아오면 기지개 → 인사", () => {
    const w = world();
    w.to(299);
    expect(w.ctrl.seen("pose:")).toEqual([]);
    w.to(361);
    expect(w.ctrl.seen("pose:")).toEqual(["300.0 pose:loaf", "360.0 pose:lie"]);
    expect(w.ctrl.mood).toBe("sleepy");
    w.set(400, { lastActiveAt: 400_000 });
    w.to(406);
    expect(w.ctrl.seen("act:")).toEqual(["400.0 act:stretch"]);
    expect(w.ctrl.seen("react:")).toEqual(["403.0 react:greet"]);
    expect(w.ctrl.seen("pose:").slice(-1)[0]).toBe("403.0 pose:stand");
    expect(w.ctrl.mood).toBe("idle");
  });

  it("9) 타이핑 중 잡혔다 놓이면 털기 뒤 타이핑을 다시 '뿅'", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "answering" });
    w.to(1);
    w.ctrl.grab();
    w.to(2);
    w.ctrl.drop();
    w.to(4);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:typing", "2.9 act:typing"]);
  });

  it("10) 도구 사이 생각 2초 안이면 같은 활동을 그대로 이어 간다", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "tool_start", tool: "code.exec" });
    w.sig(1, { type: "tool_end", tool: "code.exec" });
    w.sig(1.2, { type: "thinking" });
    w.sig(2.5, { type: "tool_start", tool: "code.exec" });
    w.to(4);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:typing"]);
    expect(w.ctrl.seen("pose:").filter((x) => !x.startsWith("0.0"))).toEqual([]); // 0초는 실행 시작(생각) → 도구
  });
});

describe("스케줄러 규칙", () => {
  it("짧은 발도장 도구가 타이핑 머무름에 밀려도 머무름이 끝나면 꼭 찍고, 그 뒤에 떨기", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "tool_start", tool: "code.exec" });
    w.sig(0.5, { type: "tool_end", tool: "code.exec" });
    w.sig(0.6, { type: "thinking" });
    w.sig(0.7, { type: "tool_start", tool: "todo.complete" });
    w.sig(0.8, { type: "tool_end", tool: "todo.complete" });
    w.sig(0.9, { type: "done", petState: null });
    w.to(9);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:typing", "1.5 act:stamp"]);
    expect(w.ctrl.seen("end")).toEqual(["5.8 end"]);
    expect(w.ctrl.seen("react:")).toEqual(["6.4 react:cheer"]);
  });

  it("확인을 기다린 뒤엔 앞 도구의 활동으로 돌아가지 않고 새 도구 활동으로", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "tool_start", tool: "web.search" });
    w.sig(2, { type: "tool_end", tool: "web.search" });
    w.sig(2, { type: "thinking" });
    w.sig(2.2, { type: "wait", kind: "confirm", danger: false });
    w.sig(3, { type: "wait_end", approved: true });
    w.sig(3, { type: "tool_start", tool: "todo.complete" });
    w.to(4);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:window", "2.2 act:wait", "3.0 act:null", "3.0 act:stamp"]);
  });

  it("생각이 2초를 넘으면 그때 앉아서 골똘히", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "tool_start", tool: "web.search" });
    w.sig(2, { type: "tool_end", tool: "web.search" });
    w.sig(2, { type: "thinking" });
    w.to(5);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:window", "4.0 act:think"]);
    expect(w.ctrl.seen("pose:").filter((x) => !x.startsWith("0.0"))).toEqual(["4.0 pose:sit"]);
  });

  it("발도장을 하는 동안 확인 창이 뜨면 끊고 기다린다", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "tool_start", tool: "schedule.add" });
    w.sig(1, { type: "wait", kind: "clarify", danger: false });
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:stamp", "1.0 act:wait"]);
  });

  it("기다리는 동안 꼬리 물음표를 2.5초마다 다시 건다", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(1, { type: "wait", kind: "clarify", danger: false });
    w.to(7);
    expect(w.ctrl.seen("tail:question")).toEqual(["1.0 tail:question:3", "3.5 tail:question:3", "6.0 tail:question:3"]);
  });

  it("일정 지우기는 지우기를 끝까지 하고 떨기", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(1, { type: "tool_start", tool: "schedule.delete" });
    w.sig(1.2, { type: "tool_end", tool: "schedule.delete" });
    w.sig(1.3, { type: "done", petState: null });
    w.to(8);
    expect(w.ctrl.seen("act:")).toEqual(["0.5 act:think", "1.0 act:erase"]);
    expect(w.ctrl.seen("react:")).toEqual(["5.4 react:cheer"]);
  });

  it("오래 걸리는 발도장 도구는 다시 찍는다", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "tool_start", tool: "todo.complete" });
    w.to(10);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:stamp", "4.7 act:stamp", "9.4 act:stamp"]);
  });

  it("결과 반응이 연달아 와도 0.4초씩 띄운다(꼬리펑 → 내리기 1.2초)", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(1, { type: "loop_error" });
    w.to(5);
    expect(w.ctrl.seen("react:")).toEqual(["1.6 react:startle", "2.8 react:down"]);
  });

  it("일하는 활동의 머무름(4초)은 확인 기다림을 막지 않는다", () => {
    const w = world();
    w.sig(0, { type: "run_start" });
    w.sig(0, { type: "tool_start", tool: "web.search" });
    w.sig(0.5, { type: "wait", kind: "confirm", danger: false });
    w.to(1);
    expect(w.ctrl.seen("act:")).toEqual(["0.0 act:window", "0.5 act:wait"]);
  });
});
