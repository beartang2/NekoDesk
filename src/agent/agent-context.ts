import { toWireToolCalls } from "./tool-calls";
import type { AgentStep, CatEmotion, ContentPart, LlmMessage, ToolCall } from "./types";

const MAX_CONTEXT_CHARS = 3000;

/** 실행이 끝난 툴 호출 하나 — 모델이 요청한 호출과 그 결과 스텝의 짝. */
export interface ExecutedCall {
  call: ToolCall;
  step: AgentStep;
}

/** 한 턴: 모델이 낸 텍스트 + 그 턴에서 실행된 툴 호출들. */
export interface ContextTurn {
  text: string;
  calls: ExecutedCall[];
}

/**
 * 루프가 모델에게 다시 보여줄 대화 상태.
 *
 * 예전에는 스텝을 평평한 배열로 들고 assistant JSON 문자열 + tool 메시지를 한 쌍씩
 * 만들었다. native tool calling 은 **한 턴에 여러 호출**이 나오고, assistant 메시지
 * 하나의 `tool_calls` 배열과 뒤따르는 tool 메시지들이 `tool_call_id` 로 짝을
 * 맞춰야 한다. 그래서 턴이 1급 개념이 됐다.
 */
export class AgentContext {
  private readonly userContent: string | ContentPart[];
  private readonly chatHistory: LlmMessage[];
  private readonly turns: ContextTurn[] = [];
  private readonly native: boolean;

  constructor(
    chatHistory: LlmMessage[],
    userContent: string | ContentPart[],
    native: boolean
  ) {
    this.userContent = userContent;
    // Keep recent history only to stay within context budget
    this.chatHistory = chatHistory.slice(-6);
    this.native = native;
  }

  addTurn(turn: ContextTurn): void {
    this.turns.push(turn);
  }

  /** UI 표시·최종 이벤트용 평평한 스텝 목록. 실행 순서를 보존한다. */
  get steps(): AgentStep[] {
    return this.turns.flatMap((t) => t.calls.map((c) => c.step));
  }

  /** Build message list for the next agent LLM call */
  toMessages(): LlmMessage[] {
    const messages: LlmMessage[] = [
      ...this.chatHistory,
      { role: "user", content: this.userContent },
    ];

    for (const turn of this.turns) {
      if (turn.calls.length === 0) continue;
      messages.push(...(this.native ? nativeTurnMessages(turn) : jsonTurnMessages(turn)));
    }

    return messages;
  }

  /** Aggregate all tool summaries into a single context string for the final chat call */
  buildToolContext(): string {
    const parts = this.steps
      .filter((s) => s.status === "done")
      .map((s) => `[${s.tool}]\n${s.summary}`);
    if (parts.length === 0) return "";

    // Hard cap to avoid blowing the context budget
    return parts.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
  }

  /** Derive final cat emotion from what happened in the loop */
  deriveCatEmotion(): CatEmotion {
    const steps = this.steps;
    if (steps.some((s) => s.status === "error")) return "error";
    const successful = steps.filter((s) => s.status === "done");
    if (successful.length === 0) return "idle";
    // If a write operation succeeded, show proud/happy
    const writeTools = ["todo.add", "todo.complete", "schedule.add", "code.exec"];
    if (successful.some((s) => writeTools.includes(s.tool))) return "happy";
    return "curious";
  }
}

/**
 * native 모드: assistant 메시지 하나에 tool_calls 배열, 그 뒤에 호출당 tool 메시지
 * 하나. 순서와 tool_call_id 가 어긋나면 채팅 템플릿이 짝을 못 맞춘다.
 */
function nativeTurnMessages(turn: ContextTurn): LlmMessage[] {
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
        content: `[${call.name} 결과]\n${step.summary}`,
      })
    ),
  ];
}

/** json 폴백 모드: 예전 형식 그대로 — assistant 가 JSON 한 덩이, tool 이 결과. */
function jsonTurnMessages(turn: ContextTurn): LlmMessage[] {
  return turn.calls.flatMap(({ call, step }): LlmMessage[] => [
    {
      role: "assistant",
      content: JSON.stringify({ thought: turn.text, tool: call.name, params: call.params }),
    },
    { role: "tool", content: `[${call.name} 결과]\n${step.summary}` },
  ]);
}
