// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { tableWheel } from "./tableWheel";

/** 대화 목록(세로로 밀림) 안의 표 감싸개. jsdom 엔 레이아웃이 없어 크기·스크롤 값을 적어 둔다 */
function setup() {
  const box = (el: HTMLElement, w: number, h: number, sw: number, sh: number) => {
    const at = { left: 0, top: 0 };
    Object.defineProperties(el, {
      clientWidth: { value: w }, clientHeight: { value: h }, scrollWidth: { value: sw }, scrollHeight: { value: sh },
      scrollLeft: { get: () => at.left, set: (v: number) => { at.left = Math.max(0, Math.min(sw - w, v)); } },
      scrollTop: { get: () => at.top, set: (v: number) => { at.top = Math.max(0, Math.min(sh - h, v)); } },
    });
    return el;
  };
  const chat = box(document.createElement("div"), 600, 400, 600, 2000), wrap = box(document.createElement("div"), 560, 180, 1400, 180);
  chat.style.overflowY = "auto";
  chat.appendChild(document.createElement("div")).appendChild(wrap);
  document.body.appendChild(chat);
  const off = tableWheel(wrap);
  const wheel = (deltaX: number, deltaY: number, o: WheelEventInit = {}) => {
    const e = new WheelEvent("wheel", { deltaX, deltaY, cancelable: true, bubbles: true, ...o });
    wrap.dispatchEvent(e);
    return e.defaultPrevented;
  };
  return { chat, wrap, wheel, off };
}

let done: (() => void) | null = null;
afterEach(() => { done?.(); done = null; document.body.replaceChildren(); });

describe("표 위 휠·트랙패드(lib/tableWheel)", () => {
  it("세로로 미는 손짓은 첫 움직임이 옆으로 조금 커도 대화 목록을 민다(사용자: 표 위에서 위아래 스크롤이 안 먹는다)", () => {
    const t = setup(); done = t.off;
    expect(t.wheel(3, 1)).toBe(true); // 첫 떨림: 모아 둔다
    t.wheel(1, 12); t.wheel(0, 12); t.wheel(1, 12);
    expect(t.chat.scrollTop).toBe(13 + 12 + 12); // 모은 세로 몫(1+12)을 한꺼번에, 그 뒤 12·12
    expect(t.wrap.scrollLeft).toBe(0);
  });

  it("옆으로 미는 손짓은 표를 민다(세로 떨림은 버린다)", () => {
    const t = setup(); done = t.off;
    t.wheel(10, 1); t.wheel(12, 0); t.wheel(12, 2);
    expect(t.wrap.scrollLeft).toBe(34);
    expect(t.chat.scrollTop).toBe(0);
  });

  it("마우스 휠 한 칸(줄 단위)은 바로 대화 목록으로, 핀치 확대(ctrl)는 브라우저에 둔다", () => {
    const t = setup(); done = t.off;
    t.wheel(0, 3, { deltaMode: 1 });
    expect(t.chat.scrollTop).toBe(48);
    expect(t.wheel(0, 5, { ctrlKey: true })).toBe(false);
  });
});
