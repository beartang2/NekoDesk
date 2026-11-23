// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
import { topNeed } from "./windowMin";

/** 높이·폭을 정해 둔 상자(jsdom 은 배치를 안 한다) */
function box(cls: string, h: number, kids: HTMLElement[] = [], style = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  el.setAttribute("style", style);
  for (const [k, v] of [["offsetHeight", h], ["offsetWidth", 200], ["clientHeight", h]] as const) Object.defineProperty(el, k, { value: v });
  kids.forEach((k) => el.appendChild(k));
  return el;
}

describe("창 최소 높이(위쪽 칸)", () => {
  it("대화 목록은 몇 줄만, 그림판은 제목 줄만, 오른쪽 패널은 접힌 모양으로 센다", () => {
    const sidebar = box("sidebar", 403, [
      box("sidebar__sessions", 200, [box("sidebar__list", 150)]),
      box("panel-card panel-card--draw", 33, [box("panel-card__header", 33)]),
      box("cat-panel", 253),
    ], "padding-top: 3px; padding-bottom: 8px; row-gap: 8px");
    const right = box("right-panel", 403, [
      box("panel-card", 56),
      box("panel-card panel-card--calendar", 216),
      box("panel-card", 35, [box("pomo-body", 161)]), // 접힌 포모도로: 본문은 숨은 칸
      box("panel-card panel-card--memo", 202),
    ], "padding-top: 3px; padding-bottom: 8px; row-gap: 8px");
    const main = box("main", 392, [box("chat-dock", 70)]);
    const app = box("app", 680, [box("titlebar", 40), sidebar, main, right, box("neko-slot neko-slot--dock", 240)]);
    document.body.replaceChildren(app);
    const t = topNeed()!;
    expect(t.row).toBe(400);
    // 사이드바: 3 + (200 - 150 + 72) + 33 + 253 + 8 + 틈 2개(16) = 427, 칸이 줄보다 3 크다(위 여백 -3) → 424
    // 오른쪽: 3 + 56 + 216 + 35 + 메모 100 + 8 + 틈 3개(24) = 442 → 439. 채팅: 70 + 120 = 190 → 198
    expect(t.need).toBe(439);
    expect(t.dock).toBe(240);
  });
});
