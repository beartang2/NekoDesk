/**
 * 토큰 수 어림짐작.
 *
 * 진짜 토크나이저를 부르려면 매번 서버를 왕복해야 한다. 컨텍스트를 자를지
 * 판단하는 데는 그 정확도가 필요 없다.
 *
 * 계수는 실제 모델 토크나이저(Qwen3.5)로 최소제곱 피팅한 값(0.73 / 0.28)보다
 * 조금 높게 잡았다. **과대평가는 낭비지만 과소평가는 컨텍스트 오버플로**라
 * 대칭이 아니기 때문이다.
 *
 * 글자 종류만 보는 선형 모델의 한계는 분명하다 — 실측 결과 문장부호가 빽빽한
 * 입력(파일 경로 등)은 최대 33% 과소, 드문 한글 음절은 최대 78% 과대평가한다.
 * 그래서 예산 쪽에서 여유(`SAFETY_RATIO`)를 따로 둔다. 매 턴 서버가 실제
 * `prompt_tokens` 를 알려주므로 큰 오차는 다음 턴에 드러난다.
 * (실측: token-estimate.integration.test.ts)
 */

/** 최소제곱 피팅값(0.73/0.28)에 안전 여유를 얹은 값. */
const CJK_WEIGHT = 0.85;
const ASCII_WEIGHT = 0.32;

const CJK = /[ᄀ-ᇿ　-ヿ㄰-㆏가-힯一-鿿＀-￯]/;

/** 대략적인 토큰 수. 항상 0 이상. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * CJK_WEIGHT + other * ASCII_WEIGHT);
}

/** 메시지 배열의 토큰 합. 이미지 파트는 대략 고정값으로 친다. */
export function estimateMessagesTokens(
  messages: Array<{ content: unknown; tool_calls?: unknown }>
): number {
  let total = 0;
  for (const m of messages) {
    total += 4; // 역할·구분자 오버헤드
    total += estimateContentTokens(m.content);
    if (m.tool_calls) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

/** 이미지 한 장의 대략적인 비용. 정확한 값은 모델·해상도마다 다르다. */
const IMAGE_TOKENS = 600;

function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTokens(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content as Array<{ type?: string; text?: string }>) {
    if (part?.type === "image_url") total += IMAGE_TOKENS;
    else total += estimateTokens(part?.text ?? "");
  }
  return total;
}
