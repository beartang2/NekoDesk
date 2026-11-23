import { beforeEach, describe, expect, it, vi } from "vitest";

/** 꿈(0.1.25): 고른 그림을 엔진에 넘기고 노트에 남긴다. 그림이 없으면 새로 그리고, 생각하기가 안 되거나 그사이 깨면 꿈 없이 */
vi.hoisted(() => {
  const kv = new Map<string, string>();
  globalThis.localStorage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) } as Storage;
});
vi.mock("../api/tauri", () => ({ settingsApi: { get: async () => null, set: async () => {} }, syncApi: { status: async () => ({}) } }));
const h = vi.hoisted(() => ({ onThink: null as null | (() => void), dream: null as unknown, may: true, drawn: null as unknown, noted: [] as unknown[], drawAsked: [] as string[] }));
vi.mock("../agent/neko-mind", () => ({
  DREAM_GAP_MS: 3 * 3_600_000,
  loadMind: async () => ({ v: 1, notes: [], topics: [] }),
  mayDream: () => h.may,
  dreamThink: async () => { h.onThink?.(); return h.dream; },
  noteDream: async (d: unknown) => void h.noted.push(d),
}));
vi.mock("../agent/gift-draw", () => ({ drawGift: async (t: string) => { h.drawAsked.push(t); return h.drawn; } }));
vi.mock("./furnitureHost", () => ({ accentHex: () => "#aa66cc" }));
vi.mock("../stores/settingsStore", () => ({ isClaudeActive: () => false }));
vi.mock("../stores/claudeBudget", () => ({ budgetBlockReason: () => null }));

import { dreamOnce, dreamPictures } from "./dream";
import { useNekoGifts } from "./gifts";
import { useNekoFurniture } from "./furniture";
import { useNekoApp } from "./director/stores";
import type { NekoController } from "./engine/neko-engine";

const SHAPE = { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] };
const ctrlWith = (ret: boolean | undefined) => { const calls: unknown[] = []; return { calls, ctrl: { dream: (c: unknown) => { calls.push(c); return ret; } } as unknown as NekoController }; };

beforeEach(() => {
  h.onThink = null; h.dream = null; h.may = true; h.drawn = null; h.noted = []; h.drawAsked = [];
  useNekoGifts.setState({ gifts: [{ id: "g1", at: "2026-11-19T00:00:00Z", title: "빨간 열매", body: "동그랗다", shape: SHAPE as never }] } as never);
  useNekoFurniture.setState({ items: [{ id: "base:sofa", kind: "sofa", place: null }] } as never);
});

describe("꿈 그림과 엔진", () => {
  it("그림 목록은 최근 선물과 가구", () => {
    expect(dreamPictures().map((p) => p.label)).toEqual(["빨간 열매 — 동그랗다", "소파(가구)"]);
    expect(dreamPictures()[1].content).toEqual({ furniture: "sofa", accent: "#aa66cc" });
    // 자유 가구(물어온 것)는 kind 그림이 없다 — 제 모양으로
    useNekoFurniture.setState({ items: [{ id: "walk:f", kind: "free", title: "걸상", shape: SHAPE as never, uses: [], place: null }] } as never);
    expect(dreamPictures()[1]).toEqual({ label: "걸상(가구)", content: { shape: SHAPE } });
  });
  it("고른 번호의 그림으로 꿈을 띄우고 노트에 남긴다", async () => {
    h.dream = { text: "소파가 구름이 되는 꿈", see: 2, draw: "", greet: "" };
    const { ctrl, calls } = ctrlWith(true);
    expect(await dreamOnce(ctrl)).toBe(true);
    expect(calls).toEqual([{ furniture: "sofa", accent: "#aa66cc" }]);
    expect(h.noted).toHaveLength(1);
    expect(h.drawAsked).toEqual([]);
  });
  it("그림에 없으면 새로 그린다, 못 그리면 꿈 없이", async () => {
    h.dream = { text: "달 꿈", see: 0, draw: "달", greet: "" };
    h.drawn = { shape: SHAPE, first: SHAPE };
    const a = ctrlWith(true);
    expect(await dreamOnce(a.ctrl)).toBe(true);
    expect(h.drawAsked).toEqual(["달"]);
    expect(a.calls).toEqual([{ shape: SHAPE }]);
    h.drawn = null; h.noted = [];
    const b = ctrlWith(true);
    expect(await dreamOnce(b.ctrl)).toBe(false);
    expect(b.calls).toEqual([]);
    expect(h.noted).toEqual([]);
  });
  it("생각하기가 안 되거나 오늘 다 꿨거나 그사이 깨거나 누워 자는 중이 아니면 꿈 없이", async () => {
    const { ctrl, calls } = ctrlWith(true);
    expect(await dreamOnce(ctrl)).toBe(false); // dreamThink null
    h.may = false; h.dream = { text: "꿈", see: 1, draw: "", greet: "" };
    expect(await dreamOnce(ctrl)).toBe(false);
    h.may = true;
    h.onThink = () => useNekoApp.getState().markActive(); // 생각하는 사이 사용자가 돌아왔다
    expect(await dreamOnce(ctrl)).toBe(false);
    h.onThink = null;
    expect(calls).toEqual([]);
    expect(await dreamOnce(ctrlWith(false).ctrl)).toBe(false); // 엔진이 거절(깨 있음)
    expect(h.noted).toEqual([]);
  });
});
