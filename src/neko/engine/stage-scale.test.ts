import { describe, it, expect, afterEach } from "vitest";
import { DOCK_GROW_H, PHONE_K, setStageK, stageS } from "./stage-scale.js";
import { DOCK_H } from "../nekoStore";
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

describe("맥 거실을 가장 크게 해도 폰 거실과 같은 비율(사용자, 0.1.24)", () => {
  const catPerH = (H: number, place = "dock") => (100 * stageS(1100, H - 6, place)) / H;
  it("기본 높이까지는 전과 같고, 그 위로는 고양이·창문 크기가 멈춘다", () => {
    expect(DOCK_GROW_H).toBe(DOCK_H.def);
    expect(stageS(1100, 114, "dock")).toBeCloseTo(114 / 240, 6); // 낮은 띠: 그대로
    expect(stageS(1100, 164, "dock")).toBeCloseTo(164 / 240, 6);
    expect(stageS(1100, 234, "dock")).toBeCloseTo(164 / 240, 6); // 가장 큰 띠: 기본 높이 크기
    expect(roomWindows("dock", 1100, 240)[0].h).toBe(roomWindows("dock", 1100, 170)[0].h);
    expect(roomWindows("dock", 1100, 240)[0].y).toBe(Math.round(240 * 0.12)); // 자리는 실제 높이 비율
    expect(stageS(280, 234, "sidebar")).toBeCloseTo(234 / 240, 6); // 방은 그대로
  });
  it("가장 큰 맥 거실의 고양이 키 비율 = 폰 거실(세로·가로 사이)", () => {
    const mac = catPerH(DOCK_H.max);
    setStageK(PHONE_K);
    const portrait = catPerH(120), landscape = (100 * stageS(812, 369, "dock")) / 375;
    expect(mac).toBeGreaterThan(landscape - 0.01);
    expect(mac).toBeLessThan(portrait + 0.01);
    expect(stageS(812, 369, "dock")).toBeCloseTo(0.98, 6); // 폰은 그대로
  });
});
