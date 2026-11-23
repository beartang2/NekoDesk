// @vitest-environment jsdom
import { it, expect } from "vitest";
import { springAt, todoPatch } from "./RightPanel";

it("스프링 체크는 0 에서 출발해 20% 넘쳤다가 1 에 선다 (reactbits bounce 0.2)", () => {
  expect(springAt(0)).toBeCloseTo(0, 5);
  const peak = Math.max(...Array.from({ length: 500 }, (_, i) => springAt(i / 1000)));
  expect(peak).toBeGreaterThan(1.17);
  expect(peak).toBeLessThan(1.23);
  expect(springAt(0.5)).toBe(1);
});

it("할 일 고치기는 바뀐 것만 보낸다: 날짜를 그대로 두면 시각까지 있던 마감은 그대로, 비우면 지운다", () => {
  const t = { id: 1, content: "우유", status: "open", priority: null, due_at: "2026-12-01T14:00:00", created_at: "", completed_at: null };
  expect(todoPatch(t, " 우유 ", "2026-12-01")).toBeNull();
  expect(todoPatch(t, "두유", "2026-12-01")).toEqual({ content: "두유", dueAt: undefined, clearDue: false });
  expect(todoPatch(t, "우유", "2026-12-03")).toEqual({ content: undefined, dueAt: "2026-12-03", clearDue: false });
  expect(todoPatch(t, "", "")).toEqual({ content: undefined, dueAt: undefined, clearDue: true });
  expect(todoPatch({ ...t, due_at: null }, "우유", "")).toBeNull();
});
