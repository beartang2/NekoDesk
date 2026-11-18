// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { appActivity } from "./ambient";

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
