// @vitest-environment jsdom

import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
const startDrag = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@crabnebula/tauri-plugin-drag", () => ({ startDrag }));

import { Shelf } from "./RightPanel";

const items = ["a.txt", "b.png", "c.pdf", "d.zip"].map((name) => ({ name, path: `/shelf/${name}`, size: 10 }));

afterEach(cleanup);
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "shelf_list" ? items : null));
  startDrag.mockClear();
});

const opt = (n: string) => screen.getByRole("option", { name: new RegExp(n.replace(".", "\\.")) });
const sel = () => screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true").map((o) => o.querySelector(".shelf__name")?.textContent);

it("⌘·⇧ 로 여러 개 고르고, 고른 것을 끌면 한 번에 넘긴다. Esc 로 푼다", async () => {
  render(<Shelf />);
  await screen.findByText("a.txt");
  fireEvent.click(opt("b.png"));
  fireEvent.click(opt("d.zip"), { shiftKey: true });
  expect(sel()).toEqual(["b.png", "c.pdf", "d.zip"]);
  fireEvent.click(opt("c.pdf"), { metaKey: true });
  expect(sel()).toEqual(["b.png", "d.zip"]);
  fireEvent.dragStart(opt("d.zip"));
  expect(startDrag).toHaveBeenLastCalledWith(expect.objectContaining({ item: ["/shelf/b.png", "/shelf/d.zip"] }));
  // 안 고른 것을 끌면 그것만(그것을 고른다)
  fireEvent.dragStart(opt("a.txt"));
  expect(startDrag).toHaveBeenLastCalledWith(expect.objectContaining({ item: ["/shelf/a.txt"] }));
  expect(sel()).toEqual(["a.txt"]);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(sel()).toEqual([]);
});
