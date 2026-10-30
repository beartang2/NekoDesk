// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { clock, dbDate, parseDbTime, setTimeZone } from "./time";

afterEach(() => setTimeZone(undefined));

it("SQLite 시각(시간대 표시 없음)은 UTC 로 읽는다", () => {
  expect(parseDbTime("2026-10-30 04:11:00").toISOString()).toBe("2026-10-30T04:11:00.000Z");
  // 시간대가 붙어 있으면 그대로.
  expect(parseDbTime("2026-10-30T13:11:00+09:00").toISOString()).toBe("2026-10-30T04:11:00.000Z");
});

it("날씨 위치의 시간대로 시각·날짜를 찍는다", () => {
  // 오전/오후 글자는 ICU 데이터에 따라 "PM" 으로도 찍혀 숫자만 본다.
  setTimeZone("Asia/Seoul");
  expect(clock(parseDbTime("2026-10-30 04:11:00"))).toContain("01:11");
  // UTC 로는 전날 밤이지만 서울에선 다음 날 아침.
  expect(dbDate("2026-10-29 23:30:00")).toBe("2026-10-30");
  setTimeZone("America/New_York");
  expect(clock(parseDbTime("2026-10-30 04:11:00"))).toContain("12:11");
});
