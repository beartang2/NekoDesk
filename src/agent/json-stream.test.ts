import { describe, it, expect } from "vitest";
import { createJsonStringFieldStreamer } from "./json-stream";

/** 원본을 n글자씩 잘라 밀어넣고 누적 결과를 돌려준다. LLM 토큰 경계를 흉내낸다. */
function pushInChunks(raw: string, size: number): string {
  const s = createJsonStringFieldStreamer("finalAnswer");
  let out = "";
  for (let i = 0; i < raw.length; i += size) {
    out += s.push(raw.slice(i, i + size));
  }
  return out;
}

describe("createJsonStringFieldStreamer", () => {
  it("한 번에 들어온 JSON 에서 필드를 뽑는다", () => {
    const raw = `{"thought":"생각","tool":"none","finalAnswer":"안녕하세요"}`;
    const s = createJsonStringFieldStreamer("finalAnswer");
    expect(s.push(raw)).toBe("안녕하세요");
    expect(s.isDone()).toBe(true);
  });

  it("어떤 청크 크기로 쪼개도 같은 결과를 낸다", () => {
    const raw = `{"thought":"t","tool":"none","finalAnswer":"오늘 날씨는 맑아요 🐱"}`;
    for (const size of [1, 2, 3, 5, 7, 13, 64]) {
      expect(pushInChunks(raw, size)).toBe("오늘 날씨는 맑아요 🐱");
    }
  });

  it("닫는 따옴표에서 멈추고 뒤따르는 키를 먹지 않는다", () => {
    const raw = `{"finalAnswer":"끝","tool":"none"}`;
    const s = createJsonStringFieldStreamer("finalAnswer");
    expect(s.push(raw)).toBe("끝");
    expect(s.push(`{"finalAnswer":"또"}`)).toBe("");
  });

  it("이스케이프를 디코딩한다", () => {
    const raw = `{"finalAnswer":"a\\"b\\\\c\\nd\\te"}`;
    expect(pushInChunks(raw, 1)).toBe('a"b\\c\nd\te');
  });

  it("\\uXXXX 를 디코딩한다 (경계에 걸쳐도)", () => {
    const raw = `{"finalAnswer":"\\uAC00\\uB098"}`; // 가나
    for (const size of [1, 2, 3, 4, 5, 6]) {
      expect(pushInChunks(raw, size)).toBe("가나");
    }
  });

  it("서로게이트 페어를 쪼개서 반쪽 문자를 내보내지 않는다", () => {
    const raw = `{"finalAnswer":"\\uD83D\\uDE38"}`; // 😸
    for (const size of [1, 2, 3, 5, 6, 7, 11]) {
      const out = pushInChunks(raw, size);
      expect(out).toBe("😸");
      expect(out).not.toContain("�");
    }
  });

  it("서로게이트 페어가 완성되기 전에는 아무것도 내보내지 않는다", () => {
    const s = createJsonStringFieldStreamer("finalAnswer");
    expect(s.push(`{"finalAnswer":"\\uD83D`)).toBe("");
    expect(s.push(`\\uDE38"}`)).toBe("😸");
  });

  it("필드가 없으면 아무것도 안 내보낸다", () => {
    const s = createJsonStringFieldStreamer("finalAnswer");
    expect(s.push(`{"thought":"t","tool":"web.search","params":{"query":"x"}}`)).toBe("");
    expect(s.isDone()).toBe(false);
  });

  it("다른 값 안에 필드 이름이 문자열로 등장해도 속지 않는다", () => {
    const raw = `{"thought":"\\"finalAnswer\\" 를 쓸 차례","finalAnswer":"진짜"}`;
    const s = createJsonStringFieldStreamer("finalAnswer");
    expect(s.push(raw)).toBe("진짜");
  });

  it("키가 청크 경계에 걸쳐도 찾아낸다", () => {
    const raw = `{"tool":"none","finalAnswer":"쪼개짐"}`;
    expect(pushInChunks(raw, 1)).toBe("쪼개짐");
  });

  it("공백이 낀 `\"finalAnswer\" :  \"…\"` 도 처리한다", () => {
    const s = createJsonStringFieldStreamer("finalAnswer");
    expect(s.push(`{ "finalAnswer" :   "여백" }`)).toBe("여백");
  });

  it("빈 문자열 필드를 처리한다", () => {
    const s = createJsonStringFieldStreamer("finalAnswer");
    expect(s.push(`{"finalAnswer":""}`)).toBe("");
    expect(s.isDone()).toBe(true);
  });
});
