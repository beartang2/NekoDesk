// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PetAct, PetBase } from "../api/tauri";

/** 놀이 게이지를 서버가 계산할 때(새 Worker): 훅은 그 값을 보이고 행동만 넘긴다 — 줄어든 값을 cat_rpg_state 에 저장하지 않는다 */
const h = vi.hoisted(() => ({ supported: true, pet: null as PetBase | null, sent: [] as { acts: PetAct[]; init: unknown }[], saved: [] as string[], legacy: null as string | null }));
vi.mock("../api/tauri", () => ({
  settingsApi: {
    get: async (k: string) => (k === "cat_rpg_state" ? h.legacy : null),
    set: async (k: string) => { h.saved.push(k); },
  },
  syncApi: {
    petShared: async () => ({ supported: h.supported, pet: h.pet }),
    petAct: async (acts: PetAct[], init: { play: number; at: number } | null) => {
      h.sent.push({ acts, init });
      const { applyActs } = await import("../lib/petGauge");
      h.pet = applyActs(h.pet ?? { play: init?.play ?? 100, at: init?.at ?? Date.now(), feeds: 0, day: "" }, acts);
      return h.pet;
    },
  },
}));

import { useCatRpg, resetRpgSync } from "./useCatRpg";
import { flushPet, resetPetGauge } from "../lib/petGauge";
import { resetNeedsSync } from "../neko/director/needsStore";

const today = () => new Date().toISOString().slice(0, 10);
beforeEach(() => {
  h.supported = true; h.pet = null; h.sent = []; h.saved = []; h.legacy = null;
  localStorage.clear();
  resetPetGauge(); resetRpgSync(); resetNeedsSync();
});

describe("놀이 게이지(서버 기준)", () => {
  it("서버 기준을 보이고, 놀아 주기·쓰다듬기·밥은 행동으로 보낸다. cat_rpg_state 엔 줄어든 값을 안 적는다", async () => {
    h.pet = { play: 50, at: Date.now(), feeds: 0, day: today() };
    const { result } = renderHook(() => useCatRpg());
    await waitFor(() => expect(result.current.state.play).toBeCloseTo(50, 0));
    act(() => { result.current.playAction(); result.current.pet(); result.current.feed(); });
    expect(result.current.state.play).toBeCloseTo(80, 0); // 답이 오기 전에도 얹어 보인다
    expect(result.current.state.feedCountToday).toBe(1);
    await act(() => flushPet());
    expect(h.sent[h.sent.length - 1].acts.map((a) => a.kind)).toEqual(["play", "pet", "feed"]);
    expect(result.current.state.play).toBeCloseTo(80, 0);
    expect(h.saved.filter((k) => k === "cat_rpg_state")).toEqual([]);
  });

  it("서버에 기준이 아직 없으면 이 기기가 보이던 값으로 시작하게 보낸다", async () => {
    h.legacy = JSON.stringify({ birthday: "2026-11-01", hunger: 50, play: 64, lastTick: new Date().toISOString(), feedCountToday: 0, feedDate: today() });
    const { result } = renderHook(() => useCatRpg());
    await waitFor(() => expect(h.sent).toHaveLength(1));
    expect((h.sent[0].init as { play: number }).play).toBeCloseTo(64, 0);
    await waitFor(() => expect(result.current.state.play).toBeCloseTo(64, 0));
  });

  it("옛 서버면 예전 방식 그대로(이 기기에서 줄이고 cat_rpg_state 에 적는다)", async () => {
    h.supported = false;
    h.legacy = JSON.stringify({ birthday: "2026-11-01", hunger: 50, play: 40, lastTick: new Date().toISOString(), feedCountToday: 0, feedDate: today() });
    const { result } = renderHook(() => useCatRpg());
    await waitFor(() => expect(result.current.state.play).toBeCloseTo(40, 0));
    act(() => result.current.playAction());
    expect(result.current.state.play).toBeCloseTo(60, 0);
    expect(h.sent).toEqual([]);
    expect(h.saved).toContain("cat_rpg_state");
  });
});
