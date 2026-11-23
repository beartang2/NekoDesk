// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

/** 그림판(DrawingPadCard): 손가락(포인터)으로도 그린다 — 폰은 끌 때 마우스 이벤트가 안 와 안 그려졌다 */
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@crabnebula/tauri-plugin-drag", () => ({ startDrag: vi.fn() }));
vi.mock("../api/tauri", () => ({ todosApi: {}, scheduleApi: {}, settingsApi: { get: async () => null, set: async () => {} }, shelfApi: {} }));

import { DrawingPadCard } from "./RightPanel";

const ctx = { getImageData: vi.fn(() => ({})), putImageData: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillRect: vi.fn() };

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
  // jsdom 에 PointerEvent 가 없어 fireEvent 가 pointerId·pointerType 을 못 싣는다
  globalThis.PointerEvent = class extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; }
  } as unknown as typeof PointerEvent;
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 150 }) as DOMRect;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("그림판", () => {
  it("손가락으로 끌면 선이 그려지고, 그리는 중 두 번째 손가락은 무시한다. 마우스도 그대로", () => {
    const { container } = render(<DrawingPadCard />);
    const cv = container.querySelector("canvas.draw-canvas")!;
    const touch = (type: "pointerDown" | "pointerMove" | "pointerUp", id: number, x: number, y: number) =>
      fireEvent[type](cv, { clientX: x, clientY: y, pointerId: id, pointerType: "touch", button: 0 });
    touch("pointerDown", 1, 10, 10);
    touch("pointerDown", 2, 200, 100); // 두 번째 손가락
    touch("pointerMove", 1, 20, 20);
    touch("pointerMove", 2, 210, 110);
    touch("pointerMove", 1, 30, 30);
    touch("pointerUp", 2, 210, 110);
    touch("pointerUp", 1, 30, 30);
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    expect(ctx.getImageData).toHaveBeenCalledTimes(1); // 되돌리기 한 칸(첫 손가락 획만)
    touch("pointerMove", 1, 40, 40); // 뗀 뒤 움직임은 안 그린다
    expect(ctx.stroke).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(cv, { clientX: 5, clientY: 5, pointerId: 9, pointerType: "mouse", button: 0 });
    fireEvent.pointerMove(cv, { clientX: 15, clientY: 5, pointerId: 9, pointerType: "mouse" });
    fireEvent.pointerUp(cv, { clientX: 15, clientY: 5, pointerId: 9, pointerType: "mouse" });
    expect(ctx.stroke).toHaveBeenCalledTimes(3);
  });
});
