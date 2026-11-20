import { describe, it, expect } from "vitest";
import { ARCH_MAX, archOrigin, archSpots, shortName } from "./NekoFileArch";

describe("파일 아치", () => {
  it("머리 위 반원에 왼쪽부터, 5개 넘으면 바깥 띠(두 겹), 12개까지", () => {
    const s5 = archSpots(5);
    expect(s5).toHaveLength(5);
    expect(s5.every((p) => p.y < 0)).toBe(true); // 다 기준점 위
    expect(s5[0].x).toBeLessThan(0);
    expect(s5[4].x).toBeGreaterThan(0);
    const s12 = archSpots(20);
    expect(s12).toHaveLength(ARCH_MAX);
    const r = (p: { x: number; y: number }) => Math.round(Math.hypot(p.x, p.y) / 10); // 좌표 반올림 오차는 무시
    expect(new Set(s12.map(r)).size).toBe(2); // 두 띠
    // 이름 알약(64px)이 같은 띠에서 안 겹친다
    for (const band of [s12.slice(0, 5), s12.slice(5)]) {
      for (let i = 1; i < band.length; i++) expect(Math.hypot(band[i].x - band[i - 1].x, band[i].y - band[i - 1].y)).toBeGreaterThanOrEqual(64);
    }
  });
  it("긴 이름은 가운데를 줄이고 확장자는 남긴다", () => {
    expect(shortName("보고서.pdf")).toBe("보고서.pdf");
    const s = shortName("2026-11-20 회의록 최종 수정본.docx");
    expect(s).toBe("2026-…docx".replace("…docx", "…") + ".docx");
    expect(shortName("스크린샷 2026-11-20 오후 3.12.04.png")).toBe("스크린…png".replace("…png", "…") + ".png");
    expect(shortName("아주아주긴폴더이름입니다")).toBe("아주아주긴…");
  });
  it("기준점은 머리 위, 화면 가장자리에서 열려도 창 안에 다 든다", () => {
    const sp = archSpots(12), view = { w: 1440, h: 900 };
    expect(archOrigin({ x: 700, y: 800, r: 30 }, sp, view)).toEqual({ x: 700, y: 758 }); // 머리 위 30 + 12
    const left = archOrigin({ x: 20, y: 800, r: 30 }, sp, view), top = archOrigin({ x: 700, y: 60, r: 30 }, sp, view);
    expect(left.x + Math.min(...sp.map((p) => p.x)) - 32).toBeGreaterThanOrEqual(8);
    expect(top.y + Math.min(...sp.map((p) => p.y)) - 24).toBeGreaterThanOrEqual(8);
  });
});
