import { useState, useEffect, useCallback, useRef } from "react";
import { settingsApi } from "../api/tauri";

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
const SETTINGS_KEY = "cat_rpg_state"; // 앱 전체 단일 키 — 세션과 무관

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

async function persistState(state: CatRpgState): Promise<void> {
  await settingsApi.set(SETTINGS_KEY, JSON.stringify(state)).catch(() => {});
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useCatRpg() {
  const [state, setStateRaw] = useState<CatRpgState>(makeDefault);
  const stateRef = useRef(state);
  stateRef.current = state;

  const setState = useCallback((next: CatRpgState) => {
    setStateRaw(next);
    persistState(next);
  }, []);

  // 마운트 시 전역 상태 로드
  useEffect(() => {
    loadState().then((loaded) => {
      const s = loaded.feedDate !== today()
        ? { ...loaded, feedCountToday: 0, feedDate: today() }
        : loaded;
      setState(applyDecay(s, Date.now()));
    });
  }, []);

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
    });
  }, [setState]);

  const playAction = useCallback(() => {
    const s = stateRef.current;
    setState({ ...s, play: clamp(s.play + 20), lastTick: new Date().toISOString() });
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
