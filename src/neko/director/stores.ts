import { create } from "zustand";
import type { CatEmotion } from "../../agent/types";
import { IDLE_SESSION, reduceSession } from "./session";
import type { NekoSessionState, NekoSignal, Reaction } from "./types";

/**
 * 감독 입력을 담는 스토어 두 개(설계 docs/neko-p2-director.md §2).
 * React 밖에서도 쓰고(에이전트 풀·App 콜백), useNekoDirector 는 selector 훅 대신 subscribe 로만 본다.
 * 그래서 신호·입력이 바뀌어도 App 은 다시 그려지지 않는다.
 */

type ReactionListener = (sessionId: string, reactions: Reaction[], signal: NekoSignal) => void;
const reactionListeners = new Set<ReactionListener>();

interface NekoSessionsStore {
  sessions: Record<string, NekoSessionState>;
  /** 신호 하나를 세션에 넣는다. 그 신호로 생긴 반응은 onNekoReactions 구독자에게 */
  dispatch: (sessionId: string, signal: NekoSignal) => void;
  get: (sessionId: string) => NekoSessionState;
}

export const useNekoSessions = create<NekoSessionsStore>((set, get) => ({
  sessions: {},
  dispatch: (sessionId, signal) => {
    const prev = get().sessions[sessionId] ?? IDLE_SESSION;
    const { state, reactions } = reduceSession(prev, signal, performance.now());
    if (state !== prev) set((s) => ({ sessions: { ...s.sessions, [sessionId]: state } }));
    reactionListeners.forEach((fn) => fn(sessionId, reactions, signal));
  },
  get: (sessionId) => get().sessions[sessionId] ?? IDLE_SESSION,
}));

/** 신호마다(반응이 없어도) 불린다: 반응 재생, 뒤 세션이 끝났을 때 인사 등 */
export function onNekoSignal(fn: ReactionListener): () => void {
  reactionListeners.add(fn);
  return () => reactionListeners.delete(fn);
}

interface NekoAppStore {
  feeding: { since: number } | null;
  fedAt: number | null;
  playCue: { at: number; kind: "yarn" | "butterfly" } | null;
  game: { emotion: CatEmotion; until: number } | null;
  lastActiveAt: number;
  /** 쓰다듬은 횟수(상자에서 나오기 셈) */
  pets: number;
  setFeeding: (on: boolean) => void;
  /** 놀아주기: 털실·나비를 번갈아 */
  play: () => void;
  /** 게임 호환: 게임 훅의 onEmotionChange(감정, ms) 를 그대로 받는다 */
  setGameEmotion: (emotion: CatEmotion, ms?: number) => void;
  markActive: () => void;
  notePet: () => void;
}

export const useNekoApp = create<NekoAppStore>((set, get) => ({
  feeding: null,
  fedAt: null,
  playCue: null,
  game: null,
  lastActiveAt: performance.now(),
  pets: 0,
  setFeeding: (on) => {
    const now = performance.now();
    const cur = get().feeding;
    if (on && !cur) set({ feeding: { since: now }, lastActiveAt: now });
    else if (!on && cur) set({ feeding: null, fedAt: now });
  },
  play: () => {
    const now = performance.now();
    const prev = get().playCue?.kind;
    set({ playCue: { at: now, kind: prev === "yarn" ? "butterfly" : "yarn" }, lastActiveAt: now });
  },
  setGameEmotion: (emotion, ms = 2500) => {
    const now = performance.now();
    set({ game: emotion === "idle" ? null : { emotion, until: now + ms } });
  },
  markActive: () => set({ lastActiveAt: performance.now() }),
  notePet: () => set((s) => ({ pets: s.pets + 1, lastActiveAt: performance.now() })),
}));
