// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useShown } from "./useShown";

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
};

afterEach(() => { vi.useRealTimers(); delete (document as { hidden?: boolean }).hidden; });

describe("useShown", () => {
  it("다시 보일 때 올라가고 조금 뒤 한 번 더 — 숨을 때는 그대로", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useShown());
    expect(result.current).toBe(0);
    setHidden(true);
    expect(result.current).toBe(0);
    setHidden(false);
    expect(result.current).toBe(1);
    act(() => { vi.advanceTimersByTime(1500); });
    expect(result.current).toBe(2);
  });
});
