/**
 * "게임 하자" 를 모델에 맡기지 않고 여기서 알아본다.
 *
 * 예전에는 모델이 `game.start` 를 부르길 기대했는데, 작은 모델에겐 채팅으로 게임을
 * 흉내내는 쪽이 훨씬 쉬운 길이라 그쪽으로 샜다. 그리고 흉내낸 게임은 규칙부터 틀린다 —
 * 실제로 "'강'으로 끝나는 단어를 대라"(끝말잇기는 시작 글자를 잇는다)라거나, 한 글자
 * 단어를 내거나, 이어받기를 무시하는 일이 벌어졌다. 게임 규칙은 코드가 알고 있으니
 * 모델의 판단을 거칠 이유가 없다.
 */

export type GameIntent = "wordchain" | "drawing";

/** 하고 싶다는 뜻으로 읽히는 말. */
const PLAY = /(하자|할래|하고\s*싶|해줘|할까|시작|가자|고고|ㄱㄱ|플레이|play)/;

/** 하자는 게 아니라 물어보는 말. 이게 있으면 시작하지 않는다. */
const ASKING = /(규칙|방법|어떻게|뭐야|뭔데|설명|알려|가르|무슨|왜|아니)/;

const NAMES: Array<[GameIntent, RegExp]> = [
  ["wordchain", /(끝말잇기|끝말\s*잇기|word\s*chain)/],
  ["drawing", /(그림\s*맞추기|그림\s*게임|그림판\s*게임|그림\s*퀴즈|drawing\s*game)/],
];

/**
 * 게임을 시작하자는 뜻이면 어떤 게임인지 돌려준다. 아니면 null.
 *
 * 짧은 문장만 본다 — 긴 문단 속에 게임 이름이 스쳐 지나갔다고 게임을 띄우면
 * 하려던 일이 날아간다.
 */
export function detectGameIntent(text: string): GameIntent | null {
  const s = text.trim().toLowerCase();
  if (!s || s.length > 40) return null;
  if (ASKING.test(s)) return null;

  for (const [game, name] of NAMES) {
    if (!name.test(s)) continue;
    // 이름만 덩그러니 있어도 하자는 뜻으로 본다 ("끝말잇기").
    const onlyName = s.replace(name, "").replace(/[\s!?.~]/g, "") === "";
    if (onlyName || PLAY.test(s)) return game;
  }
  return null;
}
