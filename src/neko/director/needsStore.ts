import { create } from "zustand";
import { settingsApi } from "../../api/tauri";
import { appEvents } from "../../lib/events";
import { following, onLead } from "../lead";
import {
  add, applyFill, decay, fillsOf, FILL_MINUTES, LONELY_MS, PET_AFFECTION, PET_CAP, PET_WINDOW_MS, START,
  type DecayHow, type Needs,
} from "./needs";

/**
 * 숨은 게이지 저장·갱신(docs/neko-activity-mix.md §2.6). 메인 창에서만 돈다(감독이 메인 창에 있다).
 *
 * 설정 키 neko_needs 에 { ...게이지, at, born }. 켤 때 at 부터 꺼져 있던 시간만큼 'off' 로 줄이고(기운은 찬다),
 * 감독이 1분마다 tick 으로 저절로 줄고 하던 활동만큼 채운다. 쓰다듬기·보내기·밥·산책 귀가는 사건으로 바로 더한다.
 *
 * 맥·폰이 같이 쓴다(동기화 설정 키, 사용자: 밥·놀이만 기기마다 따로 — 그건 useCatRpg 의 cat_rpg_state). 기록 하나가
 * 15초 동기화마다 서버에 쌓이니 자주 쓰지 않는다: 어느 게이지든 SAVE_DELTA 넘게 바뀌었거나 SAVE_EVERY_MS 가 지났을 때,
 * 또는 사건(산책 귀가·개발 화면)일 때만. 다른 기기 값이 오면(syncChanged setting) 그 값을 잰 때(at)부터 지난 만큼
 * 줄여 읽는다. born = 고양이 생일(YYYY-MM-DD, DAY 셈) — 기기마다 처음 켠 날이 달라 가장 이른 날로 맞춘다
 *
 * 계산은 앞 기기(가장 최근에 사용자가 쓴 기기, neko/presence)만 한다(0.1.32): 두 기기가 각자 줄이고 채워 번갈아 덮어쓰면 값이
 * 왔다 갔다 했다. 뒤에 있는 기기는 받은 값에서 저절로 줄기만 하고(제 활동으로 채우지 않는다) 적지 않는다. 이 기기를 쓰기 시작해
 * 앞이 되면 지금 값(받아 온 것)에서 이어 계산하고 바로 한 번 적는다.
 */

const KEY = "neko_needs";
const SAVE_DELTA = 3;
const SAVE_EVERY_MS = 10 * 60_000;

interface NeedsStore {
  needs: Needs;
  loaded: boolean;
  /** 마지막으로 대화(보냄)·쓰다듬기를 한 때(epoch ms). LONELY_MS 넘게 없으면 애정이 준다 */
  touchedAt: number;
  pet: { from: number; gained: number };
  load: () => Promise<void>;
  /** 1분 갱신: 저절로 + 하던 활동(주·곁들임)만큼 채우고 저장 */
  tick: (ms: number, how: DecayHow, doing: (string | null)[]) => void;
  /** 한 번짜리(간식·기지개·벽 타기…)가 끝났다: 채움을 한 번에 */
  oneShotDone: (key: string) => void;
  petted: () => void;
  /** 사용자가 메시지를 보냈다 */
  messaged: () => void;
  /** 밥(대화 요약)을 다 먹었다 */
  fed: () => void;
  /** 산책에서 돌아왔다 */
  walked: () => void;
  /** 개발 빌드 게이지 화면 */
  set: (n: Partial<Needs>) => void;
  /** 고양이 생일(가장 이른 날). 모르면 null — useCatRpg 가 맞춘다 */
  born: string | null;
  /** 생일을 맞춘다: 지금 것보다 이르면 바꾸고 저장 */
  setBorn: (day: string) => void;
  /** 다른 기기가 쓴 값을 읽어 온다(그쪽이 더 나중에 잰 것이면) */
  pull: () => Promise<void>;
}

/** 마지막으로 저장한(또는 받아 온) 값과 잰 때 — 다음 저장을 미룰지, 받은 값이 더 새것인지 본다 */
let saved: { needs: Needs; at: number } | null = null;
let watchingLead = false;
const earlier = (a: string | null, b: string | null) => (!a ? b : !b ? a : a < b ? a : b);

type Stored = Partial<Needs> & { at?: number; born?: string };
function parse(raw: string | null): Stored | null {
  try {
    const p = raw ? (JSON.parse(raw) as Stored) : null;
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}
function readNeeds(p: Stored | null): Needs {
  const needs = { ...START };
  if (p) for (const k of Object.keys(START) as (keyof Needs)[]) if (Number.isFinite(p[k])) needs[k] = p[k]!;
  return needs;
}

function persist(n: Needs, born: string | null, force = false) {
  if (following()) return; // 앞 기기가 적는다
  const now = Date.now();
  if (!force && saved && now - saved.at < SAVE_EVERY_MS && !(Object.keys(n) as (keyof Needs)[]).some((k) => Math.abs(n[k] - saved!.needs[k]) >= SAVE_DELTA)) return;
  saved = { needs: { ...n }, at: now };
  void settingsApi.set(KEY, JSON.stringify({ ...n, at: now, ...(born ? { born } : {}) })).catch(() => {});
}

export const useNekoNeeds = create<NeedsStore>((set, get) => ({
  needs: { ...START },
  loaded: false,
  touchedAt: Date.now(),
  pet: { from: 0, gained: 0 },
  born: null,
  async load() {
    if (get().loaded) return;
    const p = parse(await settingsApi.get(KEY).catch(() => null));
    let needs = readNeeds(p);
    if (p && Number.isFinite(p.at)) needs = decay(needs, Date.now() - p.at!, "off");
    const born = typeof p?.born === "string" ? p.born : null;
    set({ needs, loaded: true, born: earlier(get().born, born) });
    // 저장된 값이 있으면 켰다고 다시 적지 않는다 — 뒤에 있는 기기가 켜지며 낡은 값을 "지금 잰 값"으로 올려 앞 기기 것을 덮었다
    if (p && Number.isFinite(p.at)) saved = { needs: readNeeds(p), at: p.at! };
    else persist(needs, get().born, true);
    // 이 기기가 앞이 됐다(쓰기 시작): 이어 계산하고 바로 한 번 적는다
    if (!watchingLead) {
      watchingLead = true;
      let wasFollowing = following();
      onLead(() => {
        const now = following();
        if (wasFollowing && !now && get().loaded) persist(get().needs, get().born, true);
        wasFollowing = now;
      });
    }
    // 다른 기기에서 바뀐 값(동기화)
    appEvents.on("syncChanged", ({ colls }) => { if (colls.includes("setting")) void get().pull(); });
  },
  async pull() {
    if (!get().loaded) return;
    const p = parse(await settingsApi.get(KEY).catch(() => null));
    if (!p) return;
    const born = earlier(get().born, typeof p.born === "string" ? p.born : null);
    if (born !== get().born) set({ born });
    // 내가 쓴 것보다 나중에 잰 값만. 그 사이 지난 만큼은 깨어 있던 것으로 줄인다(잰 기기에선 쓰는 중이었다)
    if (!Number.isFinite(p.at) || (saved && p.at! <= saved.at)) return;
    const remote = readNeeds(p);
    saved = { needs: remote, at: p.at! };
    set({ needs: decay(remote, Date.now() - p.at!, "awake") });
  },
  setBorn(day) {
    const born = earlier(get().born, day);
    if (born === get().born) return;
    set({ born });
    if (get().loaded) persist(get().needs, born, true);
  },
  tick(ms, how, doing) {
    const s = get();
    let n = decay(s.needs, ms, how, Date.now() - s.touchedAt > LONELY_MS);
    // 뒤에 있는 기기는 제 활동으로 채우지 않는다(앞 기기 값을 따른다)
    if (!following()) for (const k of doing) n = applyFill(n, fillsOf(k), ms / 60_000);
    set({ needs: n });
    if (s.loaded) persist(n, s.born);
  },
  oneShotDone(key) {
    set({ needs: applyFill(get().needs, fillsOf(key), FILL_MINUTES) });
  },
  petted() {
    const now = Date.now(), p = get().pet.from && now - get().pet.from < PET_WINDOW_MS ? get().pet : { from: now, gained: 0 };
    const gain = Math.min(PET_AFFECTION, PET_CAP - p.gained);
    set({ touchedAt: now, pet: { from: p.from, gained: p.gained + gain }, needs: add(get().needs, { affection: gain }) });
  },
  messaged() {
    set({ touchedAt: Date.now(), needs: add(get().needs, { affection: 10 }) });
  },
  fed() {
    set({ needs: add(get().needs, { clean: -10 }) });
  },
  walked() {
    const n = add(get().needs, { clean: -20, energy: -15 });
    set({ needs: { ...n, curiosity: 100 } });
    if (get().loaded) persist(get().needs, get().born, true);
  },
  set(d) {
    const n = { ...get().needs };
    for (const [k, v] of Object.entries(d) as [keyof Needs, number][]) n[k] = Math.max(0, Math.min(100, v));
    set({ needs: n });
    if (get().loaded) persist(n, get().born, true);
  },
}));

/** 시험용: 모듈 상태를 비운다 */
export function resetNeedsSync(): void { saved = null; }
