import { create } from "zustand";
import type { CatEmotion } from "../../agent/types";
import { IDLE_SESSION, reduceSession } from "./session";
import type { NekoSessionState, NekoSignal, OutsideState, Reaction } from "./types";

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
  /** wake=false 면 깨우지 않는다(졸 때 도는 기억 정리 — 앱을 쓰는 중으로 치지 않는다) */
  setFeeding: (on: boolean, wake?: boolean) => void;
  /** 놀아주기: 털실·나비를 번갈아 */
  play: () => void;
  /** 게임 호환: 게임 훅의 onEmotionChange(감정, ms) 를 그대로 받는다 */
  setGameEmotion: (emotion: CatEmotion, ms?: number) => void;
  markActive: () => void;
  notePet: () => void;
  /** 다른 앱 따라 하기(neko/ambient.ts). '앱을 쓰는 중'(lastActiveAt)은 건드리지 않는다 */
  outside: OutsideState;
  setOutside: (o: OutsideState) => void;
  /** 마당 고양이를 메뉴로 숨겼다(Rust neko-screen-hidden). 이 앱이 맨 앞으로 오면 풀린다 */
  screenHidden: boolean;
  setScreenHidden: (on: boolean) => void;
}

export const useNekoApp = create<NekoAppStore>((set, get) => ({
  feeding: null,
  fedAt: null,
  playCue: null,
  game: null,
  lastActiveAt: performance.now(),
  pets: 0,
  outside: { typing: false, at: -Infinity, activity: null },
  screenHidden: false,
  setScreenHidden: (on) => { if (get().screenHidden !== on) set({ screenHidden: on }); },
  setOutside: (o) => {
    const cur = get().outside;
    if (cur.typing !== o.typing || cur.at !== o.at || cur.activity !== o.activity) set({ outside: o });
  },
  setFeeding: (on, wake = true) => {
    const now = performance.now();
    const cur = get().feeding;
    if (on && !cur) set(wake ? { feeding: { since: now }, lastActiveAt: now } : { feeding: { since: now } });
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
