// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { isStandby, setStandby, useStandby } from "./standby";

describe("standby", () => {
  it("가로 화면이 켜지고 꺼질 때 그 화면을 쓰는 곳이 다시 그린다(가려진 것을 내려놓고 되살리게)", () => {
    const { result } = renderHook(() => useStandby());
    expect(result.current).toBe(false);
    act(() => setStandby(true));
    expect(result.current).toBe(true);
    expect(isStandby()).toBe(true);
    act(() => setStandby(false));
    expect(result.current).toBe(false);
  });
});
