import { create } from "zustand";
import { settingsApi } from "../../api/tauri";
import {
  add, applyFill, decay, fillsOf, FILL_MINUTES, LONELY_MS, PET_AFFECTION, PET_CAP, PET_WINDOW_MS, START,
  type DecayHow, type Needs,
} from "./needs";

/**
 * 숨은 게이지 저장·갱신(docs/neko-activity-mix.md §2.6). 메인 창에서만 돈다(감독이 메인 창에 있다).
 *
 * 설정 키 neko_needs 에 { ...게이지, at }. 켤 때 at 부터 꺼져 있던 시간만큼 'off' 로 줄이고(기운은 찬다),
 * 감독이 1분마다 tick 으로 저절로 줄고 하던 활동만큼 채운다. 쓰다듬기·보내기·밥·산책 귀가는 사건으로 바로 더한다.
 */

const KEY = "neko_needs";

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
}

function persist(n: Needs) {
  void settingsApi.set(KEY, JSON.stringify({ ...n, at: Date.now() })).catch(() => {});
}

export const useNekoNeeds = create<NeedsStore>((set, get) => ({
  needs: { ...START },
  loaded: false,
  touchedAt: Date.now(),
  pet: { from: 0, gained: 0 },
  async load() {
    if (get().loaded) return;
    const raw = await settingsApi.get(KEY).catch(() => null);
    let needs = { ...START };
    try {
      const p = raw ? (JSON.parse(raw) as Partial<Needs> & { at?: number }) : null;
      if (p) {
        for (const k of Object.keys(START) as (keyof Needs)[]) if (Number.isFinite(p[k])) needs[k] = p[k]!;
        if (Number.isFinite(p.at)) needs = decay(needs, Date.now() - p.at!, "off");
      }
    } catch { /* 망가진 값이면 처음부터 */ }
    set({ needs, loaded: true });
    persist(needs);
  },
  tick(ms, how, doing) {
    const s = get();
    let n = decay(s.needs, ms, how, Date.now() - s.touchedAt > LONELY_MS);
    for (const k of doing) n = applyFill(n, fillsOf(k), ms / 60_000);
    set({ needs: n });
    if (s.loaded) persist(n);
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
    if (get().loaded) persist(get().needs);
  },
  set(d) {
    const n = { ...get().needs };
    for (const [k, v] of Object.entries(d) as [keyof Needs, number][]) n[k] = Math.max(0, Math.min(100, v));
    set({ needs: n });
    if (get().loaded) persist(n);
  },
}));
