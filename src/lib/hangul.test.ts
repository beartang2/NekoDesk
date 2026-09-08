import { describe, it, expect } from "vitest";
import {
  canonicalize,
  roParticle,
  isPlayableWord,
  compose,
  decompose,
  dueumAlternative,
  matchesStartChar,
} from "./hangul";

describe("음절 분해·조합", () => {
  it("초·중·종성을 바르게 갈라낸다", () => {
    // 가장 흔한 오류 지점이라 대표 글자로 못 박는다.
    expect(decompose("각")).toEqual({ cho: 0, jung: 0, jong: 1 });
    expect(decompose("녕")).toEqual({ cho: 2, jung: 6, jong: 21 });
    expect(decompose("리")).toEqual({ cho: 2 + 3, jung: 20, jong: 0 });
  });

  it("한글이 아니면 null", () => {
    for (const ch of ["a", "1", "!", "ㄱ", "", "🐱"]) {
      expect(decompose(ch)).toBeNull();
    }
  });

  it("분해한 것을 다시 조합하면 원래 글자", () => {
    for (const ch of "안녕하세요고양이끝말잇기") {
      expect(compose(decompose(ch)!)).toBe(ch);
    }
  });
});

describe("두음법칙", () => {
  it("ㄹ + 이·야 계열 → ㅇ", () => {
    expect(canonicalize("려")).toBe("여");
    expect(canonicalize("료")).toBe("요");
    expect(canonicalize("류")).toBe("유");
    expect(canonicalize("리")).toBe("이");
    expect(canonicalize("례")).toBe("예");
    expect(canonicalize("력")).toBe("역"); // 종성 유지
  });

  it("ㄹ + 그 외 모음 → ㄴ", () => {
    expect(canonicalize("라")).toBe("나");
    expect(canonicalize("래")).toBe("내");
    expect(canonicalize("로")).toBe("노");
    expect(canonicalize("루")).toBe("누");
    expect(canonicalize("르")).toBe("느");
    expect(canonicalize("뢰")).toBe("뇌");
  });

  it("ㄴ + 이·야 계열 → ㅇ", () => {
    expect(canonicalize("녀")).toBe("여");
    expect(canonicalize("뇨")).toBe("요");
    expect(canonicalize("뉴")).toBe("유");
    expect(canonicalize("니")).toBe("이");
    expect(canonicalize("녕")).toBe("영");
  });

  it("ㄴ + 그 외 모음은 그대로 — 예전엔 ㅓ·ㅜ·ㅡ 를 이 계열로 잘못 봤다", () => {
    expect(canonicalize("너")).toBe("너");
    expect(canonicalize("누")).toBe("누");
    expect(canonicalize("나")).toBe("나");
  });

  it("ㄹ·ㄴ 이 아닌 초성은 건드리지 않는다", () => {
    for (const ch of "가마바사아자차카타파하") {
      expect(canonicalize(ch)).toBe(ch);
    }
  });
});

describe("이어받기 판정", () => {
  /** [앞 단어, 뒷 단어, 허용해야 하는가, 설명] */
  const CASES: Array<[string, string, boolean, string]> = [
    ["안녕", "영어", true, "녕→영 (가장 흔한 수)"],
    ["유리", "이발", true, "리→이"],
    ["재료", "요리", true, "료→요"],
    ["종류", "유리", true, "류→유"],
    ["신라", "나비", true, "라→나"],
    ["과로", "노래", true, "로→노"],
    ["안녕", "녕치", true, "바꾸지 않고 그대로 이어도 된다"],
    ["가루", "우유", false, "루→우 는 두음법칙이 아니다"],
    ["가루", "누나", true, "루→누 가 맞는 변환"],
    ["바나나", "나비", true, "평범한 일치"],
    ["바나나", "가방", false, "글자가 다르면 거부"],
    ["소라", "라면", true, "바꾸지 않고 그대로"],
  ];

  it.each(CASES)("%s → %s", (prev, next, allowed) => {
    const lastChar = prev[prev.length - 1];
    expect(matchesStartChar(next, lastChar)).toBe(allowed);
  });

  it("첫 수(이어받을 글자 없음)는 무엇이든 허용", () => {
    expect(matchesStartChar("아무거나", "")).toBe(true);
  });

  it("빈 단어는 거부", () => {
    expect(matchesStartChar("", "가")).toBe(false);
  });
});

describe("힌트", () => {
  it("안내한 글자는 반드시 실제로 통과한다", () => {
    // 예전에는 힌트가 "나도 가능" 이라 해놓고 "나비" 를 거부했다.
    for (const ch of "라로루르려리료류녀뇨니녕") {
      const alt = dueumAlternative(ch);
      if (alt === null) continue;
      expect(
        matchesStartChar(alt + "가", ch),
        `"${ch}" 힌트로 "${alt}" 를 안내했는데 거부당한다`
      ).toBe(true);
    }
  });

  it("바꿀 게 없으면 힌트도 없다", () => {
    expect(dueumAlternative("가")).toBeNull();
    expect(dueumAlternative("나")).toBeNull();
    expect(dueumAlternative("영")).toBeNull();
  });

  it("두음법칙 대상은 대표 형태를 알려준다", () => {
    expect(dueumAlternative("녕")).toBe("영");
    expect(dueumAlternative("려")).toBe("여");
    expect(dueumAlternative("라")).toBe("나");
  });
});

describe("낼 수 있는 단어", () => {
  it("한글 두 글자 이상만 허용", () => {
    expect(isPlayableWord("나비")).toBe(true);
    expect(isPlayableWord("고양이")).toBe(true);
  });

  it("한 글자는 거부 — 끝말잇기가 성립하지 않는다", () => {
    expect(isPlayableWord("영")).toBe(false);
    expect(isPlayableWord("")).toBe(false);
  });

  it("한글이 아닌 글자가 섞이면 거부", () => {
    for (const w of ["hello", "나비1", "cat", "나 비", "나비!", "ㄱㄴ", "🐱🐱"]) {
      expect(isPlayableWord(w), w).toBe(false);
    }
  });
});

describe("조사 로/으로", () => {
  it("받침이 없으면 로", () => {
    for (const w of ["가", "고양이", "지", "이"]) expect(roParticle(w), w).toBe("로");
  });

  it("ㄹ 받침도 로", () => {
    for (const w of ["말", "물", "설"]) expect(roParticle(w), w).toBe("로");
  });

  it("그 밖의 받침이면 으로", () => {
    // 전사에 실제로 나온 `"람"로 시작하는` 이 이 경우다.
    for (const w of ["람", "강", "집", "축"]) expect(roParticle(w), w).toBe("으로");
  });

  it("한글이 아니면 로", () => {
    expect(roParticle("a")).toBe("로");
    expect(roParticle("")).toBe("로");
  });
});
