import { describe, it, expect } from "vitest";
import { syncCanvasToBox } from "./canvas";

/** 실제 캔버스 없이 호출 기록만 남기는 가짜. jsdom 도 필요 없다. */
function fakeCanvas(box: { w: number; h: number }, bitmap = { w: 0, h: 0 }) {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const ctx = new Proxy(
    {},
    {
      get: (_t, fn: string) =>
        fn === "fillStyle" ? "" : (...args: unknown[]) => void calls.push({ fn, args }),
      set: () => true,
    }
  ) as unknown as CanvasRenderingContext2D;

  const canvas = {
    clientWidth: box.w,
    clientHeight: box.h,
    width: bitmap.w,
    height: bitmap.h,
    getContext: () => ctx,
    ownerDocument: {
      createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
    },
  } as unknown as HTMLCanvasElement;

  return { canvas, calls };
}

describe("syncCanvasToBox", () => {
  it("비트맵을 박스 크기 × 배율로 맞춘다", () => {
    const { canvas } = fakeCanvas({ w: 201, h: 158 });
    expect(syncCanvasToBox(canvas)).toBe(true);
    expect([canvas.width, canvas.height]).toEqual([402, 316]);
  });

  it("옮겨 담을 때 크기를 주지 않는다 — 주면 그림이 늘어난다", () => {
    // 이 프로젝트에서 리사이즈를 "고정 비트맵 가리기" 로 만들게 했던 바로 그 문제다.
    const { canvas, calls } = fakeCanvas({ w: 100, h: 50 }, { w: 100, h: 100 });
    syncCanvasToBox(canvas, 1);

    const draws = calls.filter((c) => c.fn === "drawImage");
    const restore = draws[draws.length - 1];
    expect(restore.args).toHaveLength(3); // (이미지, 0, 0)
    expect(restore.args.slice(1)).toEqual([0, 0]);
  });

  it("늘어난 자리는 흰색으로 채운다", () => {
    const { canvas, calls } = fakeCanvas({ w: 100, h: 200 }, { w: 100, h: 100 });
    syncCanvasToBox(canvas, 1);

    const fill = calls.find((c) => c.fn === "fillRect")!;
    expect(fill.args).toEqual([0, 0, 100, 200]);
  });

  it("크기가 그대로면 아무것도 안 한다 — 그릴 때마다 지워지면 안 된다", () => {
    const { canvas, calls } = fakeCanvas({ w: 100, h: 50 }, { w: 200, h: 100 });
    expect(syncCanvasToBox(canvas)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("아직 레이아웃이 안 잡힌 캔버스는 건드리지 않는다", () => {
    const { canvas, calls } = fakeCanvas({ w: 0, h: 0 });
    expect(syncCanvasToBox(canvas)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
