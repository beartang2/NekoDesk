import { toWireToolCalls } from "./tool-calls";
import { estimateMessagesTokens, estimateTokens } from "./token-estimate";
import type { AgentStep, CatEmotion, ContentPart, LlmMessage, ToolCall } from "./types";

/**
 * 컨텍스트 중 대화·툴 결과에 쓸 비율.
 *
 * 나머지는 시스템 프롬프트(툴 스키마 포함, native 기준 4천 토큰 근처)와 모델이
 * 생성할 여유분이다. 추정치 자체가 실제 토큰의 0.6~2.0배로 흔들리므로
 * (token-estimate 참고) 여유를 넉넉히 둔다 — 여기서 아끼면 오버플로가 난다.
 */
const BUDGET_RATIO = 0.35;

/** 이만큼의 최근 턴은 요약하지 않고 전문을 싣는다. */
const VERBATIM_TURNS = 3;

/** 요약해도 예산을 넘으면 오래된 것부터 이 표시로 접는다. */
const ELIDED = "[이전 단계 생략됨]";

function elidedNotice(count: number): LlmMessage {
  return { role: "user", content: `${ELIDED} (${count}개 턴, 컨텍스트 한도)` };
}

/** 실행이 끝난 툴 호출 하나 — 모델이 요청한 호출과 그 결과 스텝의 짝. */
export interface ExecutedCall {
  call: ToolCall;
  step: AgentStep;
}

/** 한 턴: 모델이 낸 텍스트 + 그 턴에서 실행된 툴 호출들. */
export interface ContextTurn {
  text: string;
  calls: ExecutedCall[];
  /** 이 턴의 도구가 도는 사이 사용자가 덧붙인 말. 도구 결과 뒤에 user 메시지로 실린다. */
  followUps?: (string | ContentPart[])[];
}

/**
 * 루프가 모델에게 다시 보여줄 대화 상태.
 *
 * 예전에는 대화를 최근 6개로 자르고 툴 결과를 3000자에서 잘랐다. 두 숫자 모두
 * 모델의 실제 컨텍스트 크기와 무관해서, 작은 모델에선 넘치고 큰 모델에선 멀쩡한
 * 정보를 버렸다. 지금은 `n_ctx` 에서 예산을 뽑아 그 안에서 최신 것부터 채운다.
 */
export class AgentContext {
  private readonly userContent: string | ContentPart[];
  private readonly chatHistory: LlmMessage[];
  private readonly turns: ContextTurn[] = [];
  private readonly native: boolean;
  private readonly budget: number;

  constructor(
    chatHistory: LlmMessage[],
    userContent: string | ContentPart[],
    native: boolean,
    contextLength: number
  ) {
    this.userContent = userContent;
    this.chatHistory = chatHistory;
    this.native = native;
    this.budget = Math.max(512, Math.floor(contextLength * BUDGET_RATIO));
  }

  addTurn(turn: ContextTurn): void {
    this.turns.push(turn);
  }

  /** 작업 중에 사용자가 덧붙인 말을 방금 끝난 턴 뒤에 싣는다. */
  addFollowUp(content: string | ContentPart[]): void {
    const last = this.turns[this.turns.length - 1];
    if (!last) return;
    (last.followUps ??= []).push(content);
  }

  /** UI 표시·최종 이벤트용 평평한 스텝 목록. 실행 순서를 보존한다. */
  get steps(): AgentStep[] {
    return this.turns.flatMap((t) => t.calls.map((c) => c.step));
  }

  /**
   * 다음 LLM 호출에 보낼 메시지.
   *
   * 채우는 순서가 곧 우선순위다: 이번 요청(사용자 메시지)과 최근 툴 결과가 먼저고,
   * 오래된 대화 이력이 가장 먼저 밀린다. 진행 중인 작업의 근거를 잃는 것보다
   * 지난 잡담을 잃는 편이 낫다.
   */
  toMessages(): LlmMessage[] {
    const current: LlmMessage = { role: "user", content: this.userContent };
    // 생략 안내를 붙일 수도 있으니 그 자리를 미리 뺀다. 나중에 더하면 예산을 넘는다.
    // 실제 문구로 재서 어림수를 쓰다 1토큰씩 새는 것을 막는다(턴 수는 자릿수만큼만 는다).
    const noticeReserve = estimateMessagesTokens([elidedNotice(this.turns.length)]);
    let remaining = this.budget - estimateMessagesTokens([current]) - noticeReserve;
    // 덧붙인 말은 이번 요청의 일부다. 턴이 예산에 밀려 접혀도 이것만은 남긴다.
    const followUpsOf = (turn: ContextTurn): LlmMessage[] =>
      (turn.followUps ?? []).map((content): LlmMessage => ({ role: "user", content }));
    remaining -= estimateMessagesTokens(this.turns.flatMap(followUpsOf));

    // 1) 턴 메시지 — 최근 것부터, 오래된 것은 요약본으로.
    const turnBlocks: LlmMessage[][] = [];
    let elidedTurns = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i];
      if (turn.calls.length === 0) continue;
      const verbatim = this.turns.length - 1 - i < VERBATIM_TURNS;
      const block = this.turnMessages(turn, verbatim);
      const cost = estimateMessagesTokens(block);
      if (cost > remaining) {
        elidedTurns++;
        turnBlocks.unshift(followUpsOf(turn));
        continue;
      }
      remaining -= cost;
      turnBlocks.unshift([...block, ...followUpsOf(turn)]);
    }

    // 2) 남은 예산으로 대화 이력을 최근부터 채운다.
    const history: LlmMessage[] = [];
    for (let i = this.chatHistory.length - 1; i >= 0; i--) {
      const cost = estimateMessagesTokens([this.chatHistory[i]]);
      if (cost > remaining) break;
      remaining -= cost;
      history.unshift(this.chatHistory[i]);
    }

    const notice: LlmMessage[] = elidedTurns > 0 ? [elidedNotice(elidedTurns)] : [];

    return [...history, current, ...notice, ...turnBlocks.flat()];
  }

  private turnMessages(turn: ContextTurn, verbatim: boolean): LlmMessage[] {
    return this.native
      ? nativeTurnMessages(turn, verbatim)
      : jsonTurnMessages(turn, verbatim);
  }

  /**
   * 최대 반복에 도달했을 때 마지막 답변 생성에 넘길 요약.
   * 여기서도 예산 안에서 최신 결과를 우선한다.
   */
  buildToolContext(): string {
    const parts: string[] = [];
    let remaining = this.budget;
    for (const step of this.steps.filter((s) => s.status === "done").reverse()) {
      const text = `[${step.tool}]\n${step.summary}`;
      const cost = estimateTokens(text);
      if (cost > remaining) break;
      remaining -= cost;
      parts.unshift(text);
    }
    return parts.join("\n\n");
  }

  /** Derive final cat emotion from what happened in the loop */
  deriveCatEmotion(): CatEmotion {
    const steps = this.steps;
    if (steps.some((s) => s.status === "error")) return "error";
    const successful = steps.filter((s) => s.status === "done");
    if (successful.length === 0) return "idle";
    // If a write operation succeeded, show proud/happy
    const writeTools = ["todo.add", "todo.complete", "schedule.add", "code.exec", "fs.write", "fs.edit"];
    if (successful.some((s) => writeTools.includes(s.tool))) return "happy";
    return "curious";
  }
}

/**
 * 오래된 턴의 툴 결과를 줄인다.
 *
 * 첫 줄과 마지막 줄만 남긴다 — 무엇을 했는지(첫 줄)와 어떻게 끝났는지(마지막 줄,
 * 보통 exit_code 나 오류)가 이후 판단에 실제로 쓰이는 부분이다.
 */
function condense(summary: string, max = 200): string {
  if (summary.length <= max) return summary;
  const lines = summary.split("\n").filter((l) => l.trim());
  if (lines.length <= 2) return `${summary.slice(0, max)}…`;
  return `${lines[0]}\n…\n${lines[lines.length - 1]}`.slice(0, max + 20);
}

/**
 * native 모드: assistant 메시지 하나에 tool_calls 배열, 그 뒤에 호출당 tool 메시지
 * 하나. 순서와 tool_call_id 가 어긋나면 채팅 템플릿이 짝을 못 맞춘다.
 */
function nativeTurnMessages(turn: ContextTurn, verbatim: boolean): LlmMessage[] {
  return [
    {
      role: "assistant",
      content: turn.text,
      tool_calls: toWireToolCalls(turn.calls.map((c) => c.call)),
    },
    ...turn.calls.map(
      ({ call, step }): LlmMessage => ({
        role: "tool",
        tool_call_id: call.id,
        content: `[${call.name} 결과]\n${verbatim ? step.summary : condense(step.summary)}`,
      })
    ),
  ];
}

/** json 폴백 모드: 예전 형식 그대로 — assistant 가 JSON 한 덩이, tool 이 결과. */
function jsonTurnMessages(turn: ContextTurn, verbatim: boolean): LlmMessage[] {
  return turn.calls.flatMap(({ call, step }): LlmMessage[] => [
    {
      role: "assistant",
      content: JSON.stringify({ thought: turn.text, tool: call.name, params: call.params }),
    },
    {
      role: "tool",
      content: `[${call.name} 결과]\n${verbatim ? step.summary : condense(step.summary)}`,
    },
  ]);
}
