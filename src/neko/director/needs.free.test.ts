import { describe, expect, it, vi } from "vitest";

/**
 * 자유 가구 쓰임새 놀이(docs/neko-furniture-free.md §9): 그 장소의 자유 가구가 그 쓰임새를 내줄 때만 후보. MIX 선언(엔진, 디자이너 몫 4)이
 * 들어오기 전이라 여기선 선언을 흉내 낸다
 */
vi.mock("../engine/activity-mix", async (orig) => {
  const a = (await orig()) as { MIX: Record<string, unknown> };
  const f = (energy: number, curiosity: number, clean: number, affection: number) => ({ solo: true, fills: { energy, curiosity, clean, affection } });
  return { ...a, MIX: { ...a.MIX, fperch: f(10, 0, 0, 5), fhide: f(5, 10, 0, 0), fscratch: f(-10, 0, 5, 0), fbat: f(-10, 10, 0, 0) } };
});

import { soloOdds, START } from "./needs";

const keys = (uses?: string[], furniture?: string[]) => soloOdds(START, { last: null, hasGifts: false, furniture, furnitureUses: uses }).map((o) => o.key as string);

describe("자유 가구 쓰임새 놀이", () => {
  it("그 쓰임새가 그 자리에 있을 때만 후보 — 기본 가구 놀이와 따로 본다", () => {
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
});
