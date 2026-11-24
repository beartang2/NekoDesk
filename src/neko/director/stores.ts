import { create } from "zustand";
import type { CatEmotion } from "../../agent/types";
import type { NekoActivity } from "../engine/neko-engine";
import { IDLE_SESSION, reduceSession } from "./session";
import type { NekoSessionState, NekoSignal, OutsideState, PlayKind, Reaction } from "./types";

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
  playCue: { at: number; kind: PlayKind } | null;
  game: { emotion: CatEmotion; until: number } | null;
  lastActiveAt: number;
  /** 쓰다듬은 횟수(상자에서 나오기 셈) */
  pets: number;
  /** wake=false 면 깨우지 않는다(졸 때 도는 기억 정리 — 앱을 쓰는 중으로 치지 않는다) */
  setFeeding: (on: boolean, wake?: boolean) => void;
  /** 놀아주기: 종류가 없으면 털실·나비를 번갈아(놀아주기 버튼). 던진 장난감 쫓기·낚싯대는 무대에서 엔진이 알린다 */
  play: (kind?: PlayKind) => void;
  /** 게임 호환: 게임 훅의 onEmotionChange(감정, ms) 를 그대로 받는다 */
  setGameEmotion: (emotion: CatEmotion, ms?: number) => void;
  markActive: () => void;
  /**
   * 산책 중인 네코를 부른 때(채팅 보내기 — 지도·자리 누르기·부르기 버튼은 0.1.24 에 뺐다). 이때만 서둘러 돌아온다(App, walkWatch).
   * 그 밖에 앱을 만지는 건(lastActiveAt) 졸음 타이머에만 쓰고 산책을 끊지 않는다
   */
  calledAt: number;
  callHome: () => void;
  notePet: () => void;
  /** 다른 앱 따라 하기(neko/ambient.ts). '앱을 쓰는 중'(lastActiveAt)은 건드리지 않는다 */
  outside: OutsideState;
  setOutside: (o: OutsideState) => void;
  /** 마당 고양이를 메뉴로 숨겼다(Rust neko-screen-hidden). 이 앱이 맨 앞으로 오면 풀린다 */
  screenHidden: boolean;
  setScreenHidden: (on: boolean) => void;
  /** 채팅에 글을 남기는 일이 몇 개 도는가(nekoWrites). 0 보다 크면 감독이 타이핑한다 */
  writing: number;
  /** 네코가 직접 고른 활동(neko.act). 감독이 until 까지 한다 */
  /** 네코가 직접 고른 활동(neko.act). kind null = 심부름(다른 장소로 가기·선물 옮기기) 동안 아무 활동 없이 기다림(neko/nekoErrand) */
  chosen: { kind: NekoActivity | null; since: number; until: number } | null;
  choose: (kind: NekoActivity | null, ms: number) => void;
}

export const useNekoApp = create<NekoAppStore>((set, get) => ({
  feeding: null,
  fedAt: null,
  playCue: null,
  game: null,
  lastActiveAt: performance.now(),
  pets: 0,
  outside: { at: -Infinity, activity: null, music: false },
  screenHidden: false,
  writing: 0,
  chosen: null,
  choose: (kind, ms) => { const now = performance.now(); set({ chosen: { kind, since: now, until: now + ms } }); },
  setScreenHidden: (on) => { if (get().screenHidden !== on) set({ screenHidden: on }); },
  setOutside: (o) => {
    const cur = get().outside;
    if (cur.at !== o.at || cur.activity !== o.activity || cur.music !== o.music) set({ outside: o });
  },
  setFeeding: (on, wake = true) => {
    const now = performance.now();
    const cur = get().feeding;
    if (on && !cur) set(wake ? { feeding: { since: now }, lastActiveAt: now } : { feeding: { since: now } });
    else if (!on && cur) set({ feeding: null, fedAt: now });
  },
  play: (kind) => {
    const now = performance.now();
    const prev = get().playCue?.kind;
    set({ playCue: { at: now, kind: kind ?? (prev === "yarn" ? "butterfly" : "yarn") }, lastActiveAt: now });
  },
  setGameEmotion: (emotion, ms = 2500) => {
    const now = performance.now();
    set({ game: emotion === "idle" ? null : { emotion, until: now + ms } });
  },
  markActive: () => set({ lastActiveAt: performance.now() }),
  calledAt: 0,
  callHome: () => { const now = performance.now(); set({ calledAt: now, lastActiveAt: now }); },
  notePet: () => set((s) => ({ pets: s.pets + 1, lastActiveAt: performance.now() })),
}));

/** 글이 바로 생겨도(첫마디 말풍선) 이만큼은 친다 — 손을 올리자마자 떼지 않게. 그 뒤 마무리는 감독(WRITE_FINISH_MS) */
export const WRITE_MIN_MS = 2000;

/**
 * 네코가 채팅에 글을 남긴다(산책 일지·브리핑·첫마디, 0.1.28 사용자: 네코 타이핑은 이때만). work 가 끝날 때까지(적어도
 * WRITE_MIN_MS) 감독이 답 쓰기처럼 타이핑하고, 끝나면 답처럼 조금 더 치다 손을 쉰다. work 의 결과를 그대로 돌려준다
 */
export async function nekoWrites<T = void>(work: Promise<T> = Promise.resolve() as Promise<T>): Promise<T> {
  const app = useNekoApp;
  app.setState({ writing: app.getState().writing + 1 });
  try {
    const [r] = await Promise.all([work, new Promise((ok) => setTimeout(ok, WRITE_MIN_MS))]);
    return r;
  } finally {
    app.setState({ writing: Math.max(0, app.getState().writing - 1) });
  }
}
