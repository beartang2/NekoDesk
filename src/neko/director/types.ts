import type { CatEmotion } from "../../agent/types";
import type { NekoActivity, NekoMood, NekoPose, NekoReaction, NekoTailSign } from "../engine/neko-engine";

/**
 * 네코 감독(P2) 타입. 설계: docs/neko-p2-director.md
 *
 * 루프 이벤트 → 신호(NekoSignal) → 세션 상태(NekoSessionState, reduceSession)
 *   → 앱 상황과 합쳐 계획(NekoPlan, deriveNeko) → 스케줄러 → 엔진
 */

/** 세션 하나의 에이전트 단계 */
export type NekoPhase = "idle" | "thinking" | "tool" | "answering" | "waiting" | "result";

/** 도구 하나를 고양이가 어떻게 흉내 내는지(표 §4) */
export interface ToolCue {
  name: string;
  activity: NekoActivity;
  /** 엔진이 스스로 끝내는 활동(발도장·간식·기지개·벽 타기) */
  oneShot: boolean;
  /** 쓰기 도구(결과 판정 'wrote') */
  writes: boolean;
}

export type ResultKind = "wrote" | "used" | "plain" | "failed" | "cancelled" | "error" | "aborted";

export interface NekoSessionState {
  phase: NekoPhase;
  /** 이 단계가 시작된 시각(ms) */
  since: number;
  /** 지금 쓰는 도구 */
  tool: ToolCue | null;
  /** 방금 끝난 도구(도구 사이 '생각' 동안 그 활동을 이어 갈지 볼 때) */
  lastTool: { cue: ToolCue; startedAt: number; endedAt: number } | null;
  wait: { kind: "confirm" | "clarify"; danger: boolean } | null;
  /** 이번 실행 요약(결과 판정용) */
  run: { startedAt: number; tools: number; wrote: boolean; errors: number; lastFailed: boolean; cancelled: boolean } | null;
  /** typed: 답을 쓰다(answering) 끝났다 — 결과 표정은 타이핑 마무리 뒤에(derive WRITE_FINISH_MS) */
  result: { kind: ResultKind; petState: CatEmotion | null; at: number; typed?: boolean } | null;
}

/** 루프 이벤트에서 고양이에게 필요한 것만 담은 신호(§3.1) */
export type NekoSignal =
  | { type: "run_start" }
  | { type: "thinking" }
  | { type: "tool_start"; tool: string; params?: Record<string, unknown> }
  | { type: "tool_end"; tool: string }
  | { type: "step_error"; tool: string; cancelled: boolean }
  | { type: "answering" }
  | { type: "wait"; kind: "confirm" | "clarify"; danger: boolean }
  | { type: "wait_end"; approved: boolean }
  | { type: "done"; petState: CatEmotion | null }
  | { type: "loop_error" }
  | { type: "abort" };

/**
 * 일회성 반응. react = 엔진 반응(꼬리 언어 묶음), tail = 꼬리 언어 하나.
 * delay: 이만큼 뒤에. gate "result": 결과 여운(0.6초)과 한 번짜리 활동이 끝난 뒤에 낸다.
 */
export type Reaction =
  | { type: "react"; kind: NekoReaction; delay?: number; gate?: "result" }
  | { type: "tail"; sign: NekoTailSign; sec: number; delay?: number; gate?: "result" };

/** 계획을 정한 층(§5.2). 디버그·테스트용이고, 스케줄러는 sleep → 다른 층(깨어남)만 본다 */
export type NekoLayer =
  | "waiting" | "meal" | "tool" | "think" | "answer" | "result" | "fed"
  | "play" | "game" | "weak" | "hungry" | "bored" | "box" | "ambient" | "sleep" | "base" | "hidden";

export interface NekoPlan {
  layer: NekoLayer;
  mood: NekoMood;
  pose: NekoPose;
  activity: NekoActivity | null;
  /** 엔진이 스스로 끝내는 활동인가 */
  oneShot: boolean;
  /** 한 번짜리를 이 층이 이어지는 동안 다시 한다(밥 먹는 중 간식, 오래 걸리는 발도장) */
  repeat: boolean;
  /** 최소 머무름을 지킬 활동인가(도구·답 쓰기) */
  dwell: boolean;
  /** 같은 활동이라도 이 값이 바뀌면 '새 일'이다(한 번짜리를 다시 할지 가를 때) */
  instance: string;
  /** 계속 유지할 꼬리(기다림 = 물음표) */
  tailHold: NekoTailSign | null;
  /** 산책 허용 */
  wander: boolean;
  /** 곁들임(docs/neko-activity-mix.md §1.13): 주 활동(없으면 기본 상태) 위에 얹을 활동. 1단계는 음악이 나올 때 music 만 */
  side: NekoActivity | null;
}

/** deriveNeko 의 입력(§5.1) */
export interface DirectorInput {
  /** 활성 세션 */
  session: NekoSessionState;
  /** 밥 주기(대화 요약) 중 */
  feeding: { since: number } | null;
  /** 밥 주기가 끝난 시각(떨기 + 행복 여운) */
  fedAt: number | null;
  /** 놀아주기 버튼 */
  playCue: { at: number; kind: "yarn" | "butterfly" } | null;
  /** 게임 호환: 게임 훅의 onEmotionChange(감정, ms) */
  game: { emotion: CatEmotion; until: number } | null;
  /** hunger = 화면에 보이는 배고픔(컨텍스트 사용량), play = 놀이 게이지 */
  needs: { hunger: number; play: number };
  /** 사용자가 마지막으로 앱을 쓴 시각 */
  lastActiveAt: number;
  /**
   * 다른 앱 따라 하기(neko/ambient.ts). at: 사용자가 글 입력 칸에 마지막으로 친 시각(졸림 시계는 이것도 본다 — 일하는
   * 동안은 안 존다. 따라 치지는 않는다), activity: 맨 앞 앱으로 고른 활동, music: 곁들임
   */
  outside: OutsideState;
  /** 네코가 채팅에 글을 남기는 중(산책 일지·브리핑·첫마디 — stores nekoWrites). 답 쓰기처럼 타이핑한다 */
  writing?: boolean;
  /** 신나서 혼자 노는 중(상자에 쏙·털실·나비) */
  /** 혼자 놀기(신남). kind 는 엔진 활동(없으면 상자) */
  box: { since: number; kind?: NekoActivity } | null;
  /**
   * 마당(화면 모드) 고양이를 메뉴로 숨겼다(neko_screen.rs). 보여 주기만 하는 활동은 하지 않는다 — 엔진도 멈춰 있다.
   * 산책·그림·기억 정리처럼 결과가 남는 일은 감독 밖이라 그대로 돈다
   */
  hidden?: boolean;
}

export interface OutsideState {
  at: number;
  /** 맨 앞 앱으로 고른 활동(음악은 여기 안 넣는다 — music 으로 곁들인다) */
  activity: NekoActivity | null;
  /** 음악 앱이 재생 중 */
  music: boolean;
}
