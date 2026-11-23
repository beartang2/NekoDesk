// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { Profiler, useRef, type MutableRefObject } from "react";
import { render, act, fireEvent } from "@testing-library/react";
import { ScrollBottomButton } from "./ScrollBottomButton";

/** 목록(무거운 쪽) 옆에 버튼. 버튼 보이기는 bind 로 — 목록·부모는 다시 그리지 않아야 한다 */
function Chat({ onList, onBtn, out, onClick }: { onList: () => void; onBtn: () => void; out: { bind?: MutableRefObject<(s: boolean) => void> }; onClick: () => void }) {
  const bind = useRef<(s: boolean) => void>(() => {});
  out.bind = bind;
  return (<>
    <Profiler id="list" onRender={onList}><div className="chat-messages" /></Profiler>
    <Profiler id="btn" onRender={onBtn}><ScrollBottomButton bind={bind} onClick={onClick} /></Profiler>
  </>);
}

describe("맨 아래로 버튼(사용자: 버튼이 뜰 때 스크롤이 살짝 버벅인다)", () => {
  it("보이고 숨는 건 버튼만 다시 그린다 — 목록은 그대로, 같은 값을 스크롤마다 알려도 다시 그리지 않는다", () => {
    const onList = vi.fn(), onBtn = vi.fn(), onClick = vi.fn(), out: { bind?: MutableRefObject<(s: boolean) => void> } = {};
    const { container } = render(<Chat onList={onList} onBtn={onBtn} out={out} onClick={onClick} />);
    const list0 = onList.mock.calls.length, btn0 = onBtn.mock.calls.length;
    act(() => out.bind!.current(true));
    const btn = container.querySelector(".chat-scroll-btn")!;
    expect(btn).not.toBeNull();
    expect(btn.hasAttribute("data-leaving")).toBe(false);
    const btn1 = onBtn.mock.calls.length;
    for (let i = 0; i < 30; i++) act(() => out.bind!.current(true)); // 스크롤마다 같은 값
    expect(onBtn.mock.calls.length).toBe(btn1);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => out.bind!.current(false));
    expect(container.querySelector(".chat-scroll-btn")!.hasAttribute("data-leaving")).toBe(true); // 퇴장 애니메이션 동안 붙어 있다
    // jsdom 엔 AnimationEvent 가 없어 React 가 접두 붙은 이름으로 듣는다 — 둘 다 보낸다
    act(() => { for (const t of ["animationend", "webkitAnimationEnd"]) container.querySelector(".chat-scroll-btn")?.dispatchEvent(new Event(t, { bubbles: true })); });
    expect(container.querySelector(".chat-scroll-btn")).toBeNull();
    expect(onList.mock.calls.length).toBe(list0); // 목록은 한 번도 다시 그리지 않았다
    expect(onBtn.mock.calls.length).toBeGreaterThan(btn0);
  });
});
