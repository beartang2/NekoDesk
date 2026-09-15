import { fetchCompletion } from "./llm-client";

/**
 * 그림 맞추기 게임 — 제시어 뽑기와 그림 판독.
 *
 * 끝말잇기(word-chain.ts)와 같은 이유로 llm-client 밖에 둔다. 게임 규칙은 LLM
 * 클라이언트의 일이 아니고, 저 파일은 이미 프롬프트·스트리밍·툴 호출만으로 충분히 크다.
 */

/** 제시어 하나. `names[0]` 이 대표 이름이고, 나머지는 판정용 별칭이다. */
export interface EmojiPrompt {
  emoji: string;
  names: string[];
}

/**
 * 제시어는 이모지에서 뽑는다.
 *
 * 예전엔 라운드마다 LLM 에게 "그리기 쉬운 한국어 명사" 를 받아 썼는데, 게임을
 * 시작할 때마다 수 초를 기다렸고 JSON 파싱이 깨지면 20개짜리 폴백 리스트로
 * 주저앉아 늘 같은 단어가 나왔다. 이모지는 그 자체가 그림이라 제시어로 보여주기에도
 * 낫다 — 글자를 읽고 머릿속에서 그림을 떠올리는 단계가 사라진다.
 *
 * 그릴 수 있고 한국어 이름이 분명한 것만 넣는다(🎯 같은 추상적인 건 뺀다).
 */
export const EMOJI_PROMPTS: EmojiPrompt[] = [
  // 동물
  { emoji: "🐱", names: ["고양이", "냥이"] },
  { emoji: "🐶", names: ["강아지", "개"] },
  { emoji: "🐰", names: ["토끼"] },
  { emoji: "🐻", names: ["곰"] },
  { emoji: "🐼", names: ["판다"] },
  { emoji: "🦊", names: ["여우"] },
  { emoji: "🐸", names: ["개구리"] },
  { emoji: "🐢", names: ["거북이", "거북"] },
  { emoji: "🐠", names: ["물고기", "생선"] },
  { emoji: "🐙", names: ["문어"] },
  { emoji: "🦀", names: ["게"] },
  { emoji: "🐧", names: ["펭귄"] },
  { emoji: "🦉", names: ["부엉이", "올빼미"] },
  { emoji: "🐘", names: ["코끼리"] },
  { emoji: "🦒", names: ["기린"] },
  { emoji: "🐍", names: ["뱀"] },
  { emoji: "🐌", names: ["달팽이"] },
  { emoji: "🦋", names: ["나비"] },
  { emoji: "🐝", names: ["벌", "꿀벌"] },
  { emoji: "🦕", names: ["공룡"] },

  // 음식
  { emoji: "🍕", names: ["피자"] },
  { emoji: "🍔", names: ["햄버거", "버거"] },
  { emoji: "🍎", names: ["사과"] },
  { emoji: "🍌", names: ["바나나"] },
  { emoji: "🍉", names: ["수박"] },
  { emoji: "🍓", names: ["딸기"] },
  { emoji: "🍇", names: ["포도"] },
  { emoji: "🥕", names: ["당근"] },
  { emoji: "🌽", names: ["옥수수"] },
  { emoji: "🍄", names: ["버섯"] },
  { emoji: "🍦", names: ["아이스크림"] },
  { emoji: "🎂", names: ["케이크", "생일케이크"] },
  { emoji: "🍩", names: ["도넛"] },
  { emoji: "☕", names: ["커피", "커피잔"] },
  { emoji: "🍜", names: ["라면", "국수"] },
  { emoji: "🥚", names: ["계란", "달걀"] },

  // 자연·하늘
  { emoji: "🌳", names: ["나무"] },
  { emoji: "🌵", names: ["선인장"] },
  { emoji: "🌻", names: ["해바라기"] },
  { emoji: "🌷", names: ["튤립", "꽃"] },
  { emoji: "🍁", names: ["단풍", "단풍잎"] },
  { emoji: "⛄", names: ["눈사람"] },
  { emoji: "🌈", names: ["무지개"] },
  { emoji: "☀️", names: ["해", "태양"] },
  { emoji: "🌙", names: ["달", "초승달"] },
  { emoji: "⭐", names: ["별"] },
  { emoji: "☁️", names: ["구름"] },
  { emoji: "⛰️", names: ["산"] },
  { emoji: "🔥", names: ["불", "불꽃"] },

  // 사물
  { emoji: "🏠", names: ["집"] },
  { emoji: "🚗", names: ["자동차", "차"] },
  { emoji: "🚲", names: ["자전거"] },
  { emoji: "✈️", names: ["비행기"] },
  { emoji: "🚀", names: ["로켓"] },
  { emoji: "⛵", names: ["배", "돛단배", "요트"] },
  { emoji: "☂️", names: ["우산"] },
  { emoji: "👓", names: ["안경"] },
  { emoji: "👑", names: ["왕관"] },
  { emoji: "🎩", names: ["모자", "중절모"] },
  { emoji: "👕", names: ["티셔츠", "옷"] },
  { emoji: "👟", names: ["운동화", "신발"] },
  { emoji: "🔑", names: ["열쇠"] },
  { emoji: "✂️", names: ["가위"] },
  { emoji: "✏️", names: ["연필"] },
  { emoji: "📚", names: ["책"] },
  { emoji: "🕯️", names: ["초", "양초"] },
  { emoji: "💡", names: ["전구"] },
  { emoji: "⌚", names: ["시계", "손목시계"] },
  { emoji: "📷", names: ["카메라"] },
  { emoji: "☎️", names: ["전화기", "전화"] },
  { emoji: "🎸", names: ["기타"] },
  { emoji: "🥁", names: ["드럼", "북"] },
  { emoji: "⚽", names: ["축구공", "공"] },
  { emoji: "🎈", names: ["풍선"] },
  { emoji: "🎁", names: ["선물", "선물상자"] },
  { emoji: "🔔", names: ["종", "방울"] },
  { emoji: "🧦", names: ["양말"] },
  { emoji: "🪑", names: ["의자"] },
  { emoji: "🚪", names: ["문"] },
];

/** 중복 없이 `count` 개. 테이블보다 많이 달라고 하면 있는 만큼만 준다. */
export function pickPrompts(count: number): EmojiPrompt[] {
  const shuffled = [...EMOJI_PROMPTS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

/**
 * 고양이의 추측이 제시어와 맞는가.
 *
 * 별칭 중 하나와 같으면 정답이고, 부분 일치는 양쪽 다 두 글자 이상일 때만 인정한다
 * ("달" 이 "달팽이" 를 맞춘 걸로 쳐주면 안 된다).
 */
export function isCorrectGuess(guess: string, prompt: EmojiPrompt): boolean {
  const g = guess.trim();
  if (!g) return false;
  return prompt.names.some((name) => {
    if (g === name) return true;
    if (g.length < 2 || name.length < 2) return false;
    return name.includes(g) || g.includes(name);
  });
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
