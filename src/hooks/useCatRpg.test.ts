import { beforeEach, describe, expect, it, vi } from "vitest";

/** 밥·놀이도 맥·폰이 한 고양이(cat_rpg_state 동기화): 받은 값은 나중에 잰 것만, 지난 만큼 줄여 읽고, 생일은 이른 날 */
vi.mock("../api/tauri", () => ({ settingsApi: { get: async () => null, set: async () => {} } }));
import { newerRemote, resetRpgSync, type CatRpgState } from "./useCatRpg";

const at = (min: number) => new Date(Date.UTC(2026, 10, 19, 12, min)).toISOString();
const st = (o: Partial<CatRpgState>): CatRpgState => ({ birthday: "2026-11-01", hunger: 50, play: 50, lastTick: at(0), feedCountToday: 0, feedDate: "2026-11-19", ...o });

beforeEach(() => resetRpgSync());

describe("밥·놀이 동기화", () => {
  it("다른 기기가 밥을 줬으면(나중에 잰 값) 그 값을 지난 만큼 줄여 쓴다", () => {
    const mine = st({ hunger: 20, lastTick: at(0) });
    const remote = st({ hunger: 90, play: 70, lastTick: at(10), feedCountToday: 1 });
    const got = newerRemote(remote, mine, new Date(at(20)).getTime())!;
    expect(got.hunger).toBeCloseTo(85, 5); // 10분 −5
    expect(got.play).toBeCloseTo(67, 5);   // 10분 −3
    expect(got.feedCountToday).toBe(1);
  });

  it("내 것보다 먼저 잰 값·망가진 값은 무시한다", () => {
    const mine = st({ lastTick: at(30) });
    expect(newerRemote(st({ hunger: 99, lastTick: at(10) }), mine, new Date(at(40)).getTime())).toBeNull();
    expect(newerRemote(null, mine, Date.now())).toBeNull();
    expect(newerRemote({ ...st({ lastTick: at(50) }), hunger: NaN }, mine, Date.now())).toBeNull();
  });

  it("생일은 더 이른 날을 남긴다", () => {
    const mine = st({ birthday: "2026-10-05", lastTick: at(0) });
    expect(newerRemote(st({ birthday: "2026-11-02", lastTick: at(5) }), mine, new Date(at(5)).getTime())!.birthday).toBe("2026-10-05");
    expect(newerRemote(st({ birthday: "2026-09-01", lastTick: at(5) }), mine, new Date(at(5)).getTime())!.birthday).toBe("2026-09-01");
  });
});
