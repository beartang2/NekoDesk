import { describe, expect, it, vi } from "vitest";

/** 선물 그리기 지시엔 그리는 법만 — 본보기 물건·예시 물건 이름이 없다(0.1.25, 사용자: 편향되는 예시는 싫다) */
const h = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock("./llm-client", () => ({
  fetchCompletionMessage: async (m: unknown, p: unknown) => {
    h.sent.push(JSON.stringify([m, p]));
    return { text: "", toolCalls: [{ name: "gift_draw", params: { gift_shape: { parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] } } }] };
  },
}));

import { drawGift } from "./gift-draw";

describe("gift_draw 지시", () => {
  it("본보기·예시 물건 없이 그리는 규칙만", async () => {
    const g = await drawGift("은행잎", "노랗다");
    expect(g?.shape.parts).toHaveLength(1);
    const first = h.sent[0];
    expect(first).toContain("그릴 물건: 은행잎");
    expect(first).toContain("도형 8~20개");
    for (const w of ["본보기", "도토리", "단풍잎", "열쇠", "병뚜껑", "솔방울", "반딧불", "등불"]) expect(first).not.toContain(w);
  });
});
