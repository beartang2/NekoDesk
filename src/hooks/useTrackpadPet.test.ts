// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => {}) }));

import { useTrackpadPet } from "./useTrackpadPet";

let t = 0;
beforeEach(() => {
  t = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => t);
});

/** 16ms 간격으로 움직임을 차례로 넣는다. */
function moves(fn: (dx: number, dy: number) => void, list: [number, number][]) {
  for (const [dx, dy] of list) {
    t += 16;
    fn(dx, dy);
  }
}

describe("useTrackpadPet", () => {
  it("몸 위를 한 번 훑고 지나가면 쓰다듬기가 아니다", () => {
    const rub = vi.fn();
    const { result } = renderHook(() => useTrackpadPet(rub));
    moves(result.current.onBodyMove, Array(12).fill([15, 1]));
    expect(rub).not.toHaveBeenCalled();
  });

  it("왔다 갔다 문지르면 쓰다듬기다", () => {
    const rub = vi.fn();
    const { result } = renderHook(() => useTrackpadPet(rub));
    moves(result.current.onBodyMove, [[10, 0], [10, 0], [-10, 0], [-10, 0], [10, 0]]);
    expect(rub).toHaveBeenCalledTimes(1);
  });

  it("몸을 벗어나면 결을 처음부터 센다", () => {
    const rub = vi.fn();
    const { result } = renderHook(() => useTrackpadPet(rub));
    moves(result.current.onBodyMove, [[10, 0], [-10, 0]]);
    result.current.onBodyLeave();
    moves(result.current.onBodyMove, [[10, 0]]);
    expect(rub).not.toHaveBeenCalled();
  });

  it("잡고 흔드는 동안은 쓰다듬기가 아니고, 놓으면 결을 처음부터 센다", () => {
    const rub = vi.fn();
    const { result } = renderHook(() => useTrackpadPet(rub));
    result.current.setHeld(true);
    moves(result.current.onBodyMove, [[10, 0], [-10, 0], [10, 0], [-10, 0], [10, 0]]);
    expect(rub).not.toHaveBeenCalled();
    result.current.setHeld(false);
    moves(result.current.onBodyMove, [[-10, 0]]);
    expect(rub).not.toHaveBeenCalled();
    moves(result.current.onBodyMove, [[10, 0], [-10, 0]]);
    expect(rub).toHaveBeenCalledTimes(1);
  });
});
