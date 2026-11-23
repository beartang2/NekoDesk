// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, fireEvent, cleanup, act } from "@testing-library/react";

/** 빈 방의 선물(RoomGifts): 엔진 없이도 끌어 옮기고, 우클릭·꾹 누르기로 '정리' 메뉴 자리를 알린다(폰은 방이 늘 이 그림) */
const h = vi.hoisted(() => ({
  place: vi.fn(),
  gifts: [{ id: "g", title: "", body: "", at: "", size: "medium", shape: { v: 1, parts: [{ t: "circle", x: 0, y: -8, r: 8, c: "gray" }] }, placed: { at: "sidebar", surface: "floor", u: 0.5 } }],
}));
vi.mock("./gifts", () => ({
  useNekoGifts: Object.assign((sel: (s: unknown) => unknown) => sel({ gifts: h.gifts }), { getState: () => ({ place: h.place }) }),
  decorItems: (gs: typeof h.gifts, at: string) => gs.filter((g) => g.placed.at === at).map((g) => ({ ...g.placed, id: g.id, shape: g.shape, size: g.size, at })),
}));
vi.mock("./WeatherWindow", () => ({ WeatherWindow: () => null }));
vi.mock("./engine/decor-draw", async (orig) => ({ ...(await orig<object>()), drawDecor: () => {} })); // jsdom 엔 캔버스 그리기가 없다

import { RoomGifts } from "./NekoRoom";

beforeAll(() => {
  // 방 280×200: 바닥 194, S 0.81 → 가운데(u 0.5) 선물은 x 140, 바닥 194, 높이 약 78
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 280 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });
  globalThis.ResizeObserver = class { cb: () => void; constructor(cb: () => void) { this.cb = cb; } observe() { this.cb(); } disconnect() {} } as unknown as typeof ResizeObserver;
  // jsdom 에 PointerEvent 가 없어 fireEvent 가 pointerId·pointerType 을 못 싣는다
  globalThis.PointerEvent = class extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; }
  } as unknown as typeof PointerEvent;
});
afterEach(() => { cleanup(); h.place.mockClear(); vi.useRealTimers(); vi.restoreAllMocks(); });
/** 시계(performance.now): 끌다 멈춰 놓기·던지기는 놓기 전에 손이 멈춰 있던 시간으로 가른다 */
let clock = 0;
beforeEach(() => { clock = 1000; vi.spyOn(performance, "now").mockImplementation(() => clock); });

const ON = { clientX: 140, clientY: 160 };

describe("빈 방의 선물(RoomGifts)", () => {
  it("벽에 건 선물 캔버스 → 가구(children) → 나머지 선물 캔버스 순으로 겹친다(사용자: 가구 위에 액자가 걸리지 않게)", () => {
    const { container } = render(<RoomGifts isDark={false}><i data-mid="" /></RoomGifts>);
    expect([...container.children].map((e) => e.getAttribute("class") ?? e.tagName)).toEqual(["neko-room__gifts neko-room__gifts--wall", "I", "neko-room__gifts"]);
  });
  it("마우스로 끌어 놓으면 그 자리를 선물함에 적고, 움직이지 않고 떼면 그대로", () => {
    const cv = render(<RoomGifts isDark={false} />).container.querySelector("canvas:not(.neko-room__gifts--wall)")!;
    fireEvent.pointerDown(cv, { ...ON, button: 0, pointerId: 1, pointerType: "mouse" });
    expect(document.documentElement.dataset.holding).toBe("1"); // 잡은 동안 폰 가장자리 손짓을 막는다(lib/phone.ts)
    fireEvent.pointerMove(cv, { clientX: 60, clientY: 160, pointerId: 1, pointerType: "mouse" });
    clock += 200; // 옮기고 잠깐 멈췄다 놓는다(던지지 않는다)
    fireEvent.pointerUp(cv, { clientX: 60, clientY: 160, pointerId: 1, pointerType: "mouse" });
    expect(document.documentElement.dataset.holding).toBeUndefined();
    expect(h.place).toHaveBeenCalledTimes(1);
    expect(h.place.mock.calls[0][0]).toBe("g");
    expect(h.place.mock.calls[0][1]).toMatchObject({ surface: "floor" });
    expect(h.place.mock.calls[0][1].u).toBeLessThan(0.5);
    expect(h.place.mock.calls[0][1].rot).toBeUndefined(); // 집어 옮기면 똑바로(각도 없음 = 0)
    fireEvent.pointerDown(cv, { ...ON, button: 0, pointerId: 2, pointerType: "mouse" });
    fireEvent.pointerUp(cv, { ...ON, pointerId: 2, pointerType: "mouse" });
    expect(h.place).toHaveBeenCalledTimes(1);
  });

  it("터치로 꾹 누르면(0.5초) 끌기를 접고 '정리' 메뉴 자리를 알린다. 움직이면 그냥 끌기", () => {
    vi.useFakeTimers();
    const onMenu = vi.fn();
    const cv = render(<RoomGifts isDark={false} onMenu={onMenu} />).container.querySelector("canvas:not(.neko-room__gifts--wall)")!;
    fireEvent.pointerDown(cv, { ...ON, button: 0, pointerId: 3, pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(520); });
    expect(onMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "g" }));
    expect(document.documentElement.dataset.holding).toBeUndefined(); // 메뉴가 뜨면 잡기는 끝
    fireEvent.pointerUp(cv, { ...ON, pointerId: 3, pointerType: "touch" });
    expect(h.place).not.toHaveBeenCalled();

    onMenu.mockClear();
    fireEvent.pointerDown(cv, { ...ON, button: 0, pointerId: 4, pointerType: "touch" });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 160, pointerId: 4, pointerType: "touch" });
    act(() => { vi.advanceTimersByTime(600); }); clock += 600;
    fireEvent.pointerUp(cv, { clientX: 200, clientY: 160, pointerId: 4, pointerType: "touch" });
    expect(onMenu).not.toHaveBeenCalled();
    expect(h.place.mock.calls[0][1].u).toBeGreaterThan(0.5);
  });

  it("우클릭은 선물 위에서만 메뉴(기본 메뉴를 막는다), 빈 데선 아무것도 안 한다", () => {
    const onMenu = vi.fn();
    const cv = render(<RoomGifts isDark={false} onMenu={onMenu} />).container.querySelector("canvas:not(.neko-room__gifts--wall)")!;
    expect(fireEvent.contextMenu(cv, ON)).toBe(false); // preventDefault
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(fireEvent.contextMenu(cv, { clientX: 10, clientY: 20 })).toBe(true);
    fireEvent.pointerDown(cv, { clientX: 10, clientY: 20, button: 0, pointerId: 5, pointerType: "touch" });
    fireEvent.pointerUp(cv, { clientX: 10, clientY: 20, pointerId: 5, pointerType: "touch" });
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(h.place).not.toHaveBeenCalled();
  });

  it("액자 아닌 물건을 벽 쪽으로 끌어 놓으면 떨어져 바닥에 놓인다(0.1.24)", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const cv = render(<RoomGifts isDark={false} />).container.querySelector("canvas:not(.neko-room__gifts--wall)")!;
    fireEvent.pointerDown(cv, { ...ON, button: 0, pointerId: 6, pointerType: "mouse" });
    fireEvent.pointerMove(cv, { clientX: 150, clientY: 110, pointerId: 6, pointerType: "mouse" });
    fireEvent.pointerMove(cv, { clientX: 160, clientY: 60, pointerId: 6, pointerType: "mouse" });
    fireEvent.pointerUp(cv, { clientX: 160, clientY: 60, pointerId: 6, pointerType: "mouse" });
    expect(h.place).not.toHaveBeenCalled(); // 떨어지는 중
    act(() => { vi.advanceTimersByTime(3000); });
    expect(h.place).toHaveBeenCalledTimes(1);
    expect(h.place.mock.calls[0][1]).toMatchObject({ surface: "floor" });
  });

  it("휙 던지면 날아가 떨어져 굴러가다 선 자리를 적는다(던지기, 사용자). 놓은 자리보다 멀리 간다", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const cv = render(<RoomGifts isDark={false} />).container.querySelector("canvas:not(.neko-room__gifts--wall)")!;
    fireEvent.pointerDown(cv, { ...ON, button: 0, pointerId: 7, pointerType: "mouse" });
    fireEvent.pointerMove(cv, { clientX: 170, clientY: 150, pointerId: 7, pointerType: "mouse" });
    fireEvent.pointerMove(cv, { clientX: 200, clientY: 140, pointerId: 7, pointerType: "mouse" });
    fireEvent.pointerUp(cv, { clientX: 200, clientY: 140, pointerId: 7, pointerType: "mouse" });
    expect(h.place).not.toHaveBeenCalled(); // 날아가는 중
    act(() => { vi.advanceTimersByTime(8000); });
    expect(h.place).toHaveBeenCalledTimes(1);
    expect(h.place.mock.calls[0][1]).toMatchObject({ surface: "floor" });
    expect(h.place.mock.calls[0][1].u).toBeGreaterThan(0.75); // 놓은 자리(200 → 0.7 쯤)보다 오른쪽으로 굴러갔다
    expect(Math.abs(h.place.mock.calls[0][1].rot)).toBeGreaterThan(0.5); // 굴러간 만큼 돈 각도도 적는다
  });
});
