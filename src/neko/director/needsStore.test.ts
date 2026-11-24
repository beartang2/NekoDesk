import { beforeEach, describe, expect, it, vi } from "vitest";

/** 숨은 게이지는 맥·폰이 같이 쓴다(neko_needs 동기화): 드물게 쓰고, 받은 값은 지난 시간만큼 줄여 읽고, 생일은 가장 이른 날 */
const db = vi.hoisted(() => ({ kv: new Map<string, string>(), writes: 0 }));
vi.mock("../../api/tauri", () => ({
  settingsApi: {
    get: async (k: string) => db.kv.get(k) ?? null,
    set: async (k: string, v: string) => { db.writes++; db.kv.set(k, v); },
  },
}));

import { resetNeedsSync, useNekoNeeds } from "./needsStore";
import { appEvents } from "../../lib/events";

const fresh = () => {
  resetNeedsSync();
  useNekoNeeds.setState({ loaded: false, born: null, needs: { energy: 70, curiosity: 70, clean: 70, affection: 70 }, touchedAt: Date.now() });
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const stored = () => JSON.parse(db.kv.get("neko_needs")!) as Record<string, number | string>;

beforeEach(() => { db.kv.clear(); db.writes = 0; fresh(); });

describe("숨은 게이지 동기화", () => {
  it("1분 틱마다 쓰지 않는다 — 눈에 띄게 바뀌었거나 10분이 지났을 때만", async () => {
    await useNekoNeeds.getState().load();
    const after = db.writes;
    for (let i = 0; i < 5; i++) useNekoNeeds.getState().tick(60_000, "awake", []); // 호기심 −10/시간 → 5분에 약 0.8
    expect(db.writes).toBe(after);
    for (let i = 0; i < 20; i++) useNekoNeeds.getState().tick(60_000, "awake", []); // 25분: 호기심 약 4 줄어 넘음
    expect(db.writes).toBeGreaterThan(after);
    expect(db.writes - after).toBeLessThan(5);
  });

  it("다른 기기가 나중에 잰 값이 오면 그때부터 지난 만큼 줄여 읽고, 내 것보다 오래된 건 무시한다", async () => {
    await useNekoNeeds.getState().load();
    const mine = stored().at as number;
    db.kv.set("neko_needs", JSON.stringify({ energy: 20, curiosity: 90, clean: 50, affection: 80, at: Date.now() - 60 * 60_000 }));
    appEvents.emit("syncChanged", { colls: ["setting"] });
    await flush();
    expect(useNekoNeeds.getState().needs.curiosity).toBeCloseTo(70, 0); // 한 시간 전 값(오래됨) — 내 것 그대로

    db.kv.set("neko_needs", JSON.stringify({ energy: 20, curiosity: 90, clean: 50, affection: 80, at: mine + 30 * 60_000 }));
    vi.useFakeTimers({ now: mine + 90 * 60_000, toFake: ["Date"] });
    await useNekoNeeds.getState().pull();
    vi.useRealTimers();
    const n = useNekoNeeds.getState().needs;
    expect(n.curiosity).toBeCloseTo(80, 0); // 90 에서 한 시간(깨어 있음 −10)
    expect(n.energy).toBeCloseTo(16, 0);
  });

  it("생일은 가장 이른 날로 맞추고 같이 저장한다", async () => {
    db.kv.set("neko_needs", JSON.stringify({ energy: 70, curiosity: 70, clean: 70, affection: 70, at: Date.now(), born: "2026-10-01" }));
    await useNekoNeeds.getState().load();
    expect(useNekoNeeds.getState().born).toBe("2026-10-01");
    useNekoNeeds.getState().setBorn("2026-11-05");
    expect(useNekoNeeds.getState().born).toBe("2026-10-01");
    useNekoNeeds.getState().setBorn("2026-09-20");
    expect(stored().born).toBe("2026-09-20");
  });
});

describe("숨은 게이지는 앞 기기가 계산한다", () => {
  it("다른 기기가 앞이면 적지도 제 활동으로 채우지도 않고, 이 기기가 앞이 되면 이어 계산해 바로 적는다", async () => {
    const { setFollowing } = await import("../lead");
    db.kv.set("neko_needs", JSON.stringify({ energy: 50, curiosity: 50, clean: 50, affection: 50, at: Date.now() }));
    await useNekoNeeds.getState().load();
    expect(db.writes).toBe(0); // 저장된 값이 있으면 켰다고 다시 적지 않는다(낡은 값으로 앞 기기 것을 덮지 않게)
    setFollowing(true);
    const before = useNekoNeeds.getState().needs.curiosity;
    for (let i = 0; i < 30; i++) useNekoNeeds.getState().tick(60_000, "awake", ["window"]); // 창밖 구경은 호기심을 채운다
    expect(useNekoNeeds.getState().needs.curiosity).toBeLessThan(before); // 채우지 않고 줄기만
    expect(db.writes).toBe(0);
    // 앞 기기 값이 오면 그걸 따른다
    db.kv.set("neko_needs", JSON.stringify({ energy: 90, curiosity: 90, clean: 90, affection: 90, at: Date.now() + 1 }));
    appEvents.emit("syncChanged", { colls: ["setting"] });
    await flush();
    expect(useNekoNeeds.getState().needs.curiosity).toBeGreaterThan(85);
    // 이 기기를 쓰기 시작했다: 받아 온 값에서 이어 가고 한 번 적는다
    setFollowing(false);
    expect(db.writes).toBe(1);
    expect(stored().curiosity as number).toBeGreaterThan(85);
  });
});
