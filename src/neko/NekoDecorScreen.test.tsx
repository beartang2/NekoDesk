// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

/** 마당 선물 창(NekoDecorScreen): 액자만 걸고 나머지는 떨어지고, 빨리 놓으면 던진다(사용자: 마당에선 물건이 다 액자처럼 걸린다) */
const h = vi.hoisted(() => ({ handlers: new Map<string, (e: { payload: unknown }) => void>(), emitTo: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: h.emitTo }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ listen: (ev: string, cb: (e: { payload: unknown }) => void) => { h.handlers.set(ev, cb); return Promise.resolve(() => {}); } }),
}));
vi.mock("./engine/decor-draw", async (orig) => ({ ...(await orig<object>()), drawDecor: () => {} })); // jsdom 엔 캔버스 그리기가 없다

import { NekoDecorScreen } from "./NekoDecorScreen";
import { decorBoxes, type DecorItem } from "./engine/decor-draw";

const shape = { v: 1, parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "red" }] };
const frameOf = (items: DecorItem[]) => ({ items, W: 1000, H: 600, floorY: 560, scale: 1, dark: false, screen: "M" });
const toy: DecorItem = { id: "a", shape, size: "small", surface: "floor", u: 0.3, at: "screen" };
const pic: DecorItem = { id: "p", shape, size: "small", surface: "floor", u: 0.6, at: "screen", frame: true };

let clock = 0;
beforeAll(() => {
  window.matchMedia = (() => ({ addEventListener() {}, removeEventListener() {}, matches: false })) as unknown as typeof window.matchMedia;
  globalThis.PointerEvent = class extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; }
  } as unknown as typeof PointerEvent;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  h.emitTo.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const items = (list: DecorItem[]) => act(() => h.handlers.get("neko-decor-items")!({ payload: frameOf(list) }));
const pe = (type: string, x: number, y: number) => act(() => { window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1 })); });
/** 그 선물 칸 가운데를 잡아 dx·dy 만큼 n 번에 끌고(한 번에 ms) pause 만큼 멈췄다 놓는다 */
function drag(it: DecorItem, dx: number, dy: number, n: number, ms: number, pause = 0) {
  const [b] = decorBoxes([it], { W: 1000, floorY: 560, scale: 1 }), x = b.x + b.w / 2, y = b.y + b.h / 2;
  pe("pointerdown", x, y);
  for (let k = 1; k <= n; k++) { clock += ms; pe("pointermove", x + (dx * k) / n, y + (dy * k) / n); }
  clock += pause;
  pe("pointerup", x + dx, y + dy);
}
const sent = (ev: string) => h.emitTo.mock.calls.filter((c) => (c as unknown[])[1] === ev).map((c) => (c as unknown[])[2] as Record<string, unknown>);
const run = (ms: number) => act(() => { for (let t = 0; t < ms; t += 16) { clock += 16; vi.advanceTimersByTime(16); } });

describe("마당 선물 창의 물리(0.1.32)", () => {
  it("빨리 놓으면 날아가 굴러가다 선 자리·각도를 저장하고, 고양이가 쫓게 알린다(모니터를 넘지 않는다)", () => {
    render(<NekoDecorScreen />);
    items([toy]);
    drag(toy, 240, -120, 4, 16);
    expect(sent("neko-decor-move")).toEqual([]); // 날아가는 중
    run(8000);
    const [m] = sent("neko-decor-move");
    expect(m).toMatchObject({ id: "a", screen: "M", surface: "floor" });
    expect(Math.abs((m.u as number) - 0.3)).toBeGreaterThan(0.05); // 놓은 자리에서 굴러갔다(오른쪽 끝에서 튕겨 돌아올 수도)
    expect(m.u as number).toBeGreaterThanOrEqual(0);
    expect(m.u as number).toBeLessThanOrEqual(1); // 모니터 안
    expect(Math.abs(m.rot as number)).toBeGreaterThan(0.1);
    expect(sent("neko-decor-thrown")).toEqual([{ id: "a", screen: "M" }]);
  });

  it("천천히 공중에 놓으면 바닥으로 떨어져 그 가로 자리에 선다(던지기 아님 — 쫓지 않는다)", () => {
    render(<NekoDecorScreen />);
    items([toy]);
    drag(toy, 0, -300, 6, 60, 200); // 잠깐 멈췄다 놓았다
    run(3000);
    const [m] = sent("neko-decor-move");
    expect(m).toMatchObject({ surface: "floor" });
    expect(m.u as number).toBeCloseTo(0.3, 1);
    expect(sent("neko-decor-thrown")).toEqual([]);
  });

  it("액자는 공중에 놓으면 그 자리에 건다(지금처럼)", () => {
    render(<NekoDecorScreen />);
    items([pic]);
    drag(pic, 0, -300, 6, 60);
    expect(sent("neko-decor-move")[0]).toMatchObject({ id: "p", surface: "wall" });
  });

  it("메인 창이 알린 떨어질 점(선물함·다른 모니터에서 공중에 놓음)은 보이기만 한다 — 이미 바닥 자리로 저장돼 다시 저장하지 않는다", () => {
    render(<NekoDecorScreen />);
    items([toy]);
    act(() => h.handlers.get("neko-decor-fall")!({ payload: { id: "a", x: 300, y: 100 } }));
    run(3000);
    expect(sent("neko-decor-move")).toEqual([]);
  });
});
