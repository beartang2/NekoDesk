import { describe, it, expect, afterEach } from "vitest";
import { PHONE_K, setStageK, stageS } from "./stage-scale.js";
import { roomWindows } from "./room-window.js";
import { capPx, decorDims, decorK } from "./decor-draw.js";
import { validateShape } from "./gift-shape.js";

const shape = validateShape({ v: 1, parts: [{ t: "circle", x: 0, y: -10, r: 10, c: "red" }] });
afterEach(() => setStageK(1));

describe("폰 크기 배율(거실이 넓어 보이게, 사용자 70%)", () => {
  it("맥은 엔진 높이 모드 식 그대로, 폰은 그 70%(0.35 아래로는 안 줄인다)", () => {
    expect(stageS(1100, 164)).toBeCloseTo(164 / 240, 6);
    expect(stageS(812, 369)).toBe(1.4);
    setStageK(PHONE_K);
    expect(stageS(812, 369)).toBeCloseTo(0.98, 6); // 폰 가로
    expect(stageS(322, 194)).toBeCloseTo((194 / 240) * 0.7, 6); // 폰 방
    expect(stageS(375, 114)).toBe(0.35); // 폰 세로 거실(0.475 × 0.7 = 0.33 → 0.35)
  });

  it("창문도 같은 비율로(가운데·위 자리는 그대로)", () => {
    const mac = roomWindows("dock", 812, 375), room = roomWindows("sidebar", 322, 200)[0];
    setStageK(PHONE_K);
    const phone = roomWindows("dock", 812, 375), proom = roomWindows("sidebar", 322, 200)[0];
    expect(phone[0].h / mac[0].h).toBeCloseTo(0.7, 1);
    expect(phone[0].x + phone[0].w / 2).toBeCloseTo(mac[0].x + mac[0].w / 2, -1);
    expect(phone[0].y).toBe(mac[0].y);
    expect(proom.h / room.h).toBeCloseTo(0.7, 1);
  });

  it("방 상한도 고양이 대비(맥 방은 그대로, 폰은 고양이와 같이 줄어 큰 선물의 고양이 대비가 같다)", () => {
    const macG = { floorY: 194, S: stageS(322, 194) };
    expect(capPx("sidebar", macG)).toBeCloseTo(0.8 * 194, 6);
    setStageK(PHONE_K);
    const phoneG = { floorY: 194, S: stageS(322, 194) };
    const perCat = (g: { floorY: number; S: number }) => decorDims(shape, decorK(shape, "large", 3, "sidebar", g).k, g.S).h / (100 * g.S);
    expect(perCat(phoneG)).toBeCloseTo(perCat(macG), 6);
  });
});
