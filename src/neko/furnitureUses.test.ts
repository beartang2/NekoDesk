import { describe, expect, it } from "vitest";
import { CAT_U, checkFurniture, oldFurnitureAsFree } from "./furnitureUses";

/** 자유 가구 쓰임새 검사·보정(docs/neko-furniture-free.md §6). 고양이 키 = 12칸 */
const c = "brown";
const rr = (x: number, y: number, w: number, h: number) => ({ t: "rrect", x, y, w, h, rad: 0, rot: 0, c });
// 탁자 꼴: 상판(윗면 y −11, 가로 ±12)과 다리 둘
const TABLE = { parts: [rr(0, -10, 24, 2), rr(-10, -4.5, 2, 9), rr(10, -4.5, 2, 9)] };

describe("올라앉기(perch)", () => {
  it("대충 짚은 면을 윗선의 평평한 구간에 붙인다 — 높이는 윗선, 가로는 구간 끝에서 반 칸 안쪽", () => {
    const r = checkFurniture(TABLE, [{ u: "perch", y: -13, x0: -6, x1: 9, soft: true }])!;
    expect(r.uses).toEqual([{ u: "perch", y: -11, x0: -11.5, x1: 11.5, soft: true }]);
  });
  it("지붕 아래(칸막이 안 바닥)·뛰어오를 수 없는 높이·평평한 데가 없는 자리는 버린다", () => {
    const cubby = { parts: [rr(0, -1, 24, 2), rr(0, -13, 24, 2), rr(-11, -7, 2, 14), rr(11, -7, 2, 14)] }; // 위가 막힌 칸
    expect(checkFurniture(cubby, [{ u: "perch", y: -2, x0: -8, x1: 8 }])!.uses).toEqual([]);
    const tall = { parts: [rr(0, -21, 20, 2), rr(0, -10, 2, 20)] }; // 윗면 22칸 = 고양이 1.8배
    expect(checkFurniture(tall, [{ u: "perch", y: -22, x0: -9, x1: 9 }])!.uses).toEqual([]);
    expect(checkFurniture(TABLE, [{ u: "perch", y: -5, x0: -6, x1: 6 }])!.uses).toEqual([]); // 상판 아래 허공
  });
  it("높이가 다른 면은 여럿, 같은 면을 두 번 짚으면 하나", () => {
    const steps = { parts: [rr(-6, -4, 12, 8), rr(6, -8, 12, 16)] };
    const r = checkFurniture(steps, [{ u: "perch", y: -8, x0: -11, x1: -1 }, { u: "perch", y: -16, x0: 1, x1: 11 }, { u: "perch", y: -16, x0: 2, x1: 10 }])!;
    expect(r.uses.map((u) => u.u === "perch" && u.y)).toEqual([-8, -16]);
  });
});

describe("들어가 숨기(inside)", () => {
  const BOX = { parts: [rr(0, -6, 18, 12), rr(0, -4, 18, 8)] }; // 0 = 뒤 벽(테두리 −12), 1 = 앞벽(테두리 −8)
  it("앞 겹 윗선으로 테두리를, 테두리 아래 줄의 앞벽 끝으로 입구 폭을 맞춘다 — 없는 도형 번호·겹친 번호는 뺀다", () => {
    const r = checkFurniture(BOX, [{ u: "inside", x0: -7, x1: 7, rim: -10, front: [1, 1, 9] }])!;
    expect(r.uses).toEqual([{ u: "inside", x0: -9, x1: 9, rim: -8, front: [1] }]);
  });
  it("앞 겹이 없거나 입구 아래를 덜 덮거나 입구가 좁으면 버린다", () => {
    expect(checkFurniture(BOX, [{ u: "inside", x0: -7, x1: 7, rim: -8, front: [] }])!.uses).toEqual([]);
    const thin = { parts: [rr(0, -6, 18, 12), rr(-8, -4, 2, 8), rr(8, -4, 2, 8)] }; // 앞은 기둥 둘뿐
    expect(checkFurniture(thin, [{ u: "inside", x0: -8, x1: 8, rim: -8, front: [1, 2] }])!.uses).toEqual([]);
    const narrow = { parts: [rr(0, -6, 6, 12), rr(0, -4, 6, 8)] }; // 입구 폭 고양이 0.5배
    expect(checkFurniture(narrow, [{ u: "inside", x0: -3, x1: 3, rim: -8, front: [1] }])!.uses).toEqual([]);
  });
});

describe("발톱 긁기·매달린 것 치기", () => {
  const POST = { parts: [rr(-6, -8, 4, 16), rr(2, -1, 16, 2), { t: "line", pts: [[8, -16], [8, -12]], w: 0.6, c }, { t: "circle", x: 8, y: -11, r: 1.2, c: "red" }, rr(2, -16, 16, 2)] };
  it("바닥부터 이어진 옆면에서 긁고, 매달린 점은 가까운 칠한 점으로 옮긴다", () => {
    const r = checkFurniture(POST, [{ u: "scratch", side: "left" }, { u: "bat", x: 8.6, y: -10.6 }])!;
    expect(r.uses[0]).toMatchObject({ u: "scratch", side: "left", x: -8 });
    expect((r.uses[0] as { top: number }).top).toBeLessThanOrEqual(-0.4 * CAT_U);
    expect(r.uses[1]).toMatchObject({ u: "bat" });
    const b = r.uses[1] as { x: number; y: number };
    expect(Math.hypot(b.x - 8.6, b.y + 10.6)).toBeLessThan(1.8);
  });
  it("바닥에 안 닿는 옆면·칠하지 않은 곳·몸통 속 점은 버린다", () => {
    const pole = { parts: [rr(0, -1.5, 20, 3), rr(-8, -12, 2, 18)] }; // 낮은 받침 + 왼쪽 기둥: 오른쪽 옆면은 받침 높이(3칸)뿐
    expect(checkFurniture(pole, [{ u: "scratch", side: "right" }])!.uses).toEqual([]);
    expect(checkFurniture(pole, [{ u: "scratch", side: "left" }])!.uses).toHaveLength(1); // 왼쪽은 받침 → 기둥으로 이어진다
    expect(checkFurniture(POST, [{ u: "bat", x: 0, y: -10 }])!.uses).toEqual([]); // 허공(2칸 안에 칠한 데 없음)
    const block = { parts: [rr(0, -8, 16, 16)] };
    expect(checkFurniture(block, [{ u: "bat", x: 0, y: -10 }])!.uses).toEqual([]); // 덩어리 속: 아래에 설 자리가 없다
  });
});

describe("모양", () => {
  it("바닥에서 뜬 모양은 내리고, 고양이 2배보다 높으면 줄인다(쓰임새도 같이)", () => {
    const floating = { parts: [rr(0, -14, 24, 2), rr(-10, -9, 2, 8), rr(10, -9, 2, 8)] }; // 맨 아래 −5
    const r = checkFurniture(floating, [{ u: "perch", y: -15, x0: -10, x1: 10 }])!;
    expect(r.uses).toEqual([{ u: "perch", y: -10, x0: -11.5, x1: 11.5 }]);
    const tall = { parts: [rr(0, -15, 6, 30), rr(0, -29, 20, 2)] }; // 키 30칸
    const t = checkFurniture(tall, [])!;
    const ys = t.shape.parts.map((p) => (p as { y: number; h: number }).y - (p as { h: number }).h / 2);
    expect(Math.min(...ys)).toBeCloseTo(-24, 0);
  });
  it("너무 낮거나 쓸 도형이 없으면 가구가 아니다", () => {
    expect(checkFurniture({ parts: [rr(0, -1.5, 20, 3)] }, [])).toBeNull();
    expect(checkFurniture({ parts: [] }, [])).toBeNull();
    expect(checkFurniture("엉망", [])).toBeNull();
  });
  it("같은 입력이면 같은 값, 고친 값을 다시 넣어도 그대로(읽을 때 또 돌린다)", () => {
    const raw = [{ u: "perch", y: -13, x0: -6, x1: 9 }, { u: "scratch", side: "right" }, { u: "bat", x: 3, y: -3 }, { u: "dance" }];
    const a = checkFurniture(TABLE, raw)!, b = checkFurniture(TABLE, raw)!;
    expect(a).toEqual(b);
    expect(checkFurniture(a.shape, a.uses)).toEqual(a);
  });
});

describe("이미 물어온 가구(결정 A)", () => {
  it("kind 기준 크기로 옮기고 가장 넓은 평평한 면 하나만 올라앉기로 — 면이 없으면 쓰임새 없음", () => {
    // 32칸에 꽉 찬 소파 그림(폭 30칸 → 소파 폭 2.2 고양이 = 26.4칸)
    const sofa = { parts: [rr(0, -12, 30, 8), rr(0, -5, 30, 6), rr(-14, -1, 2, 2), rr(14, -1, 2, 2)] };
    const s = oldFurnitureAsFree(sofa as never, "sofa")!;
    expect(s.uses).toHaveLength(1);
    expect(s.uses[0].u).toBe("perch");
    const lamp = { parts: [rr(0, -14, 1.5, 28), { t: "poly", pts: [[-6, -24], [6, -24], [3, -32], [-3, -32]], round: 0, c }] };
    expect(oldFurnitureAsFree(lamp as never, "lamp")!.uses).toEqual([]);
  });
});
