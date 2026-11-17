import { describe, expect, it } from "vitest";
import type { CatEmotion } from "../agent/types";
import { emotionPlan } from "./emotionMap";

describe("emotionPlan (설계 표 5.1)", () => {
  const all: CatEmotion[] = ["idle", "curious", "working", "happy", "proud", "sleepy", "sad", "error", "cozy"];

  it("모든 감정을 기분·자세로 읽는다", () => {
    for (const e of all) {
      const p = emotionPlan(e);
      expect(["idle", "happy", "sleepy", "curious"]).toContain(p.mood);
      expect(["stand", "sit", "loaf", "lie"]).toContain(p.pose);
    }
  });

  it("일하는 중엔 타이핑, 상자 모드는 상자 활동", () => {
    expect(emotionPlan("working").act).toBe("typing");
    expect(emotionPlan("cozy").act).toBe("box");
  });

  it("결과 감정은 꼬리 언어로 한 번 반응한다", () => {
    expect(emotionPlan("happy").react).toBe("cheer");
    expect(emotionPlan("proud").react).toBe("proud");
    expect(emotionPlan("error").react).toBe("sulk");
    expect(emotionPlan("sad").react).toBe("down");
  });

  it("졸리면 누워 자고, 생각 중엔 앉는다", () => {
    expect(emotionPlan("sleepy")).toMatchObject({ mood: "sleepy", pose: "lie" });
    expect(emotionPlan("curious")).toMatchObject({ mood: "curious", pose: "sit" });
  });
});
