import { fetchCompletion } from "./llm-client";
import { matchesStartChar } from "../lib/hangul";

/**
 * 끝말잇기에서 고양이가 낼 단어를 정한다.
 *
 * llm-client 밖에 두는 이유: 이건 게임 규칙이지 LLM 클라이언트의 일이 아니다.
 * 실무적으로도, llm-client 는 설정 스토어를 끌어와 브라우저 전역(localStorage)을
 * 요구하기 때문에 그 안에 있으면 순수 함수 하나를 테스트하려고 전역을 흉내내야 한다.
 */

/**
 * 모델 답변에서 쓸 수 있는 단어 하나를 고른다.
 *
 * 순수 함수라 프롬프트·네트워크 없이 테스트된다. 고르는 규칙:
 *   1. 한글 두 글자 이상만 후보
 *   2. 이어받을 글자와 맞아야 함 (두음법칙 포함)
 *   3. 이미 나온 단어는 제외
 *
 * 남은 것 중 **마지막**을 고른다. 모델이 "단어만" 이라는 지시를 어기고 문장으로
 * 답할 때(`"려로 시작하는 단어는 여행"`) 한국어는 답을 뒤에 놓기 때문이다.
 * 예전에는 앞에서부터 첫 일치를 집어 `"려로"` 같은 조각을 단어로 내놓았다.
 */
export function pickChainWord(
  raw: string,
  lastChar: string,
  usedWords: string[]
): string | null {
  const used = new Set(usedWords);
  const candidates = (raw.match(/[가-힣]+/g) ?? [])
    .map((w) => w.slice(0, 10))
    .filter((w) => w.length >= 2)
    .filter((w) => !used.has(w))
    .filter((w) => matchesStartChar(w, lastChar));
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

export async function wordChainReply(
  lastChar: string,
  usedWords: string[],
  validateWord?: string,
): Promise<string> {
  const usedStr = usedWords.length > 0 ? ` 이미 사용된 단어: [${usedWords.join(", ")}].` : "";

  // 유저 단어 검증 + 고양이 응답을 한 번의 LLM 호출로 처리
  const basePrompt = validateWord
    ? `끝말잇기 게임이야. 유저가 "${validateWord}"를 냈어.
이 단어가 실제 한국어 사전에 있는 단어인지 먼저 판단해.
- 실존하는 단어라면: "${lastChar}"로 시작하는 한국어 명사 하나만 답해줘. 두음법칙 적용 가능.${usedStr}
- 실존하지 않는 단어라면: INVALID 라고만 답해.
설명 없이 단어 또는 INVALID만.`
    : lastChar
    ? `끝말잇기 게임이야. 반드시 "${lastChar}"로 시작하는 한국어 명사 단어 하나만 답해줘. 반드시 두 글자 이상이어야 해. 두음법칙 적용 가능 (예: '녕'→'영', '렬'→'열', '뇨'→'요').${usedStr} 설명 없이 단어만.`
    : `끝말잇기 게임 시작! 한국어 명사 하나만 답해줘. 반드시 두 글자 이상이어야 해. 설명 없이 단어만.`;

  const MAX_TRIES = 5;
  const rejected: string[] = [];

  for (let i = 0; i < MAX_TRIES; i++) {
    // 재시도할 때 뭐가 왜 안 됐는지 알려준다. 같은 프롬프트를 다시 던지면
    // 모델은 대개 같은 답을 내놓아 재시도가 낭비된다.
    const retryNote =
      rejected.length > 0
        ? `\n이건 쓸 수 없어(이미 나왔거나 글자가 안 맞아): [${rejected.join(", ")}]. 다른 단어로.`
        : "";
    const raw = (await fetchCompletion(
      [{ role: "user", content: basePrompt + retryNote }],
      { max_tokens: 20, temperature: 0.9 }
    )).trim();

    const word = pickChainWord(raw, lastChar, usedWords);
    if (word) return word;

    // 쓸 만한 단어가 하나도 없을 때만 INVALID 로 읽는다. 모델이 "INVALID 아니고
    // 여행" 처럼 답하면 단어 쪽을 택하는 게 맞다.
    if (raw.toUpperCase().includes("INVALID")) return "INVALID";

    for (const w of raw.match(/[가-힣]+/g) ?? []) {
      if (w.length >= 2 && !rejected.includes(w)) rejected.push(w);
    }
  }
  return "";
}
