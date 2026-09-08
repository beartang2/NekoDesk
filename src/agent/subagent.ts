import { fetchCompletionMessage } from "./llm-client";
import { buildToolSchemas } from "./tool-schemas";
import { getTool, isStaticTool } from "./tool-registry";
import { toWireToolCalls } from "./tool-calls";
import type { LlmMessage, ToolCall, ToolName } from "./types";

/**
 * 조사 전용 하위 에이전트.
 *
 * ## 왜 있나
 *
 * 여기서 제일 부족한 자원은 컨텍스트다(로컬 모델 8K). 웹 검색 열 번, 파일 스무 개
 * 훑기 같은 일은 과정이 길고 결론은 짧다. 그 과정을 본 대화에 쌓으면 정작 필요한
 * 정보가 밀려난다. 하위 에이전트는 자기 컨텍스트에서 그 일을 하고 **요약만** 돌려준다.
 *
 * 속도는 안 빨라진다. 모델 슬롯이 하나라 어차피 순차로 돈다 — 얻는 건 격리뿐이다.
 *
 * ## 왜 조회만 하나
 *
 * 본 루프의 확인 다이얼로그는 UI 로 이벤트를 올려 사용자 응답을 기다린다. 하위
 * 루프는 툴 실행 안에서 소비되므로 그 이벤트를 올릴 데가 없고, 그대로 두면 아무도
 * resolve 하지 않는 promise 에 매달려 교착된다. 그래서 애초에 부작용 있는 툴을
 * 주지 않는다. `readOnly` 가 아닌 툴은 목록에 없고, 불러도 거부된다.
 *
 * 덤으로 재귀도 막힌다 — `agent.delegate` 자체가 readOnly 가 아니라 목록에서 빠진다.
 */

/** 조사에 쓸 수 있는 단계 수. 본 루프보다 훨씬 짧다 — 길어지면 격리의 뜻이 없다. */
const MAX_STEPS = 8;

const SYSTEM_PROMPT = `너는 조사 담당이야. 주어진 과제를 조회 툴로 알아보고 결과만 요약해서 답해.

- 쓰기·실행·전송은 할 수 없어. 조회 툴만 있어.
- 알아낼 게 남았으면 툴을 계속 불러. 다 됐으면 툴 없이 요약만 답해.
- 요약은 짧게. 알아낸 사실과 출처만 남기고 과정 설명은 빼.
- 못 알아냈으면 못 알아냈다고 해. 지어내지 마.`;

/** 부작용 없는 툴만. MCP 툴은 부작용 여부를 알 수 없어 제외한다. */
function readOnlySchemas() {
  return buildToolSchemas().filter(
    (s) => isStaticTool(s.function.name) && getTool(s.function.name).readOnly
  );
}

async function runReadOnlyTool(call: ToolCall): Promise<string> {
  if (!isStaticTool(call.name)) {
    return `조사 단계에서는 쓸 수 없는 툴이야: ${call.name}`;
  }
  const entry = getTool(call.name as ToolName);
  if (!entry.readOnly) {
    return `${call.name} 은 조사 단계에서 쓸 수 없어. 조회만 가능해 — 필요하면 알아낸 것만 요약해서 돌려줘.`;
  }
  try {
    return entry.summarize(await entry.execute(call.params));
  } catch (err) {
    return `오류: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/** 과제를 조사하고 요약을 돌려준다. 실패해도 던지지 않는다 — 툴 결과로 전달된다. */
export async function runSubagent(task: string, signal?: AbortSignal): Promise<string> {
  const tools = readOnlySchemas();
  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    // 마지막 단계에서는 툴을 빼앗아 요약을 강제한다. 안 그러면 상한에 걸려
    // 아무 결론 없이 끝난다.
    const isLast = step === MAX_STEPS - 1;
    const turn = await fetchCompletionMessage(
      messages,
      { temperature: 0.2, ...(isLast ? {} : { tools }) },
      undefined,
      signal
    );

    if (turn.toolCalls.length === 0) {
      return turn.text.trim() || "조사했지만 쓸 만한 결과가 없었어.";
    }

    messages.push({
      role: "assistant",
      content: turn.text,
      tool_calls: toWireToolCalls(turn.toolCalls),
    });
    for (const call of turn.toolCalls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: await runReadOnlyTool(call),
      });
    }
  }

  return "조사 단계 상한에 도달했어.";
}
