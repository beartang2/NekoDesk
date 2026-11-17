import type { CatEmotion } from "../../agent/types";
import type { NekoMood, NekoPose } from "../engine/neko-engine";
import { toolCue } from "./toolActivity";
import type { NekoSessionState, NekoSignal, Reaction, ResultKind } from "./types";

/**
 * 세션 상태 reducer(설계 docs/neko-p2-director.md §3). 순수 함수: 신호 하나를 받아 다음 상태와,
 * 그 신호로 생긴 일회성 반응을 돌려준다. 시간은 인자로 받는다(테스트에서 가짜 시계).
 */

export const IDLE_SESSION: NekoSessionState = {
  phase: "idle", since: 0, tool: null, lastTool: null, wait: null, run: null, result: null,
};

/** 사용자가 확인 창에서 실행을 취소했을 때 agent-loop 가 남기는 말 */
export const CANCEL_MESSAGE = "사용자가 실행을 취소했습니다";

export interface ReduceOut {
  state: NekoSessionState;
  reactions: Reaction[];
}

const freshRun = (now: number) => ({ startedAt: now, tools: 0, wrote: false, errors: 0, lastFailed: false, cancelled: false });

export function reduceSession(s: NekoSessionState, sig: NekoSignal, now: number): ReduceOut {
  const toThinking = (): NekoSessionState => ({
    ...s,
    phase: "thinking",
    since: s.phase === "thinking" ? s.since : now,
    tool: null,
    lastTool: s.tool ? { cue: s.tool, startedAt: s.since, endedAt: now } : s.lastTool,
    wait: null,
  });

  switch (sig.type) {
    case "run_start":
      return { state: { ...IDLE_SESSION, phase: "thinking", since: now, run: freshRun(now) }, reactions: [] };

    case "thinking":
      if (s.phase === "thinking") return { state: s, reactions: [] };
      return { state: toThinking(), reactions: [] };

    case "tool_start":
      return {
        state: { ...s, phase: "tool", since: now, tool: toolCue(sig.tool, sig.params), wait: null, run: s.run ?? freshRun(now) },
        reactions: [],
      };

    case "tool_end": {
      const run = s.run ?? freshRun(now);
      const writes = (s.tool?.name === sig.tool ? s.tool.writes : toolCue(sig.tool).writes);
      return {
        state: { ...s, run: { ...run, tools: run.tools + 1, wrote: run.wrote || writes, lastFailed: false } },
        reactions: [],
      };
    }

    case "step_error": {
      const run = s.run ?? freshRun(now);
      const state: NekoSessionState = {
        ...s,
        run: { ...run, tools: run.tools + 1, errors: run.errors + 1, lastFailed: true, cancelled: run.cancelled || sig.cancelled },
      };
      // 취소는 '내리기'로 결과에서 말한다. 그 밖의 오류는 그 자리에서 탁탁(하던 활동은 이어 감)
      return { state, reactions: sig.cancelled ? [] : [{ type: "react", kind: "sulk" }] };
    }

    case "answering":
      if (s.phase === "answering") return { state: s, reactions: [] };
      return {
        state: { ...s, phase: "answering", since: now, tool: null, lastTool: s.tool ? { cue: s.tool, startedAt: s.since, endedAt: now } : s.lastTool, wait: null },
        reactions: [],
      };

    case "wait":
      // 멈춰서 기다렸으니 그 앞 도구의 활동은 잊는다(승인 뒤 엉뚱하게 이어 가지 않게)
      return {
        state: { ...s, phase: "waiting", since: now, tool: null, lastTool: null, wait: { kind: sig.kind, danger: sig.danger } },
        reactions: sig.danger ? [{ type: "react", kind: "startle" }] : [],
      };

    case "wait_end":
      // 승인·답: 다시 생각(곧 tool_start 가 온다). 취소: 곧 step_error·done 이 온다
      return { state: { ...toThinking(), tool: null }, reactions: [] };

    case "done": {
      const kind = judgeResult(s.run, "done");
      const petState = PET_OK.has(kind) ? sig.petState : null;
      return {
        state: { ...s, phase: "result", since: now, tool: null, lastTool: s.tool ? { cue: s.tool, startedAt: s.since, endedAt: now } : s.lastTool, wait: null, result: { kind, petState, at: now } },
        reactions: resultReactions(kind, petState),
      };
    }

    case "loop_error":
      return {
        state: { ...s, phase: "result", since: now, tool: null, wait: null, result: { kind: "error", petState: null, at: now } },
        reactions: resultReactions("error", null),
      };

    case "abort":
      return { state: { ...IDLE_SESSION, since: now }, reactions: [] };
  }
}

/** PET_STATE 로 반응을 바꿔도 되는 결과(실패를 '행복'으로 덮지 못하게) */
const PET_OK: ReadonlySet<ResultKind> = new Set(["wrote", "used", "plain"]);

/** 결과 판정(§3.4). 중간 오류 뒤 다시 시도해 성공하는 일이 많아서, 마지막 도구가 실패했을 때만 실패 */
export function judgeResult(run: NekoSessionState["run"], how: "done" | "loop_error" | "abort"): ResultKind {
  if (how === "abort") return "aborted";
  if (how === "loop_error") return "error";
  if (!run) return "plain";
  if (run.cancelled) return "cancelled";
  if (run.lastFailed) return "failed";
  if (run.wrote) return "wrote";
  if (run.tools > 0) return "used";
  return "plain";
}

/** 결과가 보이는 동안의 자세·기분과 길이(§3.4). PET_STATE 가 있으면 표 5.1 대로 */
export function resultLook(kind: ResultKind, petState: CatEmotion | null): { mood: NekoMood; pose: NekoPose; holdMs: number } {
  if (petState) {
    switch (petState) {
      case "happy": return { mood: "happy", pose: "stand", holdMs: 2500 };
      case "proud": return { mood: "happy", pose: "sit", holdMs: 2500 };
      case "curious": return { mood: "curious", pose: "sit", holdMs: 2500 };
      case "sleepy": return { mood: "sleepy", pose: "loaf", holdMs: 2500 };
      case "sad": return { mood: "idle", pose: "sit", holdMs: 2500 };
      case "error": return { mood: "idle", pose: "stand", holdMs: 3000 };
      default: break; // idle·working·cozy: 결과 표대로
    }
  }
  switch (kind) {
    case "wrote": return { mood: "happy", pose: "stand", holdMs: 2500 };
    case "used": return { mood: "happy", pose: "sit", holdMs: 2500 };
    case "failed": return { mood: "idle", pose: "stand", holdMs: 3000 };
    case "cancelled": return { mood: "idle", pose: "sit", holdMs: 2000 };
    case "error": return { mood: "idle", pose: "stand", holdMs: 3000 };
    case "plain":
    case "aborted":
    default: return { mood: "idle", pose: "stand", holdMs: 0 };
  }
}

/** 결과 반응(여운 뒤에 낸다: gate "result") */
export function resultReactions(kind: ResultKind, petState: CatEmotion | null): Reaction[] {
  const g = { gate: "result" as const };
  if (petState) {
    switch (petState) {
      case "happy": return [{ type: "react", kind: "cheer", ...g }];
      case "proud": return [{ type: "react", kind: "proud", ...g }];
      case "curious": return [{ type: "tail", sign: "question", sec: 2.5, ...g }];
      case "sad": return [{ type: "react", kind: "down", ...g }];
      case "error": return [{ type: "react", kind: "sulk", ...g }];
      case "sleepy": return [];
      default: break;
    }
  }
  switch (kind) {
    case "wrote": return [{ type: "react", kind: "cheer", ...g }];
    case "used": return [{ type: "react", kind: "proud", ...g }];
    case "failed": return [{ type: "react", kind: "sulk", ...g }];
    case "cancelled": return [{ type: "react", kind: "down", ...g }];
    case "error": return [{ type: "react", kind: "startle", ...g }, { type: "react", kind: "down", delay: 1200, ...g }];
    default: return [];
  }
}
