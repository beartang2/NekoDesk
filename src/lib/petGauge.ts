import { useSyncExternalStore } from "react";
import { syncApi, type PetAct, type PetBase } from "../api/tauri";

/**
 * 놀이 게이지를 맥·폰이 한 값으로(docs/neko-sync.md §4.7). 기기마다 따로 줄이고 저장하면 한쪽의 놀아 주기를 다른 쪽의 "시간이
 * 지나 줄어든 값"이 덮었다. 그래서 서버가 기준(play, 잰 때 at) 하나를 갖고, 기기는 행동만 보낸다. 화면 값은 기준에서 같은 식으로
 * 줄여 낸다(playAt) — 줄어든 값은 어디에도 저장하지 않는다.
 *
 * 행동은 모아(1.5초) 한 번에 보내고, 못 보내면(오프라인) localStorage 에 둔 채 다음에 다시 보낸다. 같은 id 는 서버가 한 번만
 * 적용한다. 답이 오기 전·오프라인 동안은 기준에 모아 둔 행동을 같은 식으로 얹어 보인다(applyActs — 서버 petAct 와 같은 식).
 * 옛 서버(supported false)면 이 파일은 아무것도 안 하고 useCatRpg 가 예전 방식으로 돈다.
 */
export const PLAY_PER_MIN = 0.3;
const GAIN = { play: 20, pet: 10 } as const;
const QUEUE_KEY = "nekodesk_pet_queue";
const SEND_MAX = 100, SEND_AFTER_MS = 1500;

const clamp = (v: number) => Math.max(0, Math.min(100, v));
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** 기준에서 t 까지 줄인 놀이 값 */
export const playAt = (p: { play: number; at: number }, t: number): number =>
  clamp(p.play - (PLAY_PER_MIN * Math.max(0, t - p.at)) / 60_000);

/** 기준에 행동을 시각 순으로 얹는다: 기준보다 나중이면 그때까지 줄인 뒤 더하고, 이르면 더하기만(서버와 같은 식) */
export function applyActs(base: PetBase, acts: PetAct[]): PetBase {
  const p = { ...base };
  for (const a of [...acts].sort((x, y) => x.at - y.at)) {
    if (a.at > p.at) { p.play = playAt(p, a.at); p.at = a.at; }
    if (a.kind === "feed") {
      const d = dayOf(a.at);
      if (d > p.day) { p.day = d; p.feeds = 0; }
      if (d === p.day) p.feeds++;
    } else p.play = clamp(p.play + (a.kind === "reward" ? Math.max(0, Math.min(20, a.n ?? 0)) : GAIN[a.kind]));
  }
  return p;
}

interface Gauge { supported: boolean; pet: PetBase | null; queue: PetAct[] }
function loadQueue(): PetAct[] {
  try { const q = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]") as PetAct[]; return Array.isArray(q) ? q : []; } catch { return []; }
}
let gauge: Gauge = { supported: false, pet: null, queue: loadQueue() };
/** 서버에 기준이 없을 때 보낼 이 기기 값(예전 cat_rpg_state) */
let seed: { play: number; at: number } | null = null;
let busy = false, timer: ReturnType<typeof setTimeout> | undefined;
const subs = new Set<() => void>();
function set(next: Partial<Gauge>) {
  gauge = { ...gauge, ...next };
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(gauge.queue)); } catch { /* 저장 공간 없음 — 이번 실행 동안만 */ }
  subs.forEach((f) => f());
}

export const usePetGauge = (): Gauge =>
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => gauge);
export const petGauge = (): Gauge => gauge;
export function setPetSeed(v: { play: number; at: number }): void { seed = v; }

/** 지금 보일 값: 기준 + 아직 안 보낸 행동. 서버를 안 쓰거나 기준이 아직 없으면 null(예전 값 그대로) */
export function petView(now: number): { play: number; feeds: number } | null {
  if (!gauge.supported || !gauge.pet) return null;
  const p = applyActs(gauge.pet, gauge.queue);
  return { play: playAt(p, now), feeds: p.day === dayOf(now) ? p.feeds : 0 };
}

/** 모아 둔 행동을 보낸다. 서버에 기준이 없으면 이 기기 값으로 시작하게 같이 보낸다 */
export async function flushPet(): Promise<void> {
  clearTimeout(timer);
  // 서버에 기준이 없는데 이 기기 값도 아직 모르면(켜는 중) 기다린다 — 그냥 보내면 서버가 100 에서 시작한다
  if (busy || !gauge.supported || (!gauge.pet && !seed) || (!gauge.queue.length && gauge.pet)) return;
  busy = true;
  const sending = gauge.queue.slice(0, SEND_MAX);
  try {
    const pet = await syncApi.petAct(sending, gauge.pet ? null : seed);
    const sent = new Set(sending.map((a) => a.id));
    set({ pet, queue: gauge.queue.filter((a) => !sent.has(a.id)) });
  } catch { /* 오프라인 등: 그대로 두고 다음에 */ } finally {
    busy = false;
  }
  if (gauge.queue.length > 0 && gauge.queue.length !== sending.length) void flushPet(); // 남은 것(100개 넘게 모였거나 보내는 사이 생긴 것)
}

/** 동기화가 받아 둔 기준을 읽는다(켤 때·sync-changed 'pet'). 보낼 것이 있으면 보낸다 */
export async function refreshPet(): Promise<void> {
  const got = await syncApi.petShared().catch(() => null);
  if (!got) return;
  set({ supported: got.supported, pet: got.pet });
  void flushPet();
}

/** 행동 하나(놀아 주기·쓰다듬기·보상·밥). 서버를 쓸 때만 true — false 면 부른 쪽이 예전 방식으로 한다 */
export function petDo(kind: PetAct["kind"], n?: number): boolean {
  if (!gauge.supported) return false;
  set({ queue: [...gauge.queue, { kind, at: Date.now(), id: crypto.randomUUID(), ...(n === undefined ? {} : { n }) }] });
  clearTimeout(timer);
  timer = setTimeout(() => void flushPet(), SEND_AFTER_MS);
  return true;
}

/** 시험용 */
export function resetPetGauge(next: Partial<Gauge> = {}): void {
  clearTimeout(timer);
  busy = false; seed = null;
  gauge = { supported: false, pet: null, queue: [], ...next };
}
