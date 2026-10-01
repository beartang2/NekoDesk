import { fetchCompletion } from "./llm-client";
import { dueumAlternative, matchesStartChar } from "../lib/hangul";

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

const SYL = "[가-힣]";

/**
 * 고양이 단어의 첫 음절을 못 박는 GBNF. 두~다섯 음절 한글만 나올 수 있다.
 *
 * 4B 급 모델은 "X 로 시작하는 단어" 를 지키지 못한다. 한글 음절이 토큰 단위로
 * 안 보여서, 이어받을 글자를 그대로 메아리치거나("비" → "비") 아무 단어나 낸다
 * ("이" → "하늘", "바다"). 실측으로 다섯 판 중 네 판을 이렇게 항복했다. 첫 글자를
 * 문법으로 박아두면 모델은 뒤만 고르면 되고, 그건 잘한다("비" → 비행기·비둘기).
 *
 * 두음법칙으로 바꿀 수 있으면 바꾼 글자로 박는다. 원래 글자를 열어두면 그 글자로
 * 시작하는 진짜 단어가 드문 경우 모델이 없는 말을 지어냈다("름" → "름새").
 *
 * ponytail: 첫 글자만 보장한다. 뒤 음절이 사전에 있는 말인지는 모른다("터뎈" 이
 * 드물게 나온다). 막아야 하면 단어 목록을 붙여 문법 대신 목록에서 고른다.
 */
export function chainWordGrammar(lastChar: string): string {
  const start = lastChar ? `"${dueumAlternative(lastChar) ?? lastChar}"` : SYL;
  return `root ::= ${start} ${SYL} ${SYL}? ${SYL}? ${SYL}?`;
}

/**
 * 사용자 단어가 사전에 있는지는 판정하지 않는다.
 *
 * 예전에는 같은 호출에서 모델에게 "실존 단어인지 먼저 판단하고 아니면 INVALID" 를
 * 시켰다. 4B 모델은 "기차" 를 세 번 중 세 번 없는 말로 판정해 사용자가 진짜 단어를
 * 내고도 "속이려 했지? 고양이 승리" 로 졌고, "뛟은한국어" 같은 건 통과시켰다.
 * 진짜 단어로 억울하게 지는 쪽이 가짜 단어로 이기는 쪽보다 나쁘다.
 */
export async function wordChainReply(lastChar: string, usedWords: string[]): Promise<string> {
  const usedStr = usedWords.length > 0 ? ` 이미 사용된 단어: [${usedWords.join(", ")}].` : "";
  // 프롬프트도 문법과 같은 글자를 말해야 한다. 어긋나면 모델이 문법과 싸운다.
  const start = lastChar ? dueumAlternative(lastChar) ?? lastChar : "";
  const basePrompt = start
    ? `끝말잇기 게임이야. "${start}"로 시작하는 한국어 명사 하나만 답해.${usedStr} 설명 없이 단어만.`
    : `끝말잇기 게임 시작! 한국어 명사 하나만 답해. 설명 없이 단어만.`;
  const grammar = chainWordGrammar(lastChar);

  const MAX_TRIES = 5;
  const rejected: string[] = [];

  for (let i = 0; i < MAX_TRIES; i++) {
    // 재시도할 때 뭐가 왜 안 됐는지 알려준다. 같은 프롬프트를 다시 던지면
    // 모델은 대개 같은 답을 내놓아 재시도가 낭비된다.
    const retryNote =
      rejected.length > 0 ? `\n이건 이미 나왔어: [${rejected.join(", ")}]. 다른 단어로.` : "";
    const raw = (await fetchCompletion(
      [{ role: "user", content: basePrompt + retryNote }],
      // 첫 수는 가장 그럴듯한 단어를 고르게 낮게 시작한다. 문법이 첫 글자를 박아두면
      // 낮은 온도에선 매번 같은 단어("음악")가 나와서, 그게 이미 쓰인 단어면 재시도가
      // 헛돈다. 재시도마다 올려서 다른 단어가 나오게 한다.
      { max_tokens: 20, temperature: 0.6 + 0.2 * i, grammar }
    )).trim();

    const word = pickChainWord(raw, lastChar, usedWords);
    if (word) return word;

    for (const w of raw.match(/[가-힣]+/g) ?? []) {
      if (w.length >= 2 && !rejected.includes(w)) rejected.push(w);
    }
  }
  return "";
}
