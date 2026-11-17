import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, DOCK_H, SIDEBAR_H, migrateVariant, normalizeAppearance, normalizeStage } from "./nekoStore";

describe("nekoStore 정리 함수", () => {
  it("알 수 없는 값은 기본값으로, 무늬는 중복 없이", () => {
    const a = normalizeAppearance({ coat: "rainbow", patterns: ["tabby", "tabby", "stars"], eye: "red", soft: 9 });
    expect(a.coat).toBe("cream");
    expect(a.patterns).toEqual(["tabby"]);
    expect(a.eye).toBe("yellow");
    expect(a.soft).toBe(1);
  });

  it("직접 고른 털 색은 #rrggbb 만 받는다", () => {
    expect(normalizeAppearance({ coat: "custom", color: "#A1B2C3" })).toMatchObject({ coat: "custom", color: "#a1b2c3" });
    expect(normalizeAppearance({ coat: "custom", color: "red" }).color).toBe("#c8a27a");
  });

  it("예전 스프라이트 색을 옮긴다", () => {
    expect(migrateVariant("orange")).toEqual({ coat: "cheese", patterns: [] });
    expect(migrateVariant("brown")).toEqual({ coat: "cheese", patterns: ["tabby"] });
    expect(migrateVariant("white")).toEqual({ coat: "white", patterns: [] });
    expect(migrateVariant("tuxedo")).toEqual({ coat: "black", patterns: ["white"], eye: "yellow" });
    expect(migrateVariant(null)).toBeNull();
  });

  it("자리 높이는 범위 안으로", () => {
    expect(normalizeStage({ placement: "dock", sidebarH: 9999, dockH: 10 })).toEqual({ placement: "dock", sidebarH: SIDEBAR_H.max, dockH: DOCK_H.min });
    expect(normalizeStage(null)).toEqual({ placement: "sidebar", sidebarH: SIDEBAR_H.def, dockH: DOCK_H.def });
  });
});
