// @vitest-environment jsdom
// 도구 표가 settingsStore(→ localStorage)를 불러온다
import { afterEach, describe, expect, it } from "vitest";
import { dayWithRel, nowInZone, setTimeZone } from "../lib/time";
import { getTool } from "./tool-registry";
import { DEFAULT_CHAT_SYSTEM_PROMPT, __promptsForTest, agentContextPrefix } from "./llm-client";

/** 날짜·시각 도구(0.1.32, 사용자: 메시지마다 시각을 붙이지 말고 필요할 때 네코가 확인하게) */
const AT = new Date("2026-11-24T05:30:00Z"); // 서울 14:30(화), 뉴욕 00:30(화)

afterEach(() => setTimeZone(undefined));

describe("time.now", () => {
  it("날씨 위치의 시간대로 날짜·요일·시각과 시간대 이름을 돌려준다", () => {
    setTimeZone("Asia/Seoul");
    expect(nowInZone(AT)).toEqual({ date: "2026-11-24", weekday: "화", time: "14:30", zone: "Asia/Seoul" });
    setTimeZone("America/Los_Angeles");
    expect(nowInZone(AT)).toEqual({ date: "2026-11-23", weekday: "월", time: "21:30", zone: "America/Los_Angeles" });
  });
  it("도구 결과는 한 줄", async () => {
    setTimeZone("Asia/Seoul");
    const t = getTool("time.now");
    const out = t.summarize(await t.execute({}));
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}\([일월화수목금토]\) \d{2}:\d{2}, 시간대 Asia\/Seoul$/);
  });
  it("일정·할 일 결과의 날짜엔 요일과 오늘 기준 말이 붙는다(날짜를 잘못 셌으면 바로 보이게)", () => {
    setTimeZone("Asia/Seoul");
    expect(dayWithRel("2026-11-24", AT)).toBe("2026-11-24(화), 오늘");
    expect(dayWithRel("2026-11-25T14:00:00", AT)).toBe("2026-11-25(수) 14:00, 내일");
    expect(dayWithRel("2026-11-30", AT)).toBe("2026-11-30(월), 6일 뒤");
    expect(dayWithRel("2024-11-25", AT)).toBe("2024-11-25(월), 729일 전");
    expect(dayWithRel("다음 주", AT)).toBe("다음 주");
  });
});

describe("요청에 시각을 붙이지 않는다", () => {
  it("접두에 날짜·시각이 없고, 붙일 지식·기억이 없으면 접두도 없다", () => {
    expect(agentContextPrefix("안녕", "")).toBe("");
    expect(agentContextPrefix("안녕", "- [fact] 고양이를 키운다")).not.toMatch(/날짜|시각|\d{4}\.\s?\d{1,2}\./);
  });
  it("규칙은 한 줄씩: 에이전트(로컬·Claude 공통 말투 규칙)와 채팅 프롬프트", () => {
    for (const native of [true, false]) {
      const sys = __promptsForTest.system(native);
      expect(sys.match(/time\.now 로 확인해\. 확인 못 하면 모른다고 해/g)).toHaveLength(1);
      expect(sys).not.toMatch(/현재 날짜\/시각/);
    }
    expect(DEFAULT_CHAT_SYSTEM_PROMPT.match(/time\.now 로 확인해/g)).toHaveLength(1);
  });
});
