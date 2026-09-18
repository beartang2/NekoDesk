// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { CatCanvas } from "./CatCanvas";

/** 지금 화면에 걸린 감정 — 무대 클래스가 곧 그 상태다. */
function shownEmotion(container: HTMLElement): string {
  const stage = container.querySelector(".cat-canvas-stage")!;
  return [...stage.classList].find((c) => c.startsWith("cat-canvas-stage--"))!.replace("cat-canvas-stage--", "");
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("쓰다듬은 뒤 되돌아가기", () => {
  it("기뻐하다가 곧장 자지 않고 평소 모습을 한 번 거친다", () => {
    const { container } = render(<CatCanvas emotion="sleepy" />);
    expect(shownEmotion(container)).toBe("sleepy");

    fireEvent.click(container.querySelector(".cat-canvas-pet-area")!);
    expect(shownEmotion(container)).toBe("proud");

    // 쓰다듬기 반응이 끝나면 먼저 평소 모습으로.
    act(() => { vi.advanceTimersByTime(2000); });
    expect(shownEmotion(container)).toBe("idle");

    // 한 박자 뒤에야 원래 하던 것으로 돌아간다.
    act(() => { vi.advanceTimersByTime(700); });
    expect(shownEmotion(container)).toBe("sleepy");
  });

  it("쓰다듬는 동안에는 되돌아가는 타이머가 다시 시작된다", () => {
    const { container } = render(<CatCanvas emotion="working" />);
    const area = container.querySelector(".cat-canvas-pet-area")!;

    fireEvent.click(area);
    act(() => { vi.advanceTimersByTime(1800); });
    fireEvent.click(area); // 다시 쓰다듬음
    act(() => { vi.advanceTimersByTime(1800); });

    // 첫 쓰다듬기로부터 3.6초가 지났지만 아직 쓰다듬기 상태다.
    expect(["proud", "happy"]).toContain(shownEmotion(container));
  });
});
