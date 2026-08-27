import { describe, it, expect } from "vitest";
import { estimateTokens } from "./token-estimate";

/** 추정 계수가 실제 토크나이저와 얼마나 맞는지 잰다. */
const LLM_URL = "http://127.0.0.1:8803";
const serverUp = await fetch(`${LLM_URL}/health`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

async function actualTokens(content: string): Promise<number> {
  const res = await fetch(`${LLM_URL}/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return ((await res.json()) as { tokens: number[] }).tokens.length;
}

const SAMPLES: Array<[string, string]> = [
  ["한국어 문장", "오늘 할 일 목록이랑 내일 일정을 같이 정리해서 보여줘. 급한 것부터 위로 올려줘."],
  ["영어 코드", "const result = await fetch(url, { method: 'POST', body: JSON.stringify(payload) });"],
  ["섞인 로그", "오류 요약: command not found: ffmpeg (exit_code=127) at /Users/<user>/bin"],
  ["AppleScript", 'tell application "Music" to play playlist "Neko Queue"'],
];

describe.skipIf(!serverUp)("estimateTokens 정확도", () => {
  /**
   * 글자 종류만 보는 선형 추정의 실제 오차 범위를 못 박아둔다. 목표는 정확도가
   * 아니라 **범위를 아는 것** 이다 — 예산 쪽 여유를 이 숫자에 맞춰 잡는다.
   */
  it("실제 토큰 수의 0.6~2.0배 안에 든다", async () => {
    for (const [label, text] of SAMPLES) {
      const actual = await actualTokens(text);
      const ratio = estimateTokens(text) / actual;
      console.log(`${label}: 추정/실제 = ${ratio.toFixed(2)}`);
      expect(ratio, `${label} 추정이 범위를 벗어났다`).toBeGreaterThan(0.6);
      expect(ratio, `${label} 추정이 범위를 벗어났다`).toBeLessThan(2.0);
    }
  });
});
