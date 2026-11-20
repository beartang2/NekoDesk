// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 큰 상태 맞추기(0.1.22): 가장 최근에 쓴 기기만 바뀔 때 적고, 다른 기기는 따른다 */
const db = vi.hoisted(() => ({ kv: new Map<string, string>(), writes: 0 }));
vi.mock("../api/tauri", () => ({
  settingsApi: { get: async (k: string) => db.kv.get(k) ?? null, set: async (k: string, v: string) => { db.writes++; db.kv.set(k, v); } },
  syncApi: { status: async () => ({ device: "mac" }) },
}));

import { followState, leaderUsedAt, parsePresence, reportBigState, resetPresence, usedAtNow, watchPresence, type Presence } from "./presence";
import { useNekoApp } from "./director/stores";
import { appEvents } from "../lib/events";

const flush = () => new Promise((r) => setTimeout(r, 0));
const stored = () => JSON.parse(db.kv.get("neko_presence")!) as Presence;

beforeEach(() => { db.kv.clear(); db.writes = 0; useNekoApp.getState().markActive(); resetPresence("mac", null); });

describe("큰 상태 맞추기", () => {
  it("앞 기기(이 기기)는 큰 상태가 바뀔 때만 적는다", () => {
    reportBigState("awake"); reportBigState("awake"); reportBigState("sleep"); reportBigState("sleep");
    expect(db.writes).toBe(2);
    expect(stored()).toMatchObject({ state: "sleep", device: "mac" });
    expect(followState()).toBeNull(); // 제 기록은 안 따른다
  });

  it("다른 기기가 더 최근에 쓰였으면 그 큰 상태를 따르고 적지 않는다. 하루 반 넘은 기록·망가진 기록은 안 따른다", () => {
    const phone: Presence = { state: "sleep", at: Date.now(), used: usedAtNow() + 60_000, device: "phone" };
    resetPresence("mac", phone);
    expect(followState()).toBe("sleep");
    expect(leaderUsedAt()).toBe(phone.used);
    reportBigState("awake");
    expect(db.writes).toBe(0);
    resetPresence("mac", { ...phone, at: Date.now() - 13 * 3_600_000 });
    expect(followState()).toBeNull();
    expect(parsePresence('{"state":"dance","at":1,"used":1,"device":"x"}')).toBeNull();
    expect(parsePresence("{망가짐")).toBeNull();
  });

  it("다른 기기를 따르던 중에 이 기기를 쓰기 시작하면 앞이 되어 한 번 적는다(자던 건 깬 것으로)", async () => {
    resetPresence("", null);
    const off = watchPresence();
    await flush(); await flush();
    db.kv.set("neko_presence", JSON.stringify({ state: "sleep", at: Date.now(), used: Date.now() + 5_000, device: "phone" }));
    appEvents.emit("syncChanged", { colls: ["setting"] });
    await flush();
    reportBigState("sleep"); // 이 기기도 쉬는 중이었다
    expect(followState()).toBe("sleep");
    const n = db.writes;
    await new Promise((r) => setTimeout(r, 10));
    vi.useFakeTimers({ now: Date.now() + 10_000, toFake: ["Date"] });
    useNekoApp.getState().markActive(); // 맥을 만졌다
    vi.useRealTimers();
    expect(db.writes).toBe(n + 1);
    expect(stored()).toMatchObject({ state: "awake", device: "mac" });
    expect(followState()).toBeNull();
    off();
  });
});
