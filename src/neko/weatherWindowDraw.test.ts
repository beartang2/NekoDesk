import { describe, expect, it } from "vitest";
import { skyAt, weatherKind } from "./weatherWindowDraw";
import { roomWindow } from "./engine/room-window";

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

  it("방은 왼쪽 1/4 에 세로 창, 거실은 가로로 긴 창, 마당은 없다", () => {
    const room = roomWindow("sidebar", 280, 200)!;
    expect(room.h).toBeGreaterThan(room.w);
    expect(Math.abs(room.x + room.w / 2 - 70)).toBeLessThanOrEqual(1);
    expect(room.y + room.h).toBeLessThan(200 - 6 - 18 * 0.8); // 벽 안(바닥 이음매 위)
    const dock = roomWindow("dock", 900, 170)!;
    expect(dock.w).toBeGreaterThan(dock.h * 3);
    expect(roomWindow("screen", 900, 170)).toBeNull();
    expect(roomWindow("sidebar", 0, 0)).toBeNull();
  });
});
