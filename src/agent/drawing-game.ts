import { fetchCompletion } from "./llm-client";

/**
 * 그림 맞추기 게임 — 제시어 뽑기와 그림 판독.
 *
 * 끝말잇기(word-chain.ts)와 같은 이유로 llm-client 밖에 둔다. 게임 규칙은 LLM
 * 클라이언트의 일이 아니고, 저 파일은 이미 프롬프트·스트리밍·툴 호출만으로 충분히 크다.
 */

/** 제시어 하나. `name` 은 결과 문구에 쓸 한국어 이름일 뿐, 판정에는 안 쓴다. */
export interface EmojiPrompt {
  emoji: string;
  name: string;
}

/**
 * 제시어는 이모지에서 뽑고, 고양이도 같은 표에서 골라 답한다.
 *
 * 예전엔 라운드마다 LLM 에게 "그리기 쉬운 한국어 명사" 를 받고, 그림을 본 뒤엔
 * 한국어 단어로 답하게 해 문자열을 비교했다. 두 군데가 다 새어나갔다. 시작할 때마다
 * 수 초를 기다렸고, 무엇보다 "집" 과 "주택", "물고기" 와 "생선" 을 어떻게 같다고
 * 볼지에 정답이 없었다 — 잘 그린 그림이 단어가 어긋났다는 이유로 오답 처리됐다.
 *
 * 양쪽 다 이 표에서 고르면 비교는 이모지 하나가 같은지 보는 것으로 끝난다.
 * (고양이에게 아무 이모지나 답하게 해봤더니 ⭐ 를 🌟, 🐠 를 🐟, ☂️ 를 🌂 로
 * 답해서 — 사람 눈엔 맞는데 코드에는 틀린 — 그 문제가 그대로 돌아왔다.
 * 표를 통째로 주고 고르게 하면 답이 반드시 표 안에 들어온다.)
 *
 * 그릴 수 있고 한국어 이름이 분명한 것만 넣는다(🎯 같은 추상적인 건 뺀다).
 */
export const EMOJI_PROMPTS: EmojiPrompt[] = [
  // 동물
  { emoji: "🐱", name: "고양이" },
  { emoji: "🐶", name: "강아지" },
  { emoji: "🐰", name: "토끼" },
  { emoji: "🐻", name: "곰" },
  { emoji: "🐼", name: "판다" },
  { emoji: "🦊", name: "여우" },
  { emoji: "🐸", name: "개구리" },
  { emoji: "🐢", name: "거북이" },
  { emoji: "🐠", name: "물고기" },
  { emoji: "🐙", name: "문어" },
  { emoji: "🦀", name: "게" },
  { emoji: "🐧", name: "펭귄" },
  { emoji: "🦉", name: "부엉이" },
  { emoji: "🐘", name: "코끼리" },
  { emoji: "🦒", name: "기린" },
  { emoji: "🐍", name: "뱀" },
  { emoji: "🐌", name: "달팽이" },
  { emoji: "🦋", name: "나비" },
  { emoji: "🐝", name: "꿀벌" },
  { emoji: "🦕", name: "공룡" },

  // 음식
  { emoji: "🍕", name: "피자" },
  { emoji: "🍔", name: "햄버거" },
  { emoji: "🍎", name: "사과" },
  { emoji: "🍌", name: "바나나" },
  { emoji: "🍉", name: "수박" },
  { emoji: "🍓", name: "딸기" },
  { emoji: "🍇", name: "포도" },
  { emoji: "🥕", name: "당근" },
  { emoji: "🌽", name: "옥수수" },
  { emoji: "🍄", name: "버섯" },
  { emoji: "🍦", name: "아이스크림" },
  { emoji: "🎂", name: "케이크" },
  { emoji: "🍩", name: "도넛" },
  { emoji: "☕", name: "커피" },
  { emoji: "🍜", name: "라면" },
  { emoji: "🥚", name: "계란" },

  // 자연·하늘
  { emoji: "🌳", name: "나무" },
  { emoji: "🌵", name: "선인장" },
  { emoji: "🌻", name: "해바라기" },
  { emoji: "🌷", name: "튤립" },
  { emoji: "🍁", name: "단풍잎" },
  { emoji: "⛄", name: "눈사람" },
  { emoji: "🌈", name: "무지개" },
  { emoji: "☀️", name: "해" },
  { emoji: "🌙", name: "달" },
  { emoji: "⭐", name: "별" },
  { emoji: "☁️", name: "구름" },
  { emoji: "⛰️", name: "산" },
  { emoji: "🔥", name: "불" },

  // 사물
  { emoji: "🏠", name: "집" },
  { emoji: "🚗", name: "자동차" },
  { emoji: "🚲", name: "자전거" },
  { emoji: "✈️", name: "비행기" },
  { emoji: "🚀", name: "로켓" },
  { emoji: "⛵", name: "돛단배" },
  { emoji: "☂️", name: "우산" },
  { emoji: "👓", name: "안경" },
  { emoji: "👑", name: "왕관" },
  { emoji: "🎩", name: "모자" },
  { emoji: "👕", name: "티셔츠" },
  { emoji: "👟", name: "운동화" },
  { emoji: "🔑", name: "열쇠" },
  { emoji: "✂️", name: "가위" },
  { emoji: "✏️", name: "연필" },
  { emoji: "📚", name: "책" },
  { emoji: "🕯️", name: "양초" },
  { emoji: "💡", name: "전구" },
  { emoji: "⌚", name: "손목시계" },
  { emoji: "📷", name: "카메라" },
  { emoji: "☎️", name: "전화기" },
  { emoji: "🎸", name: "기타" },
  { emoji: "🥁", name: "드럼" },
  { emoji: "⚽", name: "축구공" },
  { emoji: "🎈", name: "풍선" },
  { emoji: "🎁", name: "선물상자" },
  { emoji: "🔔", name: "종" },
  { emoji: "🧦", name: "양말" },
  { emoji: "🪑", name: "의자" },
  { emoji: "🚪", name: "문" },
];

/** 중복 없이 `count` 개. 표보다 많이 달라고 하면 있는 만큼만 준다. */
export function pickPrompts(count: number): EmojiPrompt[] {
  const shuffled = [...EMOJI_PROMPTS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

/**
 * 답변에서 표에 있는 이모지를 찾아낸다.
 *
 * 골라 달라고 해도 모델은 "🏠 집이에요" 처럼 말을 덧붙이고, `--reasoning-format`
 * 설정에 따라 `<think>` 블록이 본문에 섞여 오기도 한다. 표에 있는 것 중 가장 먼저
 * 나오는 하나만 집어내면 그 두 경우가 한꺼번에 처리된다.
 */
export function parseEmojiAnswer(raw: string): EmojiPrompt | null {
  const close = raw.lastIndexOf("</think>");
  // 생각이 닫히지 않았다 = 답이 나오기 전에 잘렸다. 사고 과정에는 후보 이모지가
  // 잔뜩 들어 있어서, 여기서 하나를 집으면 고민하던 걸 답으로 읽어버린다.
  if (close < 0 && raw.includes("<think>")) return null;
  const body = close >= 0 ? raw.slice(close + 8) : raw;
  let best: { prompt: EmojiPrompt; at: number } | null = null;
  for (const p of EMOJI_PROMPTS) {
    const at = body.indexOf(p.emoji);
    if (at >= 0 && (!best || at < best.at)) best = { prompt: p, at };
  }
  return best?.prompt ?? null;
}

/** 고양이가 그림을 보고 표에서 고른 것. 못 고르면 null. */
export async function guessDrawing(imageDataUrl: string): Promise<EmojiPrompt | null> {
  const choices = EMOJI_PROMPTS.map((p) => p.emoji).join("");
  const raw = await fetchCompletion([{
    role: "user",
    content: [
      { type: "image_url", image_url: { url: imageDataUrl } },
      {
        type: "text",
        text: `다음 이모지 중에서 이 그림에 가장 가까운 것 하나만 골라. 설명 없이 이모지 하나만 출력해.\n${choices}`,
      },
    ],
    // 생각을 켜 둔 서버에서는 사고 과정이 토큰을 먼저 쓴다. 예전 상한(20)이면
    // 답이 나오기 전에 잘려 빈 문자열이 돌아왔다 — 잘 그린 그림이 늘 오답이던 이유다.
    // 재 봤더니 생각까지 해서 214 토큰. 생각이 꺼져 있으면 4 토큰에 끝나므로
    // 상한을 넉넉히 둬도 느려지지 않는다.
  }], { temperature: 0.2, max_tokens: 512 });
  return parseEmojiAnswer(raw);
}
