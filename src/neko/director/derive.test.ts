// @vitest-environment jsdom
// 도구 표가 tool-registry(→ settingsStore 가 localStorage 를 읽는다)를 불러온다

import { describe, expect, it } from "vitest";
import { DEEP_SLEEP_MS, deriveNeko, FED_MS, pickSolo, PLAY_MS, SLEEPY_MS, SOLO, THINK_DELAY_MS, THINK_GRACE_MS } from "./derive";
import { IDLE_SESSION, reduceSession } from "./session";
import type { DirectorInput, NekoSessionState, NekoSignal } from "./types";

const input = (p: Partial<DirectorInput> = {}): DirectorInput => ({
  session: IDLE_SESSION, feeding: null, fedAt: null, playCue: null, game: null,
  needs: { hunger: 100, play: 60 }, lastActiveAt: 0, box: null, ...p,
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
  it("고를 거리는 넓고, 방금 한 건 다시 안 고르고, 선물이 있으면 선물도", () => {
    expect(SOLO).toEqual(expect.arrayContaining(["draw", "music", "reading", "groom", "knead", "window", "stretch", "snack", "climb"]));
    for (let i = 0; i < 20; i++) expect(pickSolo("yarn", false, i / 20)).not.toBe("yarn");
    const picks = new Set(Array.from({ length: 40 }, (_, i) => pickSolo(null, true, i / 40)));
    expect(picks.has("giftplay")).toBe(true);
    expect(pickSolo(null, false, 0.999)).toBe(SOLO[SOLO.length - 1]);
  });

  it("돌아다니는 놀이만 산책을 켜고, 한 번짜리는 한 번만", () => {
    const at = (kind: (typeof SOLO)[number]) => deriveNeko(input({ box: { since: 0, kind } }), 1000).plan;
    expect(at("yarn")).toMatchObject({ layer: "box", activity: "yarn", wander: true, oneShot: false });
    expect(at("reading")).toMatchObject({ activity: "reading", wander: false, oneShot: false });
    expect(at("snack")).toMatchObject({ activity: "snack", wander: false, oneShot: true });
    expect(at("climb")).toMatchObject({ activity: "climb", wander: true, oneShot: true });
  });
});
