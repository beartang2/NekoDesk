// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { useNekoApp } from "./director/stores";
import { watchWalkIdle } from "./walkWatch";

/** 산책 중 서둘러 오는 건 부를 때(callHome: 채팅 보내기·빈 자리 누르기·지도 '불러오기')만. 앱을 만지는 건 졸음 타이머만 */
afterEach(() => vi.useRealTimers());

describe("산책과 앱을 쓰는 중", () => {
  it("클릭·스크롤 같은 활동(markActive)은 졸음만 다시 걸고 부르지 않는다", () => {
    vi.useFakeTimers();
    useNekoApp.getState().markActive(); // 가짜 시계 기준으로
    const onCall = vi.fn(), idle: boolean[] = [];
    const off = watchWalkIdle({ sleepyMs: 1000, onIdle: (on) => idle.push(on), onCall });
    vi.advanceTimersByTime(1100);
    expect(idle[idle.length - 1]).toBe(true); // 졸기 시작
    useNekoApp.getState().markActive();
    useNekoApp.getState().notePet();
    expect(onCall).not.toHaveBeenCalled();
    expect(idle[idle.length - 1]).toBe(false); // 깼다
    off();
  });

  it("채팅을 보내면(callHome) 부른 것이다 — 서둘러 오고 졸음도 깬다", () => {
    const onCall = vi.fn(), idle: boolean[] = [];
    const off = watchWalkIdle({ sleepyMs: 60_000, onIdle: (on) => idle.push(on), onCall });
    useNekoApp.getState().callHome();
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(idle[idle.length - 1]).toBe(false);
    off();
    useNekoApp.getState().callHome();
    expect(onCall).toHaveBeenCalledTimes(1); // 끈 뒤엔 안 듣는다
  });
});
