// @vitest-environment jsdom

import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const store = vi.hoisted(() => ({ value: null as string | null }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));

import { FurnitureTab } from "./FurnitureTab";
import { useNekoFurniture } from "./furniture";
import { useNekoStore } from "./nekoStore";

afterEach(cleanup);
beforeEach(() => {
  store.value = null;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: { key?: string; value?: string }) => {
    if (cmd === "settings_get") return args?.key === "neko_furniture" ? store.value : null;
    if (cmd === "settings_set" && args?.key === "neko_furniture") { store.value = args.value ?? null; return null; }
    return null;
  });
  useNekoFurniture.setState({ loaded: false });
  // canvas 2d 가 없는 jsdom: 그림은 건너뛴다
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

const setPlace = (placement: "sidebar" | "dock" | "screen") => useNekoStore.setState((s) => ({ stage: { ...s.stage, placement } }));

it("기본 다섯이 있고, 놓기 → 치우기, 방이 2개로 차면 나머지 놓기는 막고 안내", async () => {
  setPlace("sidebar");
  render(<FurnitureTab onDrop={() => {}} />);
  for (const n of ["조명", "캣타워", "캣휠", "소파", "상자"]) expect(screen.getByText(n)).toBeTruthy();
  const btn = (name: string) => screen.getByText(name).closest("li")!.querySelector(".neko-gifts__btn") as HTMLButtonElement;
  fireEvent.click(btn("소파"));
  await waitFor(() => expect(btn("소파").textContent).toBe("치우기"));
  fireEvent.click(btn("상자"));
  await waitFor(() => expect(btn("상자").textContent).toBe("치우기"));
  expect(screen.getByText(/방에는 가구를 2개까지/)).toBeTruthy();
  expect(btn("조명").disabled).toBe(true);
  expect(btn("소파").disabled).toBe(false); // 치우기는 된다
  fireEvent.click(btn("소파"));
  await waitFor(() => expect(btn("조명").disabled).toBe(false));
});

it("마당에선 버튼 없이 안내, 기본 가구는 버리기가 없다", () => {
  setPlace("screen");
  render(<FurnitureTab onDrop={() => {}} />);
  expect(screen.getByText("마당에는 가구를 놓을 수 없습니다.")).toBeTruthy();
  expect(document.querySelectorAll(".neko-gifts__btn")).toHaveLength(0);
  expect(document.querySelectorAll(".neko-gifts__drop")).toHaveLength(0);
});
