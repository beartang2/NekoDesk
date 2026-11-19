import { useState, useEffect, useCallback, useRef } from "react";
import { settingsApi } from "../api/tauri";
import { useNekoNeeds } from "../neko/director/needsStore";
import { appEvents } from "../lib/events";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CatRpgState {
  birthday: string;       // "YYYY-MM-DD"
  hunger: number;         // 0–100
  play: number;           // 0–100
  lastTick: string;       // ISO timestamp
  feedCountToday: number;
  feedDate: string;       // "YYYY-MM-DD"
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TICK_MS = 60_000;          // 1분마다 틱
const HUNGER_PER_MIN = 0.5;      // -5 / 10분
const PLAY_PER_MIN = 0.3;        // -3 / 10분
const MAX_OFFLINE_MIN = 120;     // 오프라인 최대 반영 2시간
// compact는 컨텍스트가 자연스러운 제한 — 하루 제한 없음
const MAX_FEED_PER_DAY = 999;
// 앱 전체 단일 키 — 세션과 무관. 맥·폰이 같이 쓴다(동기화 설정 키, 사용자: 밥·놀이도 한 고양이로). 생일은 기기마다
// 처음 켠 날이 달라 가장 이른 날로 따로 맞춘다(neko_needs 의 born — 나중에 쓴 기기가 이기는 이 키로는 늦은 날이 이길 수 있다)
const SETTINGS_KEY = "cat_rpg_state";
/**
 * 1분 틱마다 쓰면 15초 동기화마다 서버 기록이 쌓인다. 밥·놀이가 이만큼 바뀌었거나 SAVE_EVERY_MS 가 지났을 때,
 * 또는 밥 주기·놀아 주기 때만 쓴다. 저장 값은 그 값을 잰 때(lastTick)와 같이 있어 읽는 쪽이 지난 만큼 줄인다
 */
const SAVE_DELTA = 3;
const SAVE_EVERY_MS = 10 * 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

function applyDecay(state: CatRpgState, nowMs: number): CatRpgState {
  const elapsedMin = Math.min(
    (nowMs - new Date(state.lastTick).getTime()) / 60_000,
    MAX_OFFLINE_MIN
  );
  return {
    ...state,
    hunger: clamp(state.hunger - HUNGER_PER_MIN * elapsedMin),
    play: clamp(state.play - PLAY_PER_MIN * elapsedMin),
    lastTick: new Date(nowMs).toISOString(),
  };
}

function makeDefault(): CatRpgState {
  const now = new Date().toISOString();
  return {
    birthday: today(),
    hunger: 100,
    play: 100,
    lastTick: now,
    feedCountToday: 0,
    feedDate: today(),
  };
}

async function loadState(): Promise<CatRpgState> {
  try {
    const raw = await settingsApi.get(SETTINGS_KEY);
    if (!raw) return makeDefault();
    return JSON.parse(raw) as CatRpgState;
  } catch {
    return makeDefault();
  }
}

/** 마지막으로 저장한(또는 다른 기기에서 받아 온) 값 */
let saved: CatRpgState | null = null;
const tickOf = (s: CatRpgState) => new Date(s.lastTick).getTime() || 0;

function persistState(state: CatRpgState, force = false): void {
  if (!force && saved && tickOf(state) - tickOf(saved) < SAVE_EVERY_MS
    && Math.abs(state.hunger - saved.hunger) < SAVE_DELTA && Math.abs(state.play - saved.play) < SAVE_DELTA
    && state.birthday === saved.birthday && state.feedCountToday === saved.feedCountToday) return;
  saved = state;
  void settingsApi.set(SETTINGS_KEY, JSON.stringify(state)).catch(() => {});
}

/**
 * 다른 기기가 쓴 값: 내가 마지막으로 쓴 것보다 나중에 잰 것이면 그때부터 지난 만큼 줄여 돌려준다. 아니면 null.
 * 생일은 더 이른 쪽을 남긴다
 */
export function newerRemote(remote: CatRpgState | null, mine: CatRpgState, nowMs: number): CatRpgState | null {
  if (!remote || !Number.isFinite(remote.hunger) || !Number.isFinite(remote.play) || !(tickOf(remote) > tickOf(saved ?? mine))) return null;
  const birthday = remote.birthday && remote.birthday < mine.birthday ? remote.birthday : mine.birthday;
  return applyDecay({ ...remote, birthday }, nowMs);
}

/** 시험용 */
export function resetRpgSync(): void { saved = null; }

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useCatRpg() {
  const [state, setStateRaw] = useState<CatRpgState>(makeDefault);
  const stateRef = useRef(state);
  stateRef.current = state;

  const setState = useCallback((next: CatRpgState, force = false) => {
    setStateRaw(next);
    persistState(next, force);
  }, []);

  // 마운트 시 전역 상태 로드
  useEffect(() => {
    loadState().then((loaded) => {
      const s = loaded.feedDate !== today()
        ? { ...loaded, feedCountToday: 0, feedDate: today() }
        : loaded;
      setState(applyDecay(s, Date.now()), true);
    });
    // 다른 기기에서 밥을 주거나 놀아 줬다(동기화)
    return appEvents.on("syncChanged", ({ colls }) => {
      if (!colls.includes("setting")) return;
      void loadState().then((remote) => {
        const next = newerRemote(remote, stateRef.current, Date.now());
        if (!next) return;
        saved = remote;
        setStateRaw(next);
      });
    });
  }, []);

  // 생일(DAY 셈)은 맥·폰이 같이: 가장 이른 날로 맞춘다. 다른 기기가 더 이른 날을 알면 그걸 따르고, 내가 더 이르면 알린다
  const born = useNekoNeeds((s) => s.born);
  useEffect(() => {
    const b = state.birthday;
    if (born && born < b) setState({ ...stateRef.current, birthday: born });
    else if (born !== b) useNekoNeeds.getState().setBorn(b);
  }, [born, state.birthday, setState]);

  // 1분 틱
  useEffect(() => {
    const id = setInterval(() => {
      setState(applyDecay(stateRef.current, Date.now()));
    }, TICK_MS);
    return () => clearInterval(id);
  }, [setState]);

  // 파생값
  const dayCount = Math.max(
    1,
    Math.floor((Date.now() - new Date(state.birthday).getTime()) / 86_400_000) + 1
  );
  const canFeed = true; // compact는 언제든 가능 — 컨텍스트가 자연스러운 제한

  // ── Actions ──────────────────────────────────────────────────────────────

  const feed = useCallback(() => {
    const s = stateRef.current;
    setState({
      ...s,
      hunger: clamp(s.hunger + 60),   // compact = 풀 식사 (기존 +40 → +60)
      feedCountToday: s.feedCountToday + 1,
      feedDate: today(),
      lastTick: new Date().toISOString(),
    }, true);
  }, [setState]);

  const playAction = useCallback(() => {
    const s = stateRef.current;
    setState({ ...s, play: clamp(s.play + 20), lastTick: new Date().toISOString() }, true);
  }, [setState]);

  const pet = useCallback(() => {
    const s = stateRef.current;
    setState({ ...s, play: clamp(s.play + 10) });
  }, [setState]);

  // 에이전트 완료, 메모/할 일 추가 등 간접 보상
  const reward = useCallback((amount: number) => {
    const s = stateRef.current;
    setState({ ...s, play: clamp(s.play + amount) });
  }, [setState]);

  // LLM 요청 1회 → hunger -3 (고양이가 열심히 일한 대가)
  const consume = useCallback(() => {
    const s = stateRef.current;
    setState({ ...s, hunger: clamp(s.hunger - 3) });
  }, [setState]);

  return { state, dayCount, canFeed, feed, playAction, pet, reward, consume };
}
