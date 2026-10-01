import { describe, it, expect, vi } from "vitest";
// wordChainReply 만 LLM 을 쓴다. 순수 선택기를 테스트하려고 설정 스토어(localStorage)를
// 끌어올 이유가 없다.
vi.mock("./llm-client", () => ({ fetchCompletion: vi.fn() }));

import { chainWordGrammar, pickChainWord } from "./word-chain";

describe("pickChainWord", () => {
  it("깔끔한 단어 하나면 그대로 쓴다", () => {
    // 이어받을 글자는 종성까지 포함한다 — "녕" 다음은 "영"이지 "여"가 아니다.
    expect(pickChainWord("영어", "녕", [])).toBe("영어");
  });

  it("모델이 문장으로 답하면 앞쪽 조각이 아니라 실제 답을 고른다", () => {
    // 예전에는 앞에서부터 첫 일치를 집어 "려로" 를 단어로 내놨다.
    expect(pickChainWord("려로 시작하는 단어는 여행", "려", [])).toBe("여행");
  });

  it("이미 나온 단어는 고르지 않는다", () => {
    // 예전에는 걸러내지 않아 고양이가 같은 단어를 내고 스스로 졌다.
    expect(pickChainWord("영어", "녕", ["영어"])).toBeNull();
    expect(pickChainWord("영어 아니면 영상", "녕", ["영어"])).toBe("영상");
  });

  it("이어받을 글자가 안 맞는 단어는 거른다", () => {
    expect(pickChainWord("사과", "녕", [])).toBeNull();
    // 종성이 다르면 이어받은 게 아니다.
    expect(pickChainWord("여행", "녕", [])).toBeNull();
  });

  it("두음법칙으로 이어받은 단어를 받아준다", () => {
    expect(pickChainWord("영어", "녕", [])).toBe("영어");
    expect(pickChainWord("나비", "라", [])).toBe("나비");
    expect(pickChainWord("이발", "리", [])).toBe("이발");
  });

  it("한 글자 단어는 후보가 아니다", () => {
    expect(pickChainWord("영", "녕", [])).toBeNull();
  });

  it("첫 수(이어받을 글자 없음)는 아무 단어나 받는다", () => {
    expect(pickChainWord("고양이", "", [])).toBe("고양이");
  });

  it("한글이 없으면 null", () => {
    expect(pickChainWord("INVALID", "녕", [])).toBeNull();
    expect(pickChainWord("", "녕", [])).toBeNull();
    expect(pickChainWord("hello world 123", "녕", [])).toBeNull();
  });

  it("아주 긴 토큰은 잘라서 본다", () => {
    const long = "영" + "어".repeat(30);
    expect(pickChainWord(long, "녕", [])).toHaveLength(10);
  });
});

describe("chainWordGrammar", () => {
  it("이어받을 글자로 시작하고 두~다섯 음절만 허용한다", () => {
    expect(chainWordGrammar("비")).toBe('root ::= "비" [가-힣] [가-힣]? [가-힣]? [가-힣]?');
  });

  it("두음법칙으로 바꿀 수 있으면 바꾼 글자로 박는다", () => {
    // 원래 글자를 열어두면 "료료" 같은 없는 말을 지어냈다.
    expect(chainWordGrammar("료")).toContain('"요"');
    expect(chainWordGrammar("녀")).toContain('"여"');
    expect(chainWordGrammar("라")).toContain('"나"');
    // 박은 글자로 시작한 단어는 선택기를 반드시 통과해야 한다 — 문법과 판정이 어긋나면
    // 문법이 강제한 단어를 선택기가 버려서 고양이가 항복한다.
    expect(pickChainWord("요리", "료", [])).toBe("요리");
  });

  it("첫 수는 아무 음절로나 시작하되 한 글자는 안 된다", () => {
    expect(chainWordGrammar("")).toBe("root ::= [가-힣] [가-힣] [가-힣]? [가-힣]? [가-힣]?");
  });
});
