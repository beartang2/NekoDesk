import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

import { toNotificationBody } from "./notify";

describe("toNotificationBody", () => {
  it("마크다운 흔적을 걷어낸다", () => {
    expect(toNotificationBody("**볼륨**을 `30` 으로 맞췄어. [링크](https://x.y)")).toBe("볼륨을 30 으로 맞췄어. 링크");
  });

  it("코드 블록은 통째로 (코드) 로 줄인다", () => {
    expect(toNotificationBody("실행했어\n```python\nprint(1)\n```\n끝")).toBe("실행했어 (코드) 끝");
  });

  it("표는 구분선을 빼고 칸 내용만 남긴다", () => {
    expect(toNotificationBody("| 이름 | 값 |\n| --- | --- |\n| a | 1 |")).toBe("이름 값 a 1");
  });

  it("길면 말줄임표로 자른다", () => {
    const out = toNotificationBody("가".repeat(300), 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("…")).toBe(true);
  });
});
