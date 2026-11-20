// @vitest-environment jsdom

import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";

const store = vi.hoisted(() => ({ value: null as string | null }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async () => {}), listen: vi.fn(async () => () => {}) }));

import { FurnitureTab } from "./FurnitureTab";
import { PlacePicker, type PlaceAsk } from "./PlacePicker";
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

/** 가구 탭 + 자리 고르기 창(선물함 창이 하는 것처럼) */
function Harness() {
  const [ask, setAsk] = useState<PlaceAsk | null>(null);
  return (<><FurnitureTab onDrop={() => {}} onAsk={setAsk} /><PlacePicker ask={ask} onClose={() => setAsk(null)} /></>);
}
const cell = (name: string) => screen.getByText(name, { selector: ".neko-gifts__title" }).closest("li")!;
const btn = (name: string, label: string) => within(cell(name)).getByRole("button", { name: label });
const choice = (place: string) => screen.getByRole("button", { name: new RegExp(`^${place}`) }) as HTMLButtonElement;

it("놓기 → 어디에 놓을까요? → 고른 자리에 놓이고 옮기기·치우기, 꽉 찬 자리는 흐리게 못 고른다", async () => {
  useNekoStore.setState((s) => ({ stage: { ...s.stage, placement: "screen" } })); // 네코가 마당에 있어도 고를 수 있다
  render(<Harness />);
  for (const n of ["조명", "캣타워", "캣휠", "소파", "상자"]) expect(cell(n)).toBeTruthy();
  fireEvent.click(btn("소파", "놓기"));
  expect(screen.getByText("어디에 놓을까요?")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^마당/ })).toBeNull(); // 가구는 마당에 안 놓는다
  fireEvent.click(choice("방"));
  await waitFor(() => expect(btn("소파", "치우기")).toBeTruthy());
  expect(useNekoFurniture.getState().items.find((f) => f.id === "base:sofa")!.place?.at).toBe("sidebar");
  fireEvent.click(btn("상자", "놓기"));
  fireEvent.click(choice("방"));
  await waitFor(() => expect(btn("상자", "옮기기")).toBeTruthy());

  // 방 2/2: 조명은 방을 못 고르고 거실은 된다
  fireEvent.click(btn("조명", "놓기"));
  expect(choice("방").disabled).toBe(true);
  expect(choice("방").textContent).toContain("2/2 꽉 참");
  expect(choice("거실").disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  await waitFor(() => expect(screen.queryByText("어디에 놓을까요?")).toBeNull());

  // 옮기기: 지금 자리는 '놓여 있음'으로 막고 거실로 옮긴다 → 방에 자리가 난다
  fireEvent.click(btn("소파", "옮기기"));
  expect(screen.getByText("어디로 옮길까요?")).toBeTruthy();
  expect(choice("방").disabled).toBe(true);
  expect(choice("방").textContent).toContain("놓여 있음");
  fireEvent.click(choice("거실"));
  await waitFor(() => expect(useNekoFurniture.getState().items.find((f) => f.id === "base:sofa")!.place?.at).toBe("dock"));
  fireEvent.click(btn("상자", "치우기"));
  await waitFor(() => expect(btn("상자", "놓기")).toBeTruthy());
  fireEvent.click(btn("조명", "놓기"));
  expect(choice("방").disabled).toBe(false);
});

it("기본 가구는 버리기가 없다", () => {
  render(<Harness />);
  expect(document.querySelectorAll(".neko-gifts__drop")).toHaveLength(0);
});
