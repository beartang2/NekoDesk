// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PetAct, PetBase } from "../api/tauri";

/**
 * 놀이 게이지는 서버가 하나로 계산한다(docs/neko-sync.md §4.7). 여기 서버 흉내는 Worker 의 petAct 와 같은 규칙:
 * 같은 id 는 한 번, 시각 순으로 기준을 줄인 뒤 더한다(실제 Worker 는 server/test/sync.mjs 가 본다)
 */
const server = vi.hoisted(() => ({ pet: null as PetBase | null, ids: new Set<string>(), down: false, calls: 0 }));
vi.mock("../api/tauri", () => ({
  syncApi: {
    petShared: async () => ({ supported: true, pet: server.pet }),
    petAct: async (acts: PetAct[], init: { play: number; at: number } | null) => {
      server.calls++;
      if (server.down) throw new Error("오프라인");
      const { applyActs } = await import("./petGauge");
      server.pet ??= { play: init?.play ?? 100, at: init?.at ?? Date.now(), feeds: 0, day: "" };
      const fresh = acts.filter((a) => !server.ids.has(a.id));
      fresh.forEach((a) => server.ids.add(a.id));
      server.pet = applyActs(server.pet, fresh);
      return server.pet;
    },
  },
}));

import { applyActs, flushPet, petDo, petGauge, petView, playAt, refreshPet, resetPetGauge, setPetSeed } from "./petGauge";

const T = Date.UTC(2026, 10, 24, 3, 0), MIN = 60_000;
const base = (o: Partial<PetBase> = {}): PetBase => ({ play: 50, at: T, feeds: 0, day: "2026-11-24", ...o });
const act = (kind: PetAct["kind"], min: number, id: string, n?: number): PetAct => ({ kind, at: T + min * MIN, id, ...(n === undefined ? {} : { n }) });

beforeEach(() => {
  server.pet = null; server.ids.clear(); server.down = false; server.calls = 0;
  localStorage.clear();
  resetPetGauge();
  vi.useRealTimers();
});

describe("놀이 게이지 식(서버와 같다)", () => {
  it("분당 0.3 줄고 0–100 안, 행동은 그 시각까지 줄인 뒤 더한다", () => {
    expect(playAt(base(), T + 10 * MIN)).toBeCloseTo(47, 5);
    expect(playAt(base({ play: 2 }), T + 60 * MIN)).toBe(0);
    const p = applyActs(base(), [act("play", 10, "a"), act("pet", 20, "b"), act("reward", 20, "c", 5)]);
    expect(p.play).toBeCloseTo(50 - 3 + 20 - 3 + 10 + 5, 5);
    expect(p.at).toBe(T + 20 * MIN);
    // 보낸 순서와 상관없이 시각 순
    expect(applyActs(base(), [act("pet", 20, "b"), act("play", 10, "a")]).play).toBeCloseTo(applyActs(base(), [act("play", 10, "a"), act("pet", 20, "b")]).play, 5);
  });
  it("기준보다 이른 행동(오프라인에서 늦게 온 것)은 더하기만, 밥은 그날 횟수만 센다", () => {
    const p = applyActs(base({ at: T + 30 * MIN }), [act("play", 5, "old"), act("feed", 31, "f1"), act("feed", 24 * 60, "f2")]);
    expect(p.play).toBe(0); // 놀이 +20 뒤 다음 날 밥 시각까지 줄어든다(0 아래로는 안 간다)
    expect([p.day, p.feeds]).toEqual(["2026-11-25", 1]);
    expect(applyActs(base({ at: T + 30 * MIN }), [act("play", 5, "old")]).play).toBe(70);
  });
});

describe("놀이 게이지 보내기", () => {
  /** 기기 하나를 흉내 낸다: 모듈 상태를 그 기기 것으로 바꿔 끼운다 */
  const device = (q: PetAct[] = []) => ({ queue: q, pet: null as PetBase | null });
  async function on<R>(d: ReturnType<typeof device>, run: () => R | Promise<R>): Promise<R> {
    resetPetGauge({ supported: true, pet: d.pet, queue: d.queue });
    const out = await run();
    await flushPet();
    d.queue = petGauge().queue; d.pet = petGauge().pet;
    return out;
  }

  it("두 기기에서 번갈아 놀아 주고 쓰다듬어도 같은 값이 된다(처음 기준은 먼저 보낸 기기 값)", async () => {
    const mac = device(), phone = device();
    await on(mac, () => { setPetSeed({ play: 40, at: Date.now() }); petDo("play"); });
    await on(phone, () => { setPetSeed({ play: 90, at: Date.now() }); petDo("pet"); });
    await on(mac, () => refreshPet());
    await on(phone, () => refreshPet());
    expect(mac.pet).toEqual(phone.pet);
    expect(mac.pet!.play).toBeCloseTo(70, 0); // 40 + 20 + 10 (맥이 먼저라 맥 값에서 시작)
    expect(mac.queue.length + phone.queue.length).toBe(0);
  });

  it("같은 행동을 두 번 보내도 한 번만 적용된다(답을 못 받아 다시 보낸 경우)", async () => {
    const d = device();
    await on(d, () => { setPetSeed({ play: 10, at: Date.now() }); petDo("play"); });
    const sent = [...server.ids][0];
    // 답을 못 받았다고 치고 같은 번호로 다시 보낸다
    await on(d, () => { resetPetGauge({ supported: true, pet: d.pet, queue: [{ kind: "play", at: Date.now(), id: sent }] }); });
    expect(server.pet!.play).toBeCloseTo(30, 0);
  });

  it("오프라인이면 모아 두고 화면엔 얹어 보이다가, 다시 닿으면 보낸다(앱을 껐다 켜도 남는다)", async () => {
    resetPetGauge({ supported: true, pet: base({ at: Date.now() }), queue: [] });
    server.pet = base({ at: Date.now() });
    server.down = true;
    expect(petDo("play")).toBe(true);
    await flushPet();
    expect(petGauge().queue).toHaveLength(1);
    expect(petView(Date.now())!.play).toBeCloseTo(70, 0);
    expect(JSON.parse(localStorage.getItem("nekodesk_pet_queue")!)).toHaveLength(1);
    server.down = false;
    await flushPet();
    expect(petGauge().queue).toHaveLength(0);
    expect(server.pet!.play).toBeCloseTo(70, 0);
    expect(petView(Date.now())!.play).toBeCloseTo(70, 0);
  });

  it("옛 서버(supported false)면 아무것도 안 한다 — 부른 쪽이 예전 방식으로", async () => {
    expect(petDo("play")).toBe(false);
    await flushPet();
    expect(server.calls).toBe(0);
    expect(petView(Date.now())).toBeNull();
  });
});
