import type { RawToolCallDelta, ToolCall, WireToolCall } from "./types";

/**
 * 스트리밍 tool_calls 조립기.
 *
 * llama.cpp 는 OpenAI 형식 그대로 툴 호출을 조각내서 보낸다. 첫 조각만 `id`·`name`
 * 을 싣고, 이후 조각은 `arguments` 문자열의 일부만 싣는다. 같은 턴에 여러 툴이
 * 있으면 `index` 로 구분된다.
 *
 *   {index:0, id:"a", name:"todo.list",     arguments:"{"}
 *   {index:0,                                arguments:"}"}
 *   {index:1, id:"b", name:"schedule.list", arguments:"{"}
 *   {index:1,                                arguments:"\"range\":\""}
 *
 * 순수 상태 기계라 테스트가 쉽다. 네트워크·스트림을 모른다.
 */
export class ToolCallAccumulator {
  private readonly slots = new Map<number, { id: string; name: string; args: string }>();

  push(deltas: RawToolCallDelta[]): void {
    for (const d of deltas) {
      const slot = this.slots.get(d.index) ?? { id: "", name: "", args: "" };
      if (d.id) slot.id = d.id;
      if (d.name) slot.name = d.name;
      if (d.argumentsFragment) slot.args += d.argumentsFragment;
      this.slots.set(d.index, slot);
    }
  }

  get isEmpty(): boolean {
    return this.slots.size === 0;
  }

  /**
   * 완성된 호출 목록. index 순서를 보존한다 — assistant 메시지의 tool_calls 순서와
   * tool 결과 메시지 순서가 어긋나면 템플릿이 짝을 못 맞춘다.
   *
   * arguments 가 깨졌으면 빈 params 로 넘긴다. 툴 실행 단계에서 필수 파라미터가
   * 없다고 에러가 나고, 그 에러가 모델에게 돌아가 재시도하게 된다. 여기서 호출
   * 자체를 버리면 모델은 아무 일도 안 일어난 것처럼 보여 같은 실수를 반복한다.
   */
  finish(): ToolCall[] {
    return [...this.slots.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, s]) => s.name)
      .map(([index, s]) => ({
        id: s.id || `call_${index}`,
        name: s.name,
        params: parseArguments(s.args),
      }));
  }
}

/** `arguments` 문자열 → 객체. 빈 문자열·깨진 JSON 은 빈 객체. */
export function parseArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 응답에 그대로 실려 온 tool_calls(비스트리밍 경로) → ToolCall[]. */
export function fromWireToolCalls(wire: WireToolCall[] | undefined): ToolCall[] {
  if (!wire?.length) return [];
  return wire
    .filter((w) => w.function?.name)
    .map((w, i) => ({
      id: w.id || `call_${i}`,
      name: w.function.name,
      params: parseArguments(w.function.arguments ?? ""),
    }));
}

/** ToolCall[] → 대화 이력에 다시 실어 보낼 OpenAI 형식. */
export function toWireToolCalls(calls: ToolCall[]): WireToolCall[] {
  return calls.map((c) => ({
    id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.params) },
  }));
}
