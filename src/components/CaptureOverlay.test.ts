import { describe, it, expect } from "vitest";
import { brightnessAt, regionBrightness, toneOver, type Lum } from "./CaptureOverlay";

/** 왼쪽 절반은 검정, 오른쪽 절반은 흰색인 4×2 흑백 지도. */
function halfAndHalf(): Lum {
  const w = 4;
  const h = 2;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = x < 2 ? 0 : 255;
  }
  return { w, h, data };
}

describe("brightnessAt", () => {
  it("어두운 쪽은 0 에, 밝은 쪽은 1 에 가깝다", () => {
    const lum = halfAndHalf();
    expect(brightnessAt(lum, 0, 0.5)).toBeLessThan(0.1);
    expect(brightnessAt(lum, 1, 0.5)).toBeGreaterThan(0.9);
  });

  it("경계 바로 옆이어도 그 점의 색만 본다 — 둘레를 섞지 않는다", () => {
    // 4칸 중 1번 칸(검정)과 2번 칸(흰색)이 경계. 0.3 → 1번, 0.55 → 2번.
    expect(brightnessAt(halfAndHalf(), 0.3, 0.5)).toBe(0);
    expect(brightnessAt(halfAndHalf(), 0.55, 0.5)).toBe(1);
  });

  it("화면 밖 좌표는 가장자리로 붙인다", () => {
    expect(brightnessAt(halfAndHalf(), 1.5, -1)).toBeGreaterThan(0.9);
  });
});

describe("regionBrightness", () => {
  it("넓은 칸의 평균을 낸다 — 왼쪽 띠는 어둡고, 오른쪽 띠는 밝고, 전체는 그 사이", () => {
    const lum = halfAndHalf();
    expect(regionBrightness(lum, 0, 0, 0.3, 1)).toBeLessThan(0.1);
    expect(regionBrightness(lum, 0.7, 0, 1, 1)).toBeGreaterThan(0.9);
  });
});

describe("toneOver", () => {
  it("기준 언저리에선 지금 색조를 지킨다 — 밝기 지도가 올 때마다 번갈아 바뀌지 않게", () => {
    // 덮개 없이(covered=false) 기준(0.42) 바로 위·아래.
    expect(toneOver(0.44, false)).toBe("dark");
    expect(toneOver(0.44, false, "light")).toBe("light");
    expect(toneOver(0.4, false, "dark")).toBe("dark");
    // 여유 폭을 넘으면 바뀐다.
    expect(toneOver(0.5, false, "light")).toBe("dark");
    expect(toneOver(0.3, false, "dark")).toBe("light");
  });
});
