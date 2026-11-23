import { describe, it, expect } from "vitest";
import { MIX, POSE_PART, baseOf, mixable, mergePose, mixTable } from "./activity-mix.js";

describe("activity-mix", () => {
  it("모든 쌍의 가능·불가 표(활동이나 선언이 바뀌면 스냅샷 차이로 드러난다)", () => {
    expect(mixTable().join("\n")).toMatchSnapshot();
  });

  it("음악은 누워 자기 말고 모든 활동·기본 상태에 얹힌다", () => {
    const ons = Object.keys(MIX).filter((k) => k !== "music");
    const no = ons.filter((k) => !mixable(k, "music").ok);
    expect(no).toEqual(["base:lie"]);
  });

  it("규칙: 같은 활동 · 곁들임 아님 · 같이 안 함 · 부위 · 자세 · 소품 자리", () => {
    expect(mixable("music", "music").why).toBe("같은 활동");
    expect(mixable("typing", "reading").why).toBe("곁들임 아님");
    expect(mixable("base:lie", "music").why).toBe("같이 안 함");
    const look = (k: string) => ({
      a: { hold: ["paws" as const] }, b: { hold: ["paws" as const], role: "both" as const },
      c: { hold: [], role: "both" as const, needs: ["sit" as const] }, d: { hold: [], stance: "stand" as const, slots: ["floor" as const] },
      e: { hold: [], role: "both" as const, slots: ["floor" as const] },
    })[k];
    expect(mixable("a", "b", look).why).toBe("부위: 앞발");
    expect(mixable("d", "c", look).why).toBe("자세");
    expect(mixable("d", "e", look).why).toBe("소품 자리: floor");
    expect(mixable(null, "music").ok).toBe(false);
    expect(mixable("nope", "music").why).toMatch(/^부위/); // 선언이 없으면 전부 차지함
  });

  it("baseOf: 계획 자세 → 기본 상태 키", () => {
    expect(["stand", "sit", "loaf", "lie"].map((p) => baseOf(p as "stand"))).toEqual(["base:stand", "base:sit", "base:loaf", "base:lie"]);
  });

  it("합치기: 차지한 쪽 값, 비면 아래쪽 값, 곁들임 overlay 는 add 로", () => {
    const typing = { sit: true, ear: -0.05, tt: 0.08, look: [1, 2], lid: 0.2, tail: { base: 1 } };
    const music = { sit: true, ear: 0.22, tt: 0.1, expr: "happy", tail: { base: 2 } };
    const p = mergePose("typing", "music", typing, music, { tt: 0.05, sq: -0.02, tail: 4, ear: 0, nope: 9 } as never);
    expect(p).toEqual({ sit: true, ear: 0.22, tt: 0.08, look: [1, 2], lid: 0.2, tail: { base: 1 }, add: { tt: 0.05, sq: -0.02, tail: 4 } });
    // 기본 상태 위: 아래쪽 자세가 없으니 곁들임이 차지한 귀와 add 만
    expect(mergePose("base:stand", "music", null, music, { tt: 0.03 })).toEqual({ ear: 0.22, add: { tt: 0.03 } });
    // 곁들임이 차지했는데 값을 안 주면 그 부위는 엔진 기본값(아래쪽 값을 지운다)
    expect(mergePose("typing", "music", { ear: 0.3, lid: 1 }, {}, null)).toEqual({ lid: 1, add: {} });
  });

  it("2단계: 혼자 놀기 후보는 채움(fills)이 있고, 상자 뒤지기·쳐다보기도 후보다", () => {
    const solo = Object.keys(MIX).filter((k) => MIX[k].solo).sort();
    expect(solo).toEqual(["box", "butterfly", "cattower", "climb", "dig", "draw", "fbat", "fhide", "fperch", "fscratch", "gaze", "giftplay", "groom", "knead", "lamp", "music", "reading", "snack", "sofa", "stretch", "table", "tower", "wheel", "window", "yarn"]);
    for (const k of solo) expect(Object.values(MIX[k].fills ?? {}).some((v) => v !== 0)).toBe(true);
  });

  it("pose 키 표는 엔진 부위만 쓴다", () => {
    expect(new Set(Object.values(POSE_PART))).toEqual(new Set(["body", "paws", "head", "ears", "tail"]));
  });
});
