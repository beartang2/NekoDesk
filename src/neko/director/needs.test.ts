// @vitest-environment jsdom
// ONE_SHOT 이 tool-registry(→ settingsStore 가 localStorage 를 읽는다)를 불러온다

import { describe, expect, it } from "vitest";
import { ONE_SHOT } from "./toolActivity";
import { applyFill, decay, fillsOf, pickByNeeds, score, SOLO_KEYS, soloOdds, START, type Needs } from "./needs";
import type { NekoActivity } from "../engine/neko-engine";

const H = 3_600_000;
const sc = (s: Needs, k: string) => Math.round(score(s, fillsOf(k)) * 100) / 100;

describe("숨은 게이지(docs/neko-activity-mix.md 2부)", () => {
  it("점수는 문서 예 1·예 2 와 같다", () => {
    const ex1 = { energy: 80, curiosity: 40, clean: 70, affection: 60 };
    expect([sc(ex1, "climb"), sc(ex1, "butterfly"), sc(ex1, "dig"), sc(ex1, "window"), sc(ex1, "yarn"), sc(ex1, "reading"), sc(ex1, "draw")])
      .toEqual([2.62, 2.44, 2.26, 2.24, 1.99, 1.9, 1.72]);
    expect([sc(ex1, "groom"), sc(ex1, "box"), sc(ex1, "music"), sc(ex1, "knead"), sc(ex1, "snack"), sc(ex1, "stretch")])
      .toEqual([1.36, 1.36, 0.98, 0.83, 0.69, 0.64]);
    const ex2 = { energy: 15, curiosity: 80, clean: 30, affection: 20 };
    expect([sc(ex2, "groom"), sc(ex2, "knead"), sc(ex2, "stretch"), sc(ex2, "music"), sc(ex2, "reading"), sc(ex2, "window"), sc(ex2, "box")])
      .toEqual([3.7, 2.19, 1.42, 1.37, 1.33, 1.28, 1.27]);
    expect([sc(ex2, "dig"), sc(ex2, "draw"), sc(ex2, "snack"), sc(ex2, "yarn"), sc(ex2, "butterfly"), sc(ex2, "climb")])
      .toEqual([0.91, 0.85, 0.48, 0.19, 0.1, 0.1]);
  });

  it("깨어 있으면 줄고(애정은 외로울 때만), 졸면·자면 기운이 찬다", () => {
    expect(decay(START, H, "awake")).toEqual({ energy: 66, curiosity: 60, clean: 66, affection: 62 });
    expect(decay(START, H, "awake", false).affection).toBe(70);
    expect(decay(START, H, "dozing").energy).toBe(90);
    expect(decay(START, H, "sleeping").energy).toBe(100); // 100 에서 멈춤
    expect(decay({ ...START, curiosity: 5 }, 2 * H, "awake").curiosity).toBe(0); // 깨어 있을 땐 0까지
  });

  it("꺼져 있던 동안: 기운은 차고, 나머지는 바닥에서 멈춘다(이미 바닥 아래면 그대로)", () => {
    const s = decay(START, 24 * H, "off");
    expect(s).toEqual({ energy: 100, curiosity: 30, clean: 40, affection: 30 });
    expect(decay({ ...START, curiosity: 10 }, 24 * H, "off").curiosity).toBe(10);
  });

  it("채움은 1분마다 나눠 넣고(3분 = 한 번), 한 번짜리는 끝날 때 한 번에", () => {
    const one = applyFill(START, fillsOf("window"), 1);
    expect(one.curiosity).toBeCloseTo(70 + 25 / 3);
    expect(applyFill(START, fillsOf("groom")).clean).toBe(100);
    expect(applyFill(START, fillsOf("typing")).energy).toBe(67);
  });

  it("직전 활동은 빼고, 놓인 선물이 없으면 선물 놀이도 없고, 있으면 두 배", () => {
    const keys = (o: Parameters<typeof soloOdds>[1]) => soloOdds(START, o).map((x) => x.key);
    expect(keys({ last: "window", hasGifts: false })).not.toContain("window");
    expect(keys({ last: null, hasGifts: false })).not.toContain("giftplay");
    const odds = soloOdds(START, { last: null, hasGifts: true });
    const p = (k: string) => odds.find((x) => x.key === k)!.p;
    expect(p("giftplay") / p("draw")).toBeCloseTo((score(START, fillsOf("giftplay")) * 2) / score(START, fillsOf("draw")));
    expect(odds.reduce((a, b) => a + b.p, 0)).toBeCloseTo(1);
    expect(SOLO_KEYS).toEqual(expect.arrayContaining(["dig", "gaze", "groom", "knead", "window"]));
    // r 로 고른다
    expect(pickByNeeds(START, { last: null, hasGifts: false }, 0)).toBe(odds.filter((x) => x.key !== "giftplay")[0].key);
  });

  it("가상 하루 8시간: 한 활동이 30% 를 넘지 않고, 게이지가 바닥에 붙어 있지 않다", () => {
    let s = { ...START }, last: NekoActivity | null = null, seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const count = new Map<string, number>();
    let picks = 0, stuck = 0, minutes = 0;
    while (minutes < 8 * 60) {
      // 쉬다가(약 1.5분) 혼자 논다. 한 번짜리는 짧게, 나머지는 약 3분
      s = decay(s, 1.5 * 60_000, "awake"); minutes += 1.5;
      const k = pickByNeeds(s, { last, hasGifts: false }, rand());
      last = k; picks++; count.set(k, (count.get(k) ?? 0) + 1);
      const stay = ONE_SHOT.has(k) ? 0.3 : 3;
      s = decay(applyFill(s, fillsOf(k), ONE_SHOT.has(k) ? 3 : stay), stay * 60_000, "awake"); minutes += stay;
      if (Object.values(s).some((v) => v <= 0)) stuck++;
    }
    const top = Math.max(...count.values()) / picks;
    expect(top).toBeLessThan(0.3);
    expect(stuck / picks).toBeLessThan(0.1);
  });
});
