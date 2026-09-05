import { describe, it, expect } from "vitest";
import { parseKoreanDate, normalizeDateInput, isIsoDateString } from "./korean-date";

// 기준 시각 고정: 2026-08-26(수) 10:00
const NOW = new Date(2026, 7, 26, 10, 0, 0);

describe("parseKoreanDate — 상대 날짜", () => {
  it("오늘/내일/모레/글피를 계산한다", () => {
    expect(parseKoreanDate("오늘", NOW)?.iso).toBe("2026-08-26");
    expect(parseKoreanDate("내일", NOW)?.iso).toBe("2026-08-27");
    expect(parseKoreanDate("모레", NOW)?.iso).toBe("2026-08-28");
    expect(parseKoreanDate("글피", NOW)?.iso).toBe("2026-08-29");
  });

  it("어제/그저께처럼 과거도 계산한다", () => {
    expect(parseKoreanDate("어제", NOW)?.iso).toBe("2026-08-25");
    expect(parseKoreanDate("그제", NOW)?.iso).toBe("2026-08-24");
  });

  it("N일/N주/N개월 후를 계산한다", () => {
    expect(parseKoreanDate("3일 후", NOW)?.iso).toBe("2026-08-29");
    expect(parseKoreanDate("2주 뒤", NOW)?.iso).toBe("2026-09-09");
    expect(parseKoreanDate("1개월 후", NOW)?.iso).toBe("2026-09-26");
  });

  it("월말을 계산한다", () => {
    expect(parseKoreanDate("이번 달 말", NOW)?.iso).toBe("2026-08-31");
  });

  it("다음 달 특정일을 계산한다", () => {
    expect(parseKoreanDate("다음 달 15일", NOW)?.iso).toBe("2026-09-15");
  });
});

describe("parseKoreanDate — 요일", () => {
  // 2026-08-26 은 수요일. 그 주 일요일은 2026-08-23.
  it("다음 주 요일을 계산한다", () => {
    expect(parseKoreanDate("다음 주 화요일", NOW)?.iso).toBe("2026-09-01");
  });

  it("이번 주 요일을 계산한다", () => {
    expect(parseKoreanDate("이번 주 금요일", NOW)?.iso).toBe("2026-08-28");
  });

  it("다다음 주 요일을 계산한다", () => {
    expect(parseKoreanDate("다다음 주 월요일", NOW)?.iso).toBe("2026-09-07");
  });

  it("주 지정어가 없으면 가장 가까운 미래 요일을 고른다", () => {
    // 수요일 기준, 다음 월요일은 8/31
    expect(parseKoreanDate("월요일", NOW)?.iso).toBe("2026-08-31");
  });
});

describe("parseKoreanDate — 시각", () => {
  it("오후 시각을 24시간제로 바꾼다", () => {
    const r = parseKoreanDate("내일 오후 3시", NOW);
    expect(r?.iso).toBe("2026-08-27T15:00:00");
    expect(r?.hasTime).toBe(true);
  });

  it("분까지 파싱한다", () => {
    expect(parseKoreanDate("내일 오후 3시 30분", NOW)?.iso).toBe("2026-08-27T15:30:00");
  });

  it("새벽/저녁을 구분한다", () => {
    expect(parseKoreanDate("내일 새벽 2시", NOW)?.iso).toBe("2026-08-27T02:00:00");
    expect(parseKoreanDate("내일 저녁 7시", NOW)?.iso).toBe("2026-08-27T19:00:00");
  });

  it("정오와 자정을 처리한다", () => {
    expect(parseKoreanDate("내일 정오", NOW)?.iso).toBe("2026-08-27T12:00:00");
    expect(parseKoreanDate("내일 자정", NOW)?.iso).toBe("2026-08-27T00:00:00");
  });

  it("날짜 없이 시각만 있고 이미 지났으면 내일로 넘긴다", () => {
    // 기준이 10:00 이므로 "8시"는 지났다
    expect(parseKoreanDate("8시", NOW)?.iso).toBe("2026-08-27T08:00:00");
    // "14시"는 아직 안 지났다
    expect(parseKoreanDate("14시", NOW)?.iso).toBe("2026-08-26T14:00:00");
  });

  it("종일 표현은 hasTime 이 false 다", () => {
    expect(parseKoreanDate("내일", NOW)?.hasTime).toBe(false);
  });
});

describe("parseKoreanDate — 절대 표기", () => {
  it("YYYY-MM-DD 를 그대로 읽는다", () => {
    expect(parseKoreanDate("2026-12-01", NOW)?.iso).toBe("2026-12-01");
  });

  it("M월 D일을 읽는다", () => {
    expect(parseKoreanDate("9월 3일", NOW)?.iso).toBe("2026-09-03");
  });

  it("이미 지난 M월 D일은 내년으로 넘긴다", () => {
    expect(parseKoreanDate("1월 5일", NOW)?.iso).toBe("2027-01-05");
  });
});

describe("parseKoreanDate — 해석 불가", () => {
  it("날짜 단서가 없으면 null 을 준다", () => {
    expect(parseKoreanDate("회의", NOW)).toBeNull();
    expect(parseKoreanDate("", NOW)).toBeNull();
  });
});

describe("isIsoDateString", () => {
  it("ISO 형식을 판별한다", () => {
    expect(isIsoDateString("2026-08-26")).toBe(true);
    expect(isIsoDateString("2026-08-26T14:00:00")).toBe(true);
    expect(isIsoDateString("내일")).toBe(false);
  });
});

describe("normalizeDateInput", () => {
  it("ISO 는 그대로 둔다", () => {
    expect(normalizeDateInput("2026-08-26T14:00:00", NOW)).toBe("2026-08-26T14:00:00");
  });

  it("한국어 표현은 ISO 로 바꾼다", () => {
    expect(normalizeDateInput("내일 오후 3시", NOW)).toBe("2026-08-27T15:00:00");
  });

  it("해석 불가한 값은 원본을 유지한다", () => {
    expect(normalizeDateInput("언젠가", NOW)).toBe("언젠가");
  });
});
