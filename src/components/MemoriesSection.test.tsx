// @vitest-environment jsdom

import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { MemoriesSection, MindNotesSection } from "./SettingsModal";
import { useSettingsStore } from "../stores/settingsStore";

const memories = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, kind: "fact", content: `기억 ${i + 1} — 아주 긴 내용`, created_at: "2026-11-20", use_count: 0 }));
const heart = { v: 1, traits: [
  { id: "t1", kind: "like", text: "창가에서 햇볕 쬐며 꼬리를 천천히 흔드는 오후, 아주 긴 좋아함 줄", since: "2026-11-20", at: "2026-11-22", n: 3 },
  { id: "t2", kind: "secret", text: "몰래 숨겨 둔 비밀", since: "2026-11-21", at: "2026-11-21", n: 1 },
] };
const mind = { v: 1, notes: Array.from({ length: 7 }, (_, i) => ({ at: `2026-11-${10 + i}T09:00:00Z`, kind: "wonder", text: `궁금 ${i + 1}`, why: "까닭" })), topics: [] };

afterEach(cleanup);
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: { key?: string }) => {
    if (cmd === "memory_list") return memories;
    if (cmd === "settings_get") return args?.key === "neko_mind" ? JSON.stringify(mind) : args?.key === "neko_heart" ? JSON.stringify(heart) : null;
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

it("속마음 노트: 접힌 칸 안에 있고(속마음이 아니라 정리의 재료), 줄을 누르면 펼치고, 쪽을 넘기면 접힌다", async () => {
  render(<MindNotesSection />);
  // 최근 것이 위
  const row = await screen.findByRole("button", { name: /궁금 7/ });
  expect((row.closest("details") as HTMLDetailsElement).open).toBe(false);
  expect(screen.getByText("최근 노트 7개")).toBeTruthy();
  expect(row.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(row);
  expect(expanded(/궁금 7/)).toBe("true");
  expect(row.closest(".rule-row")?.classList.contains("memory-row--open")).toBe(true);
  expect(within(row.closest(".rule-row") as HTMLElement).getByText("궁금 7")).toBeTruthy(); // 옛 노트의 까닭 칸은 안 읽는다
  fireEvent.click(screen.getByRole("button", { name: "다음 5개" }));
  fireEvent.click(screen.getByRole("button", { name: "이전 5개" }));
  expect(expanded(/궁금 7/)).toBe("false");
});

it("속마음: 줄을 누르면 펼친다(사용자: 좋아함 목록을 눌러도 안 펼쳐진다). 옛 갈래는 새 갈래로 보이고, 비밀은 접힌 칸 안에 있다", async () => {
  const { container } = render(<MindNotesSection />);
  const row = await screen.findByRole("button", { name: /창가에서 햇볕/ });
  expect(within(row.closest(".rule-row") as HTMLElement).getByText("관심사")).toBeTruthy(); // 옛 좋아함 → 관심사
  expect(row.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(row);
  expect(expanded(/창가에서 햇볕/)).toBe("true");
  expect(row.closest(".rule-row")?.classList.contains("memory-row--open")).toBe(true);
  fireEvent.click(row);
  expect(expanded(/창가에서 햇볕/)).toBe("false");
  const secret = container.querySelector("details.memory-tidy-log") as HTMLDetailsElement;
  expect(secret.open).toBe(false);
  expect(within(secret).getByText("몰래 숨겨 둔 비밀")).toBeTruthy(); // 접힌 칸 안(펼쳐야 보인다)
});
