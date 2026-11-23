import { describe, expect, it, vi } from "vitest";

/** 자유 가구 그리기(docs/neko-furniture-free.md §5): 그리는 법·축척만 준다(예시 물건 없음), 받은 자리는 코드가 검사한다 */
const h = vi.hoisted(() => ({ sent: [] as string[], reply: null as unknown }));
vi.mock("./llm-client", () => ({
  fetchCompletionMessage: async (m: unknown, p: unknown) => {
    h.sent.push(JSON.stringify([m, p]));
    return h.reply;
  },
}));

import { drawFurniture } from "./furniture-draw";

const rr = (x: number, y: number, w: number, h: number) => ({ t: "rrect", x, y, w, h, rad: 0, rot: 0, c: "brown" });

describe("furniture_draw", () => {
  it("고양이 키 축척과 그리는 법만 주고(예시 물건 없음), 대충 짚은 자리를 그림 윤곽에 맞춘다", async () => {
    h.reply = { text: "", toolCalls: [{ name: "furniture_draw", params: {
      furniture_shape: { parts: [rr(0, -10, 24, 2), rr(-10, -4.5, 2, 9), rr(10, -4.5, 2, 9)] },
      furniture_uses: [{ u: "perch", y: -13, x0: -6, x1: 9 }, { u: "inside", x0: -5, x1: 5, rim: -6, front: [] }],
    } }] };
    const d = await drawFurniture("나무 걸상", "낮고 넓다");
    expect(d?.uses).toEqual([{ u: "perch", y: -11, x0: -11.5, x1: 11.5 }]);
    const first = h.sent[0];
    expect(first).toContain("그릴 가구: 나무 걸상");
    expect(first).toContain("고양이 키가 12칸");
    expect(first).toContain("furniture_uses");
    for (const w of ["본보기", "도토리", "단풍잎", "열쇠", "소파", "상자", "캣타워", "의자", "탁자"]) expect(first).not.toContain(w);
  });
  it("못 그렸거나 가구라기엔 너무 낮으면 null", async () => {
    h.reply = null;
    expect(await drawFurniture("x")).toBeNull();
    h.reply = { text: "", toolCalls: [{ name: "furniture_draw", params: { furniture_shape: { parts: [rr(0, -1, 20, 2)] }, furniture_uses: [] } }] };
    expect(await drawFurniture("깔개")).toBeNull();
  });
});
