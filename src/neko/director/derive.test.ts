// @vitest-environment jsdom
// 도구 표가 tool-registry(→ settingsStore 가 localStorage 를 읽는다)를 불러온다

import { describe, expect, it } from "vitest";
import { DEEP_SLEEP_MS, deriveNeko, FED_MS, PLAY_MS, SLEEPY_MS, THINK_DELAY_MS, THINK_GRACE_MS, WRITE_FINISH_MS } from "./derive";
import type { NekoActivity } from "../engine/neko-engine";
import { IDLE_SESSION, reduceSession } from "./session";
import type { DirectorInput, NekoSessionState, NekoSignal } from "./types";

const input = (p: Partial<DirectorInput> = {}): DirectorInput => ({
  session: IDLE_SESSION, feeding: null, fedAt: null, playCue: null, game: null,
  needs: { hunger: 100, play: 60 }, lastActiveAt: 0, outside: { at: -Infinity, activity: null, music: false }, box: null, ...p,
});
const sess = (...sigs: Array<[number, NekoSignal]>): NekoSessionState =>
  sigs.reduce((s, [t, sig]) => reduceSession(s, sig, t).state, IDLE_SESSION);
const layer = (i: DirectorInput, now = 1000) => deriveNeko(i, now).plan.layer;

describe("계획: 층과 우선순위(설계 §5.2)", () => {
  it("기본은 서서 산책", () => {
    const { plan } = deriveNeko(input(), 1000);
    expect(plan).toMatchObject({ layer: "base", pose: "stand", mood: "idle", activity: null, wander: true });
  });

  it("기다림은 밥 먹기보다 위, 꼬리 물음표 유지", () => {
    const s = sess([0, { type: "run_start" }], [10, { type: "wait", kind: "confirm", danger: false }]);
    const { plan } = deriveNeko(input({ session: s, feeding: { since: 0 } }), 1000);
    expect(plan).toMatchObject({ layer: "waiting", pose: "sit", tailHold: "question", activity: "wait" });
  });

  it("밥 먹기는 에이전트 활동보다 위", () => {
    const s = sess([0, { type: "run_start" }], [10, { type: "answering" }]);
    const { plan } = deriveNeko(input({ session: s, feeding: { since: 5 } }), 1000);
    expect(plan).toMatchObject({ layer: "meal", activity: "meal", oneShot: false });
  });

  it("도구 중엔 그 도구의 활동, 이어지는 활동은 최소 머무름", () => {
    const s = sess([0, { type: "run_start" }], [10, { type: "tool_start", tool: "web.search" }]);
    expect(deriveNeko(input({ session: s }), 100).plan).toMatchObject({ layer: "tool", activity: "window", dwell: true, oneShot: false });
  });

  it("도구 사이 생각: 2초 안엔 같은 활동, 그 뒤엔 앉아서 골똘히", () => {
    const s = sess([0, { type: "run_start" }], [10, { type: "tool_start", tool: "todo.list" }], [500, { type: "tool_end", tool: "todo.list" }], [600, { type: "thinking" }]);
    const a = deriveNeko(input({ session: s }), 700);
    expect(a.plan).toMatchObject({ layer: "tool", activity: "reading" });
    expect(a.recheckAt).toBe(600 + THINK_GRACE_MS);
    expect(deriveNeko(input({ session: s }), 600 + THINK_GRACE_MS).plan).toMatchObject({ layer: "think", pose: "sit", mood: "curious", activity: "think" });
  });

  it("생각을 막 시작했을 땐 앉기만, 0.5초 이어지면 골똘히", () => {
    const s = sess([0, { type: "run_start" }]);
    const a = deriveNeko(input({ session: s }), 100);
    expect(a.plan).toMatchObject({ layer: "think", activity: null, pose: "sit" });
    expect(a.recheckAt).toBe(THINK_DELAY_MS);
    expect(deriveNeko(input({ session: s }), THINK_DELAY_MS).plan.activity).toBe("think");
  });

  it("답 쓰는 중은 타이핑", () => {
    const s = sess([0, { type: "run_start" }], [10, { type: "answering" }]);
    expect(deriveNeko(input({ session: s }), 100).plan).toMatchObject({ layer: "answer", activity: "typing" });
  });

  it("결과는 여운 + 길이만큼 보이고 끝나면 아래층으로", () => {
    const s = sess([0, { type: "run_start" }], [10, { type: "tool_start", tool: "web.search" }], [20, { type: "tool_end", tool: "web.search" }], [1000, { type: "done", petState: null }]);
    const a = deriveNeko(input({ session: s }), 1500);
    expect(a.plan).toMatchObject({ layer: "result", pose: "sit", mood: "idle" }); // 찾아보기만 했다
    expect(a.recheckAt).toBe(1000 + 600 + 2500);
    expect(layer(input({ session: s }), 4100)).toBe("base");
  });

  it("놀아주기는 게임보다 위(6초), 그 뒤 게임", () => {
    const i = input({ playCue: { at: 0, kind: "yarn" }, game: { emotion: "curious", until: 60_000 } });
    expect(deriveNeko(i, 1000).plan).toMatchObject({ layer: "play", activity: "yarn", wander: true });
    expect(deriveNeko(i, PLAY_MS).plan).toMatchObject({ layer: "game", mood: "curious", pose: "sit" });
  });

  it("게임 감정은 표 5.1 로(고양이 차례 = 골똘히, 끝나면 사라짐)", () => {
    const i = input({ game: { emotion: "working", until: 5000 } });
    expect(deriveNeko(i, 1000).plan).toMatchObject({ layer: "game", activity: "think" });
    expect(layer(i, 5000)).toBe("base");
  });

  it("5분 무활동이면 식빵 졸림, 6분이면 누워 자기 — 배고프거나 심심해도 결국 잔다", () => {
    const i = input({ needs: { hunger: 20, play: 10 } });
    expect(deriveNeko(i, SLEEPY_MS - 1).recheckAt).toBe(SLEEPY_MS);
    expect(deriveNeko(i, SLEEPY_MS).plan).toMatchObject({ layer: "sleep", pose: "loaf", mood: "sleepy" });
    expect(deriveNeko(i, DEEP_SLEEP_MS).plan).toMatchObject({ layer: "sleep", pose: "lie" });
  });

  it("배고픔 낮음은 힘없음·배고픔, 놀이 낮음은 심심(졸림과 다름)", () => {
    expect(deriveNeko(input({ needs: { hunger: 5, play: 60 } }), 1000).plan).toMatchObject({ layer: "weak", pose: "loaf", mood: "idle" });
    expect(deriveNeko(input({ needs: { hunger: 25, play: 60 } }), 1000).plan).toMatchObject({ layer: "hungry", pose: "sit", activity: "hungry" });
    expect(deriveNeko(input({ needs: { hunger: 80, play: 10 } }), 1000).plan).toMatchObject({ layer: "bored", pose: "loaf" });
  });

  it("신남(상자·털실·나비)은 쉬는 중에만", () => {
    expect(deriveNeko(input({ box: { since: 0 } }), 1000).plan).toMatchObject({ layer: "box", activity: "box", wander: false });
    expect(deriveNeko(input({ box: { since: 0, kind: "butterfly" } }), 1000).plan).toMatchObject({ layer: "box", activity: "butterfly", wander: true });
    const s = sess([0, { type: "run_start" }], [10, { type: "answering" }]);
    expect(layer(input({ box: { since: 0 }, session: s }))).toBe("answer");
  });

  it("밥을 다 먹으면 행복하게 세수", () => {
    const i = input({ fedAt: 1000 });
    expect(deriveNeko(i, 1500).plan).toMatchObject({ layer: "fed", mood: "happy", activity: "groom" });
    expect(layer(i, 1000 + FED_MS)).toBe("base");
  });
});

describe("혼자 놀기(신남)", () => {
  it("돌아다니는 놀이만 산책을 켜고, 한 번짜리는 한 번만", () => {
    // (고르기는 숨은 게이지 점수로 — needs.test.ts)
    const at = (kind: NekoActivity) => deriveNeko(input({ box: { since: 0, kind } }), 1000).plan;
    expect(at("yarn")).toMatchObject({ layer: "box", activity: "yarn", wander: true, oneShot: false });
    expect(at("reading")).toMatchObject({ activity: "reading", wander: false, oneShot: false });
    expect(at("snack")).toMatchObject({ activity: "snack", wander: false, oneShot: true });
    expect(at("climb")).toMatchObject({ activity: "climb", wander: true, oneShot: true });
  });
});

describe("마당 고양이 숨기기", () => {
  it("숨긴 동안은 일하는 중이어도·혼자 놀 때도 아무 활동도 안 시킨다", () => {
    const s = sess([0, { type: "run_start" }], [10, { type: "answering" }]);
    expect(deriveNeko(input({ session: s, hidden: true }), 1000).plan).toMatchObject({ layer: "hidden", activity: null, wander: false });
    expect(deriveNeko(input({ box: { since: 0, kind: "yarn" }, hidden: true }), 1000).plan).toMatchObject({ layer: "hidden", activity: null });
    expect(layer(input({ box: { since: 0, kind: "yarn" } }))).toBe("box");
  });
});

describe("다른 앱 따라 하기", () => {
  const away = { lastActiveAt: 0 };
  it("다른 앱에서 키를 쳐도 따라 치지 않는다 — 친 동안은 졸림 시계만 다시 간다(0.1.28)", () => {
    const typed = { at: SLEEPY_MS * 3, activity: null, music: false };
    expect(deriveNeko(input({ ...away, outside: typed }), SLEEPY_MS * 3 + 1000).plan).toMatchObject({ layer: "base", activity: null });
    expect(deriveNeko(input({ ...away, outside: { ...typed, activity: "think" as const } }), SLEEPY_MS * 3 + 1000).plan).toMatchObject({ layer: "ambient", activity: "think" });
    expect(layer(input({ ...away, outside: typed }), SLEEPY_MS * 4 + 1000)).toBe("sleep");
  });

  it("맨 앞 앱 활동은 혼자 놀기보다 아래, 기본 산책보다 위, 졸 때는 안 한다", () => {
    const browse = { at: -Infinity, activity: "window" as const, music: false };
    expect(deriveNeko(input({ outside: browse }), 1000).plan).toMatchObject({ layer: "ambient", activity: "window", dwell: true, wander: false });
    expect(layer(input({ outside: browse, box: { since: 0, kind: "yarn" } }), 1000)).toBe("box");
    expect(layer(input({ outside: browse }), SLEEPY_MS + 1000)).toBe("sleep");
  });

  it("음악이 나오면 하던 것 위에 곁들인다 — 주 활동이 되지 않고, 얹을 수 없는 것엔 안 얹는다", () => {
    const m = (o: Partial<DirectorInput["outside"]> = {}) => ({ at: -Infinity, activity: null, music: true, ...o });
    const side = (i: DirectorInput, now = 1000) => deriveNeko(i, now).plan;
    // 음악만: 기본 산책 위에 헤드폰
    expect(side(input({ outside: m() }))).toMatchObject({ layer: "base", activity: null, side: "music" });
    // 채팅에 글을 남기는 타이핑 + 음악
    expect(side(input({ outside: m(), writing: true }))).toMatchObject({ layer: "answer", activity: "typing", side: "music" });
    // 에이전트 신문 읽기 + 음악
    const s = sess([0, { type: "run_start" }], [10, { type: "tool_start", tool: "web.scrape" }]);
    expect(side(input({ session: s, outside: m() }))).toMatchObject({ activity: "reading", side: "music" });
    // 졸기(식빵)는 낀 채, 누워 자기는 벗는다
    expect(side(input({ outside: m() }), SLEEPY_MS + 1000)).toMatchObject({ layer: "sleep", pose: "loaf", side: "music" });
    expect(side(input({ outside: m() }), DEEP_SLEEP_MS + 1000)).toMatchObject({ layer: "sleep", pose: "lie", side: null });
    // 혼자 음악 듣기는 주 활동 그대로(곁들임 없음), 숨겼으면 없음
    expect(side(input({ outside: m(), box: { since: 0, kind: "music" } }))).toMatchObject({ activity: "music", side: null });
    expect(side(input({ outside: m(), hidden: true }))).toMatchObject({ layer: "hidden", side: null });
    // 음악이 안 나오면 없음
    expect(side(input())).toMatchObject({ side: null });
  });
});

describe("네코가 채팅에 글을 남길 때만 타이핑(0.1.28)", () => {
  it("산책 일지·브리핑·첫마디를 쓰는 동안은 답 쓰기와 같은 타이핑 — 졸고 있었어도, 혼자 놀기보다 먼저", () => {
    expect(deriveNeko(input({ writing: true, lastActiveAt: 0 }), DEEP_SLEEP_MS * 2).plan).toMatchObject({ layer: "answer", activity: "typing", dwell: true, instance: "answer" });
    expect(layer(input({ writing: true, box: { since: 0, kind: "yarn" } }))).toBe("answer");
    // 기다림·밥·에이전트 일은 그 위
    const s = sess([0, { type: "run_start" }], [10, { type: "tool_start", tool: "web.search" }]);
    expect(layer(input({ writing: true, session: s }))).toBe("tool");
  });

  it("답을 쓰다 끝났으면 결과 표정은 타이핑 마무리(WRITE_FINISH_MS) 뒤에도 남는다", () => {
    const s = sess([0, { type: "run_start" }], [10, { type: "answering" }], [2000, { type: "done", petState: "happy" }]);
    expect(s.result?.typed).toBe(true);
    expect(layer(input({ session: s }), 2000 + WRITE_FINISH_MS + 2000)).toBe("result");
    expect(layer(input({ session: s }), 2000 + WRITE_FINISH_MS + 3200)).toBe("base");
    const t = sess([0, { type: "run_start" }], [10, { type: "tool_start", tool: "web.search" }], [2000, { type: "done", petState: "happy" }]);
    expect(t.result?.typed).toBeUndefined();
    expect(layer(input({ session: t }), 2000 + 3200)).toBe("base");
  });
});

describe("네코가 직접 고른 활동(neko.act, 0.1.32)", () => {
  it("하던 일(답 쓰기)을 마친 뒤 그 활동을, 시간이 지나면 원래 흐름으로", () => {
    const chosen = { kind: "box" as const, since: 1000, until: 61_000 };
    const busy = sess([0, { type: "run_start" }], [10, { type: "answering" }]);
    expect(layer(input({ session: busy, chosen }), 2000)).toBe("answer"); // 답 쓰는 동안은 그대로
    const a = deriveNeko(input({ chosen }), 2000);
    expect(a.plan).toMatchObject({ layer: "chosen", activity: "box", instance: "chosen:1000" });
    expect(a.recheckAt).toBe(61_000);
    expect(layer(input({ chosen }), 61_000)).toBe("base");
    // 혼자 놀기·심심함보다 먼저
    expect(layer(input({ chosen, box: { since: 0, kind: "yarn" }, needs: { hunger: 100, play: 5 } }), 2000)).toBe("chosen");
  });
});
