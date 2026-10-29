/**
 * Claude 의 툴 이름 규칙은 `^[a-zA-Z0-9_-]{1,128}$` 다. 네코의 툴은 전부 `todo.list` 처럼
 * 점으로 묶여 있고(llama.cpp 는 신경 안 쓴다), MCP 서버가 주는 이름은 무엇이든 올 수 있다.
 * 보낼 때 규칙에 맞게 바꾸고, 응답의 tool_use 에서 원래 이름으로 되돌린다. registry 와
 * 루프는 원래 이름만 안다.
 */

/** 바꾼 이름 → 원래 이름. 요청마다 다시 채운다(툴 목록은 요청 사이에 바뀔 수 있다 — MCP). */
const toolNameMap = new Map<string, string>();

export function resetToolNames(): void {
  toolNameMap.clear();
}

export function encodeToolName(name: string): string {
  // `__` 를 점의 자리로 쓴다. 혹시 남는 금지 문자는 `_` 로. 되돌릴 땐 표를 보므로 충돌만 피하면 된다.
  let encoded = name.replace(/\./g, "__").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  if (!encoded) encoded = "tool";
  // 다른 원래 이름이 같은 모양으로 바뀌었으면 꼬리를 붙여 구분한다.
  let candidate = encoded;
  for (let i = 2; toolNameMap.has(candidate) && toolNameMap.get(candidate) !== name; i++) {
    candidate = `${encoded.slice(0, 120)}_${i}`;
  }
  toolNameMap.set(candidate, name);
  return candidate;
}

/** 응답에 실려 온 이름을 원래 이름으로. 모르는 이름(바꾼 적 없음)은 그대로. */
export function decodeToolName(name: string): string {
  return toolNameMap.get(name) ?? name;
}
