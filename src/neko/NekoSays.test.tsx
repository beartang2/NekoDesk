// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { NekoSays, shownSays } from "./NekoSays";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("네코 첫마디 말풍선(NekoSays)", () => {
  it("글: 모델 태그를 떼고, 반쪽만 남은 이모지(서로게이트)를 버린다 — 폰에서 깨진 글자로 보였다(사용자)", () => {
    expect(shownSays("안녕 [[PET_STATE:happy]]")).toBe("안녕");
    expect(shownSays("왔구나 \uD83D")).toBe("왔구나");
    expect(shownSays("\uDE3A 냥")).toBe("냥");
    expect(shownSays("좋아 😺 냥")).toBe("좋아 😺 냥");
  });

  it("머리 위를 따라가되 무대(마당은 창) 밖으로 안 나간다: 끝에선 안쪽으로, 위에 자리가 없으면 아래로", () => {
    // jsdom 은 배치를 안 한다 — 말풍선 크기만 적는다(120×40). 창은 1024×768
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("neko-says") ? 120 : 0; });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("neko-says") ? 40 : 0; });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0); // 한 번만 잰다
    const at = (head: { x: number; y: number; r: number }) => {
      const { container } = render(<NekoSays text="오래 기다렸어" mode="stage" fixed head={() => head} />);
      const el = container.querySelector<HTMLElement>(".neko-says")!;
      cleanup();
      return el.style.translate.split(" ").map((v) => parseFloat(v));
    };
    expect(at({ x: 500, y: 500, r: 30 })).toEqual([440, 422]); // 머리 위 가운데: 500 − 60, 500 − 30 − 8 − 40
    expect(at({ x: 10, y: 500, r: 30 })[0]).toBe(6); // 왼쪽 끝 → 안쪽
    expect(at({ x: 1020, y: 500, r: 30 })[0]).toBe(1024 - 120 - 6); // 오른쪽 끝 → 안쪽
    expect(at({ x: 500, y: 40, r: 30 })[1]).toBe(6); // 위에 자리가 없다 → 아래로 밀려 창 안
  });

  it("폰 세로: 채팅 화면 위쪽 가운데 자리(스크립트가 옮기지 않는다)", () => {
    const { container } = render(<NekoSays text="안녕" mode="top" />);
    const el = container.querySelector<HTMLElement>(".neko-says")!;
    expect(el.classList.contains("neko-says--top")).toBe(true);
    expect(el.style.translate).toBe("");
    expect(el.getAttribute("role")).toBe("status");
  });
});
