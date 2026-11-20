// @vitest-environment jsdom

import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { MemoriesSection, MindNotesSection } from "./SettingsModal";
import { useSettingsStore } from "../stores/settingsStore";

const memories = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, kind: "fact", content: `기억 ${i + 1} — 아주 긴 내용`, created_at: "2026-11-20", use_count: 0 }));
const mind = { v: 1, notes: Array.from({ length: 7 }, (_, i) => ({ at: `2026-11-${10 + i}T09:00:00Z`, kind: "wonder", text: `궁금 ${i + 1}`, why: "까닭" })), topics: [] };

afterEach(cleanup);
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: { key?: string }) => {
    if (cmd === "memory_list") return memories;
    if (cmd === "settings_get") return args?.key === "neko_mind" ? JSON.stringify(mind) : null;
    return null;
  });
  useSettingsStore.setState({ nekoName: "나비" });
});

const expanded = (name: RegExp) => screen.getByRole("button", { name }).getAttribute("aria-expanded");

it("기억: 제목에 고양이 이름(조사는 받침대로), 펼친 줄은 쪽을 넘기면 다 접힌다(돌아와도)", async () => {
  render(<MemoriesSection />);
  expect(screen.getByRole("heading", { name: "나비가 기억하는 것" })).toBeTruthy();
  await screen.findByText("기억 1 — 아주 긴 내용");
  fireEvent.click(screen.getByRole("button", { name: /기억 1 —/ }));
  fireEvent.click(screen.getByRole("button", { name: /기억 2 —/ }));
  expect(expanded(/기억 1 —/)).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "다음 5개" }));
  fireEvent.click(screen.getByRole("button", { name: /기억 6 —/ }));
  expect(expanded(/기억 6 —/)).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "이전 5개" }));
  expect(expanded(/기억 1 —/)).toBe("false");
  expect(expanded(/기억 2 —/)).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "다음 5개" }));
  expect(expanded(/기억 6 —/)).toBe("false");
});

it("속마음: 줄을 누르면 펼치고, 쪽을 넘기면 접힌다", async () => {
  render(<MindNotesSection />);
  // 최근 것이 위
  const row = await screen.findByRole("button", { name: /궁금 7/ });
  expect(row.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(row);
  expect(expanded(/궁금 7/)).toBe("true");
  expect(row.closest(".rule-row")?.classList.contains("memory-row--open")).toBe(true);
  expect(within(row.closest(".rule-row") as HTMLElement).getByText(/궁금 7 — 까닭/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "다음 5개" }));
  fireEvent.click(screen.getByRole("button", { name: "이전 5개" }));
  expect(expanded(/궁금 7/)).toBe("false");
});
