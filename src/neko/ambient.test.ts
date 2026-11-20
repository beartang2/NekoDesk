// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { appActivity, isTextInput, typingNow } from "./ambient";

describe("다른 앱 따라 하기: 맨 앞 앱 → 활동", () => {
  it("아는 앱만, 앞부분으로", () => {
    expect(appActivity("com.figma.Desktop")).toBe("draw");
    expect(appActivity("com.apple.Safari")).toBe("window");
    expect(appActivity("company.thebrowser.Browser")).toBe("window");
    expect(appActivity("com.jetbrains.intellij")).toBe("think");
    expect(appActivity("com.apple.finder")).toBe("dig");
    expect(appActivity("com.kakao.KakaoTalkMac")).toBeNull();
    expect(appActivity(null)).toBeNull();
  });
});

describe("글을 치는 중: 단축키엔 반응하지 않는다", () => {
  it("이 앱 안에선 글 입력 칸(input·textarea·contenteditable)에 포커스일 때만", () => {
    const text = document.createElement("input");
    const box = document.createElement("input"); box.type = "checkbox";
    const area = document.createElement("textarea");
    const ro = document.createElement("textarea"); ro.readOnly = true;
    const edit = document.createElement("div"); edit.setAttribute("contenteditable", "true");
    expect([text, area, edit].map(isTextInput)).toEqual([true, true, true]);
    expect([box, ro, document.createElement("button"), document.body, null].map(isTextInput)).toEqual([false, false, false, false, false]);
  });

  it("이 앱이 맨 앞이면 키 연타 + 입력 칸, 다른 앱이면 Rust 판정 그대로", () => {
    // 단축키(키 연타 아님)·입력 칸 밖 연타 → 아니다. 입력 칸에서 치면 맞다
    expect(typingNow({ own: true, keys: false, typing: false }, true)).toBe(false);
    expect(typingNow({ own: true, keys: true, typing: false }, false)).toBe(false);
    expect(typingNow({ own: true, keys: true, typing: false }, true)).toBe(true);
    // 다른 앱: Rust 가 키·입력 칸을 다 본 값
    expect(typingNow({ own: false, keys: true, typing: false }, true)).toBe(false);
    expect(typingNow({ own: false, keys: true, typing: true }, false)).toBe(true);
  });
});
