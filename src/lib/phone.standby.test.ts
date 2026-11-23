// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 폰 가로 화면(네코만 보기): 그동안 네코 자리는 늘 거실 — 저장된 자리(방)를 다시 읽어도 화면이 비지 않는다 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../api/tauri", () => ({ settingsApi: { get: async () => null, set: async () => {} } }));

import { watchStandby } from "./phone";
import { isStandby } from "./standby";
import { normalizeStage, useNekoStore } from "../neko/nekoStore";

const mq = { matches: false, onChange: () => {} };
beforeEach(() => {
  mq.matches = false;
  window.matchMedia = ((q: string) => ({ media: q, get matches() { return mq.matches; }, addEventListener: (_: string, f: () => void) => { mq.onChange = f; }, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
const place = () => useNekoStore.getState().stage.placement;
const turn = (landscape: boolean) => { mq.matches = landscape; mq.onChange(); };

describe("가로 화면의 네코 자리", () => {
  it("방에 둔 채 가로로 켜도·가로 동안 저장된 자리를 다시 읽어도(켤 때·동기화) 거실에 있고, 세로로 돌리면 방으로 돌아간다", () => {
    const room = { ...normalizeStage({}), placement: "sidebar" as const };
    useNekoStore.setState({ stage: room });
    mq.matches = true; // 가로로 켠다
    watchStandby(document.documentElement);
    expect([isStandby(), place()]).toEqual([true, "dock"]);
    // nekoStore.load: DB 의 자리(방)를 다시 읽었다 — 거실 자리가 사라지면 화면 전체가 빈다
    useNekoStore.setState({ stage: room });
    expect(place()).toBe("dock");
    turn(false);
    expect([isStandby(), place()]).toEqual([false, "sidebar"]);
    // 세로에서는 자리를 그대로 바꿀 수 있다
    useNekoStore.setState({ stage: { ...room, placement: "dock" } });
    expect(place()).toBe("dock");
    turn(true);
    turn(false);
    expect(place()).toBe("dock");
  });
});
