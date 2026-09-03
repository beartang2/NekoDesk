import { fetchCompletion } from "./llm-client";

/**
 * 그림 맞추기 게임 — 단어 뽑기와 그림 판독.
 *
 * 끝말잇기(word-chain.ts)와 같은 이유로 llm-client 밖에 둔다. 게임 규칙은 LLM
 * 클라이언트의 일이 아니고, 저 파일은 이미 프롬프트·스트리밍·툴 호출만으로 충분히 크다.
 */

const FALLBACK_WORDS = [
  "고양이", "강아지", "집", "자동차", "나무", "피자", "기타", "달", "물고기",
  "컵", "사과", "토끼", "책", "전화기", "케이크", "비행기", "자전거", "꽃",
  "수박", "카메라",
];

export async function generateGameWords(count: number): Promise<string[]> {
  try {
    const raw = await fetchCompletion([
      {
        role: "system",
        content: "그림 맞추기 게임 단어 생성기. JSON 배열만 출력. 다른 텍스트 없음.",
      },
      {
        role: "user",
        content: `그림으로 그리기 쉬운 한국어 명사 ${count}개를 JSON 배열로 출력해. 동물/음식/사물/자연물 위주, 중복 없이, 매번 다양하게.`,
      },
    ], { temperature: 1.0, max_tokens: 150 });

    console.log("[generateGameWords] raw:", raw);

    // 코드블록 제거 후 JSON 배열 추출
    const cleaned = raw.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]) as unknown[];
      if (Array.isArray(arr) && arr.length > 0) {
        const words = arr.map(String).filter((w) => /[가-힣]/.test(w));
        if (words.length >= count) return words.slice(0, count);
        if (words.length > 0) return words; // 부족해도 있는 만큼 사용
      }
    }
    console.warn("[generateGameWords] parse failed, raw:", raw);
  } catch (e) {
    console.error("[generateGameWords] error:", e);
  }
  return [...FALLBACK_WORDS].sort(() => Math.random() - 0.5).slice(0, count);
}

export async function guessDrawing(imageDataUrl: string): Promise<string> {
  const raw = await fetchCompletion([{
    role: "user",
    content: [
      { type: "image_url", image_url: { url: imageDataUrl } },
      { type: "text", text: "이 그림이 뭔지 한국어 명사 하나만 답해줘. 설명 없이 단어만." },
    ],
  }], { temperature: 0.2, max_tokens: 20 });
  const korean = raw.match(/[가-힣]+/);
  return korean ? korean[0] : (raw.trim().split(/\s/)[0] ?? "모르겠어");
}
