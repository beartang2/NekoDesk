// @vitest-environment jsdom
// 한 번짜리 표(toolActivity)가 tool-registry(→ settingsStore 가 localStorage 를 읽는다)를 불러온다
import { describe, expect, it } from "vitest";

/** 자유 가구 쓰임새 놀이(docs/neko-furniture-free.md §9): 그 장소의 자유 가구가 그 쓰임새를 내줄 때만 후보(MIX 선언은 엔진 몫 4, 4287408) */
import { applyFill, decay, fillsOf, pickByNeeds, SOLO_KEYS, soloOdds, START } from "./needs";
import { ONE_SHOT } from "./toolActivity";
import type { NekoActivity } from "../engine/neko-engine";

const keys = (uses?: string[], furniture?: string[]) => soloOdds(START, { last: null, hasGifts: false, furniture, furnitureUses: uses }).map((o) => o.key as string);

describe("자유 가구 쓰임새 놀이", () => {
  it("그 쓰임새가 그 자리에 있을 때만 후보 — 기본 가구 놀이와 따로 본다", () => {
    expect(SOLO_KEYS).toEqual(expect.arrayContaining(["fperch", "fhide", "fscratch", "fbat"]));
    expect(keys()).not.toEqual(expect.arrayContaining(["fperch"]));
    const free = ["fperch", "fhide", "fscratch", "fbat"];
    expect(keys().filter((k) => free.includes(k))).toEqual([]);
    expect(keys(["perch", "bat"]).filter((k) => free.includes(k)).sort()).toEqual(["fbat", "fperch"]);
    expect(keys(["inside", "inside", "scratch"]).filter((k) => free.includes(k)).sort()).toEqual(["fhide", "fscratch"]);
    // 소파가 놓였다고 자유 가구 올라앉기가 생기지 않고, 자유 가구 면이 있다고 소파 놀이가 생기지 않는다
    expect(keys(undefined, ["sofa"])).toContain("sofa");
    expect(keys(undefined, ["sofa"])).not.toContain("fperch");
    expect(keys(["perch"])).not.toContain("sofa");
  });

  it("가상 하루 8시간(자유 가구 쓰임새 넷 + 소파·탁자가 다 있는 자리): 한 활동이 30% 를 넘지 않는다", () => {
    let st = { ...START }, last: NekoActivity | null = null, seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const count = new Map<string, number>();
    let picks = 0, minutes = 0;
    const where = { hasGifts: false, furniture: ["sofa", "table"], furnitureUses: ["perch", "inside", "scratch", "bat"] };
    while (minutes < 8 * 60) {
      st = decay(st, 1.5 * 60_000, "awake"); minutes += 1.5;
      const k = pickByNeeds(st, { ...where, last }, rand());
      last = k; picks++; count.set(k, (count.get(k) ?? 0) + 1);
      const stay = ONE_SHOT.has(k) ? 0.3 : 3;
      st = decay(applyFill(st, fillsOf(k), ONE_SHOT.has(k) ? 3 : stay), stay * 60_000, "awake"); minutes += stay;
    }
    expect(Math.max(...count.values()) / picks).toBeLessThan(0.3);
    expect(["fperch", "fhide", "fscratch", "fbat"].filter((k) => count.has(k)).length).toBeGreaterThanOrEqual(3); // 쓰임새 놀이도 실제로 나온다
  });
});
