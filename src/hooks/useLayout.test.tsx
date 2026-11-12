// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLayout } from "./useLayout";

function resize(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    window.dispatchEvent(new Event("resize"));
  });
}

describe("useLayout 오른쪽 패널 자동 접기", () => {
  it("창이 좁아지면 접고, 다시 넓어지면 편다", () => {
    resize(1200);
    const { result } = renderHook(() => useLayout());
    expect(result.current.rightPanelVisible).toBe(true);
    resize(800); // 800 - 228 - 210 = 362 < 420
    expect(result.current.rightPanelVisible).toBe(false);
    resize(880); // 경계 바로 위(442)에선 아직 접힌 채 — 깜빡이지 않게
    expect(result.current.rightPanelVisible).toBe(false);
    resize(1000);
    expect(result.current.rightPanelVisible).toBe(true);
  });

  it("손으로 닫아 둔 패널은 넓어져도 다시 열지 않는다", () => {
    resize(1200);
    const { result } = renderHook(() => useLayout());
    act(() => result.current.setRightPanelVisible(false));
    resize(800);
    resize(1200);
    expect(result.current.rightPanelVisible).toBe(false);
  });
});
