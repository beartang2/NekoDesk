// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../api/tauri", () => ({ todosApi: {}, scheduleApi: {} }));

import { PomodoroCard } from "./RightPanel";
import { appEvents } from "../lib/events";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("커스텀 타이머", () => {
  it("정한 분이 지나면 네코가 알리고, 같은 시간으로 다시 준비된다", () => {
    vi.useFakeTimers();
    const spoken: string[] = [];
    const off = appEvents.on("timerDone", (t) => spoken.push(t));
    const { getByLabelText, getByTitle, getByText } = render(<PomodoroCard />);

    // 25분 → 5분 → 커스텀
    fireEvent.click(getByTitle("모드 전환"));
    fireEvent.click(getByTitle("모드 전환"));
    fireEvent.change(getByLabelText("타이머 분"), { target: { value: "1" } });
    fireEvent.click(getByText("▶"));

    act(() => vi.advanceTimersByTime(59_000));
    expect(spoken).toHaveLength(0);

    act(() => vi.advanceTimersByTime(1_500));
    expect(spoken).toEqual(["⏰ 1분 타이머 끝! 시간 다 됐어요."]);
    expect(invoke).toHaveBeenCalledWith("notify_send", { title: "네코", body: spoken[0] });
    // 다시 시작 전 상태 — 시간 자리가 분 입력으로 돌아온다.
    expect((getByLabelText("타이머 분") as HTMLInputElement).value).toBe("1");
    off();
  });
});
