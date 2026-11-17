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
  result: { kind: ResultKind; petState: CatEmotion | null; at: number } | null;
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
  | "play" | "game" | "weak" | "hungry" | "bored" | "box" | "sleep" | "base";

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
  /** 신나서 상자에 들어간 중 */
  box: { since: number } | null;
}
