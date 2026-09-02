/**
 * 한글 음절 다루기 — 끝말잇기의 두음법칙 판정에 쓴다.
 *
 * 한글 음절은 `가`(0xAC00) 부터 `(초성*21 + 중성)*28 + 종성` 순서로 늘어선다.
 *
 * ## 인덱스를 손으로 세지 않는다
 *
 * 예전 구현은 두음법칙 대상 모음을 `[2, 3, 4, 5, 10, 13, 18]` 처럼 숫자로 적어뒀는데,
 * 주석에는 "ㅑㅒㅕㅖㅛㅠㅣ" 라고 써놓고 실제로는 ㅓㅔㅙㅜㅡ 를 가리키고 있었다.
 * 일곱 중 다섯이 틀렸고, 그 결과 "안녕→영"·"유리→이발" 같은 가장 흔한 수가 거부되고
 * "가루→우유" 같은 반칙이 통과했다. 여기서는 글자 표에서 인덱스를 **찾아서** 쓴다 —
 * 사람이 셀 일이 없으면 잘못 셀 일도 없다.
 */

const BASE = 0xac00;
const LAST = 0xd7a3;

/** 유니코드 조합 순서 그대로. */
const CHOSUNG = [
  "ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ",
  "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ",
] as const;

const JUNGSUNG = [
  "ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ",
  "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ",
] as const;

const cho = (letter: string) => CHOSUNG.indexOf(letter as (typeof CHOSUNG)[number]);
const jung = (letter: string) => JUNGSUNG.indexOf(letter as (typeof JUNGSUNG)[number]);

const CHO_N = cho("ㄴ");
const CHO_R = cho("ㄹ");
const CHO_IEUNG = cho("ㅇ");

/** i·y 로 시작하는 중성. 두음법칙이 ㅇ 으로 바꾸는 조건이다. */
const I_VOWELS = new Set(["ㅑ", "ㅒ", "ㅕ", "ㅖ", "ㅛ", "ㅠ", "ㅣ"].map(jung));

export interface Syllable {
  cho: number;
  jung: number;
  jong: number;
}

/** 한글 음절 하나를 초·중·종성으로. 한글이 아니면 null. */
export function decompose(char: string): Syllable | null {
  const code = char.charCodeAt(0);
  if (Number.isNaN(code) || code < BASE || code > LAST) return null;
  const offset = code - BASE;
  return {
    cho: Math.floor(offset / 28 / 21),
    jung: Math.floor(offset / 28) % 21,
    jong: offset % 28,
  };
}

export function compose({ cho, jung, jong }: Syllable): string {
  return String.fromCharCode(BASE + (cho * 21 + jung) * 28 + jong);
}

/**
 * 두음법칙을 적용한 대표 형태.
 *
 *   ㄹ + 이·야 계열 → ㅇ   (려→여, 료→요, 류→유, 리→이, 례→예)
 *   ㄹ + 그 외      → ㄴ   (라→나, 래→내, 로→노, 뢰→뇌, 루→누, 르→느)
 *   ㄴ + 이·야 계열 → ㅇ   (녀→여, 뇨→요, 뉴→유, 니→이)
 *
 * 그 외 글자는 그대로 돌려준다.
 */
export function canonicalize(char: string): string {
  const s = decompose(char);
  if (!s) return char;
  const isI = I_VOWELS.has(s.jung);

  if (s.cho === CHO_R) return compose({ ...s, cho: isI ? CHO_IEUNG : CHO_N });
  if (s.cho === CHO_N && isI) return compose({ ...s, cho: CHO_IEUNG });
  return char;
}

/**
 * `word` 가 `lastChar` 를 이어받을 수 있는가.
 *
 * 두 글자를 각각 대표 형태로 바꿔 비교한다. 규칙이 한 군데(canonicalize)에만 있어야
 * 판정과 힌트가 어긋나지 않는다 — 예전에는 힌트가 "나도 가능" 이라고 안내하고
 * 정작 "나비" 를 내면 거부하는 상태였다.
 */
export function matchesStartChar(word: string, lastChar: string): boolean {
  if (!lastChar) return true;
  if (!word) return false;
  return canonicalize(word[0]) === canonicalize(lastChar);
}

/**
 * 두음법칙으로 바꿔 쓸 수 있는 글자. 바꿀 게 없으면 null.
 * 힌트 문구에 쓴다. 판정과 같은 함수를 쓰므로 안내한 글자는 반드시 통과한다.
 */
export function dueumAlternative(char: string): string | null {
  const canonical = canonicalize(char);
  return canonical === char ? null : canonical;
}
