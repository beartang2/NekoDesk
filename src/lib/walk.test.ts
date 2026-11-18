import { describe, it, expect } from "vitest";
import { buildPath, fallbackLegs, hurryHome, nextWalkAt, pickPlaces, positionAt, toLatLon, toMeters, type TimedPt } from "./walk";

/** 시드 고정 난수(mulberry32) — 대체 경로가 매번 같게. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const end = (p: TimedPt[]) => p[p.length - 1][2];

describe("positionAt", () => {
  // 0→1초 동쪽 100m, 1→3초 머묾, 3→4초 집으로.
  const path: TimedPt[] = [[0, 0, 0], [100, 0, 1000], [100, 0, 3000], [0, 0, 4000]];

  it("구간 안은 잇고, 머무는 동안은 그 자리", () => {
    expect(positionAt(path, 500)).toEqual([50, 0]);
    expect(positionAt(path, 2000)).toEqual([100, 0]);
    expect(positionAt(path, 3500)).toEqual([50, 0]);
  });

  it("떠나기 전·다녀온 뒤는 끝점", () => {
    expect(positionAt(path, -10)).toEqual([0, 0]);
    expect(positionAt(path, 9999)).toEqual([0, 0]);
  });
});

it("경로 길이와 상관없이 정한 시간에 끝나고, 머문 만큼 그 자리에 있다", () => {
  const legs = [[[0, 0], [300, 0]], [[300, 0], [300, 400], [0, 0]]] as [number, number][][];
  const path = buildPath(legs, 1000, 30 * 60_000, [3 * 60_000]);
  expect(end(path) - 1000).toBeCloseTo(30 * 60_000);
  // 걷는 시간 27분 중 300/1200 을 걸으면 도착, 거기서 3분.
  const arrive = 1000 + (27 * 60_000 * 300) / 1200;
  expect(positionAt(path, arrive + 60_000)).toEqual([300, 0]);
  expect(positionAt(path, arrive + 3 * 60_000 + 1000)[1]).toBeGreaterThan(0);
});

it("대체 경로는 멀어졌다가 집에서 끝난다", () => {
  for (const seed of [1, 2, 3, 42]) {
    const legs = fallbackLegs(seeded(seed));
    const last = legs[legs.length - 1];
    expect(last[last.length - 1]).toEqual([0, 0]);
    const far = Math.max(...legs.flat().map(([x, y]) => Math.hypot(x, y)));
    expect(far).toBeGreaterThan(140);
    expect(far).toBeLessThan(900);
  }
});

it("서둘러 돌아오면 2분 안에 집", () => {
  const path = buildPath(fallbackLegs(seeded(7)), 0, 30 * 60_000, [120_000, 120_000]);
  const now = 10 * 60_000;
  const back = hurryHome(path, now);
  expect(end(back) - now).toBeLessThanOrEqual(120_000);
  expect(positionAt(back, now)).toEqual(positionAt(path, now)); // 순간이동 없이 지금 자리에서
  expect(positionAt(back, now + 120_000)).toEqual([0, 0]);
});

it("들를 곳은 가까운 순, 집 앞은 뺀다", () => {
  const home = { lat: 37.5, lon: 127 };
  const at = (x: number, y: number, name: string) => {
    const [lat, lon] = toLatLon(home, [x, y]);
    return { name, category: "", lat, lon };
  };
  const picked = pickPlaces(home, [at(500, 0, "c"), at(10, 0, "door"), at(0, 200, "a"), at(-300, 0, "b"), at(0, -700, "d")], seeded(3));
  expect(picked.length).toBeGreaterThanOrEqual(2);
  expect(picked.map((p) => p.name)).not.toContain("door");
  const d = picked.map((p) => Math.hypot(...toMeters(home, p.lat, p.lon)));
  expect([...d].sort((a, b) => a - b)).toEqual(d);
});

it("pickPlaces 는 한쪽 방향으로 고르고 같은 이름은 한 번만", () => {
  const home = { lat: 37.5, lon: 127 };
  const at = (east: number, north: number, name: string) => {
    const [lat, lon] = toLatLon(home, [east, north]);
    return { name, category: "", lat, lon };
  };
  // 동쪽 셋(같은 이름 둘), 서쪽 셋. 어느 쪽을 골라도 반대편은 섞이지 않는다.
  const east = [at(200, 10, "e1"), at(400, -20, "e2"), at(410, -20, "e2"), at(600, 30, "e3")];
  const west = [at(-200, 10, "w1"), at(-400, -20, "w2"), at(-600, 30, "w3")];
  for (let s = 1; s < 20; s++) {
    const picked = pickPlaces(home, [...east, ...west], seeded(s)).map((p) => p.name);
    expect(new Set(picked).size).toBe(picked.length);
    expect(picked.every((n) => n[0] === picked[0][0])).toBe(true);
  }
});

describe("nextWalkAt: 끼니 산책 3번 + 추가 산책(2시간 간격)", () => {
  const t = (h: number, m = 0) => new Date(2026, 10, 18, h, m).getTime();
  const min = 60_000, wait = 10 * min;
  it("끼니 시간대에 졸면 기다리지 않고 바로", () => {
    expect(nextWalkAt({ dozeAt: t(12, 30), lastWalk: null, extraWait: wait })).toEqual({ at: t(12, 30), meal: true });
  });
  it("끼니 시간대가 열리면 바로 — 2시간 간격은 안 본다", () => {
    const lastWalk = { start: t(6, 0), end: t(6, 30) };
    expect(nextWalkAt({ dozeAt: t(6, 50), lastWalk, extraWait: wait })).toEqual({ at: t(7, 0), meal: true });
  });
  it("그 끼니에 이미 다녀왔으면(추가 산책이어도) 다시 안 나가고 추가 산책 규칙대로", () => {
    const lastWalk = { start: t(12, 5), end: t(12, 35) };
    expect(nextWalkAt({ dozeAt: t(13, 0), lastWalk, extraWait: wait })).toEqual({ at: t(14, 35), meal: false });
  });
  it("끼니 밖: 졸고 나서 기다린 뒤, 지난 산책 끝나고 2시간 뒤 중 늦은 때", () => {
    expect(nextWalkAt({ dozeAt: t(10, 0), lastWalk: { start: t(8, 30), end: t(9, 0) }, extraWait: wait })).toEqual({ at: t(11, 0), meal: false });
    expect(nextWalkAt({ dozeAt: t(15, 0), lastWalk: { start: t(10, 0), end: t(10, 30) }, extraWait: wait })).toEqual({ at: t(15, 10), meal: false });
  });
  it("추가 산책을 기다리는 사이 끼니가 열리면 끼니가 먼저", () => {
    expect(nextWalkAt({ dozeAt: t(11, 30), lastWalk: { start: t(10, 0), end: t(10, 30) }, extraWait: wait })).toEqual({ at: t(12, 0), meal: true });
  });
  it("오늘 끼니가 다 지났으면 추가 산책 규칙대로(내일 아침은 그보다 늦다)", () => {
    expect(nextWalkAt({ dozeAt: t(21, 0), lastWalk: null, extraWait: wait })).toEqual({ at: t(21, 10), meal: false });
  });
});
