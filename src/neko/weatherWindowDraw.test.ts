import { describe, expect, it } from "vitest";
import { skyAt, weatherKind } from "./weatherWindowDraw";
import { roomWindows } from "./engine/room-window";
import { PHONE_K, setStageK } from "./engine/stage-scale";

describe("날씨 창문", () => {
  it("WMO 코드를 여섯 가지로 나눈다", () => {
    expect([0, 1, 2, 3, 45, 61, 81, 73, 86, 95, -1].map(weatherKind)).toEqual(
      ["clear", "clear", "cloud", "cloud", "fog", "rain", "rain", "snow", "snow", "storm", "cloud"],
    );
  });

  it("하늘은 해 뜨고 지는 때를 따라 밤 → 노을 → 낮 → 노을 → 밤", () => {
    const rise = 25_000, set = 61_000;
    expect(skyAt(rise - 3 * 3600, rise, set, true)).toEqual({ light: 0, glow: 0 });
    const dawn = skyAt(rise, rise, set, true);
    expect(dawn.light).toBeCloseTo(0.5); expect(dawn.glow).toBe(1);
    expect(skyAt(43_000, rise, set, false)).toEqual({ light: 1, glow: 0 });
    expect(skyAt(set + 2 * 3600, rise, set, true).light).toBe(0);
    // 해 뜨고 지는 때를 모르면 낮·밤만
    expect(skyAt(0, null, null, false)).toEqual({ light: 0, glow: 0 });
  });

  it("방은 왼쪽 1/4 에 세로 창, 거실은 가로로 긴 창 둘, 마당은 없다", () => {
    const [room] = roomWindows("sidebar", 280, 200);
    expect(room.h).toBeGreaterThan(room.w);
    expect(Math.abs(room.x + room.w / 2 - 70)).toBeLessThanOrEqual(1);
    expect(room.y + room.h).toBeLessThan(200 - 6 - 18 * 0.8); // 벽 안(바닥 이음매 위)
    // 거실: 가로로 긴 창 둘, 왼쪽 1/4·오른쪽 1/4 가운데
    const dock = roomWindows("dock", 900, 170);
    expect(dock.map((r, i) => Math.abs(r.x + r.w / 2 - [225, 675][i]) <= 1)).toEqual([true, true]);
    expect(dock[0].w).toBeGreaterThan(dock[0].h * 2);
    expect(roomWindows("screen", 900, 170)).toEqual([]);
    // 높은 거실(폰 가로 화면): 창이 거실과 같이 커지고, 여전히 왼쪽·오른쪽 1/4 지점에 벽 안에 있다. 높이 240 까지는 전과 같다
    const tall = roomWindows("dock", 812, 375);
    expect(tall.map((r) => r.x + r.w / 2)).toEqual([203, 609]);
    expect(tall[0].h).toBe(Math.round(375 * 0.3));
    // 폰은 240 → 가로 화면이 같은 30% 로 이어진다(맥 거실은 기본 높이 170 에서 창 크기를 멈춰 240 이 없다 — stage-scale DOCK_GROW_H)
    setStageK(PHONE_K);
    expect(roomWindows("dock", 812, 375)[0].h / 375).toBeCloseTo(roomWindows("dock", 1000, 240)[0].h / 240, 2);
    setStageK(1);
    expect(tall[0].x).toBeGreaterThan(0);
    expect(tall[0].x + tall[0].w).toBeLessThan(tall[1].x);
    expect(tall[1].x + tall[1].w).toBeLessThan(812);
    expect(roomWindows("dock", 1000, 240)[0]).toMatchObject({ h: 68, w: 177 }); // 맥 가장 큰 거실 = 기본 높이 170 의 창
    expect(roomWindows("dock", 1000, 170)[0]).toMatchObject({ h: 68, w: 177 });
    expect(roomWindows("dock", 375, 120)[0]).toMatchObject({ h: 48 });
    expect(roomWindows("sidebar", 0, 0)).toEqual([]);
  });
});
