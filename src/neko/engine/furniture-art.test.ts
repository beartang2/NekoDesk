import { describe, it, expect } from "vitest";
import { FURNITURE_ART, drawFurniture, furnitureBox, furnitureSurfaces, type FurnitureKind } from "./furniture-art.js";

const kinds = Object.keys(FURNITURE_ART) as FurnitureKind[];

describe("가구 그림(docs/neko-furniture.md §9·§11)", () => {
  it("기준 크기는 고양이 키 단위라 S 를 따른다(조명 1.5·캣타워 1.8·캣휠 1.3·소파 폭 2.2·상자 0.8)", () => {
    for (const S of [0.35, 0.68, 1.4]) {
      expect(furnitureBox("lamp", S).h / (100 * S)).toBeCloseTo(1.5, 6);
      expect(furnitureBox("cattower", S).h / (100 * S)).toBeCloseTo(1.8, 6);
      expect(furnitureBox("wheel", S).h / (100 * S)).toBeCloseTo(1.3, 6);
      expect(furnitureBox("sofa", S).w / (100 * S)).toBeCloseTo(2.2, 6);
      expect(furnitureBox("sofa", S).h / (100 * S)).toBeCloseTo(0.9, 1);
      expect(furnitureBox("box", S).h / (100 * S)).toBeCloseTo(0.8, 6);
    }
  });
  it("칸 폭의 90% 를 넘으면 칸에 맞게 줄인다(맥 방 소파 178 → 126, 폰 가로 216 → 183)", () => {
    expect(Math.round(furnitureBox("sofa", 0.81, 140).w)).toBe(126);
    expect(Math.round(furnitureBox("sofa", 0.98, 203).w)).toBe(183);
    expect(furnitureBox("sofa", 0.68, 275).fit).toBe(1); // 맥 거실은 그대로
  });
  it("올라앉는 면: 캣타워 1층 0.8·2층 1.5, 소파 쿠션 위, 캣휠 레일 안쪽(키의 0.166) — 칸 맞춤으로 줄면 같이", () => {
    const t = furnitureSurfaces("cattower", 1);
    expect(t.map((s) => Math.round(s.y))).toEqual([80, 150]);
    expect(furnitureSurfaces("wheel", 1)[0].y / furnitureBox("wheel", 1).h).toBeCloseTo((16.5 - 11.2) / 32, 2);
    const s1 = furnitureSurfaces("sofa", 0.81), s2 = furnitureSurfaces("sofa", 0.81, 140);
    expect(s2[0].y / s1[0].y).toBeCloseTo(furnitureBox("sofa", 0.81, 140).fit, 6);
  });
  it("다섯 다 그려지고, 상자만 앞 겹이 따로 있다", () => {
    const calls: string[] = [];
    const g = new Proxy({}, { get: (_t, k) => (k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop() {} }) : (...a: unknown[]) => { calls.push(String(k)); return a; }), set: () => true }) as unknown as CanvasRenderingContext2D;
    for (const k of kinds) {
      calls.length = 0;
      drawFurniture(g, k, 100, 200, 1, { layer: "front" });
      expect(calls.includes("fill")).toBe(k === "box");
      calls.length = 0;
      drawFurniture(g, k, 100, 200, 1, { on: true, spin: 1, accent: "#33aa88" });
      expect(calls.includes("fill")).toBe(true);
    }
  });
});
