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

const at = (id: string) => useNekoFurniture.getState().items.find((f) => f.id === id)!.place;
const slot = (n: number) => screen.getByRole("button", { name: new RegExp(`^왼쪽에서 ${n}번째 칸`) }) as HTMLButtonElement;

it("놓기 → 어디에 놓을까요?(자리) → 어느 칸에 놓을까요?(칸). 찬 칸·꽉 찬 자리는 흐리게 못 고른다", async () => {
  useNekoStore.setState((s) => ({ stage: { ...s.stage, placement: "screen" } })); // 네코가 마당에 있어도 고를 수 있다
  render(<Harness />);
  for (const n of ["조명", "캣타워", "캣휠", "소파", "상자"]) expect(cell(n)).toBeTruthy();
  fireEvent.click(btn("소파", "놓기"));
  expect(screen.getByText("어디에 놓을까요?")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^마당/ })).toBeNull(); // 가구는 마당에 안 놓는다
  fireEvent.click(choice("방"));
  expect(screen.getByText("어느 칸에 놓을까요?")).toBeTruthy();
  expect(document.querySelectorAll(".slot-pick__slot")).toHaveLength(2); // 방 2칸
  fireEvent.click(slot(2));
  await waitFor(() => expect(at("base:sofa")).toEqual({ at: "sidebar", slot: 1 }));
  expect(btn("소파", "치우기")).toBeTruthy();

  // 소파가 있는 칸은 못 고른다
  fireEvent.click(btn("상자", "놓기"));
  fireEvent.click(choice("방"));
  expect(slot(2).disabled).toBe(true);
  expect(slot(2).getAttribute("aria-label")).toContain("소파 있음");
  fireEvent.click(slot(1));
  await waitFor(() => expect(at("base:box")).toEqual({ at: "sidebar", slot: 0 }));

  // 방 2/2: 조명은 방을 못 고르고 거실은 된다
  fireEvent.click(btn("조명", "놓기"));
  expect(choice("방").disabled).toBe(true);
  expect(choice("방").textContent).toContain("2/2 꽉 참");
  expect(choice("거실").disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "취소" }));
  await waitFor(() => expect(screen.queryByText("어디에 놓을까요?")).toBeNull());

  // 옮기기: 방엔 빈 칸이 없어 막히고, 거실 → 뒤로 → 거실 → 4번째 칸
  fireEvent.click(btn("소파", "옮기기"));
  expect(screen.getByText("어디로 옮길까요?")).toBeTruthy();
  expect(choice("방").disabled).toBe(true);
  expect(choice("방").textContent).toContain("놓여 있음");
  fireEvent.click(choice("거실"));
  expect(screen.getByText("어느 칸으로 옮길까요?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
  expect(screen.getByText("어디로 옮길까요?")).toBeTruthy();
  fireEvent.click(choice("거실"));
  fireEvent.click(slot(4));
  await waitFor(() => expect(at("base:sofa")).toEqual({ at: "dock", slot: 3 }));

  // 같은 자리 안에서 칸 옮기기: 지금 칸은 '지금 자리'로 막는다
  fireEvent.click(btn("소파", "옮기기"));
  expect(choice("거실").disabled).toBe(false);
  fireEvent.click(choice("거실"));
  expect(slot(4).disabled).toBe(true);
  expect(slot(4).textContent).toBe("지금 자리");
  fireEvent.click(slot(1));
  await waitFor(() => expect(at("base:sofa")).toEqual({ at: "dock", slot: 0 }));

  fireEvent.click(btn("상자", "치우기"));
  await waitFor(() => expect(btn("상자", "놓기")).toBeTruthy());
  fireEvent.click(btn("조명", "놓기"));
  expect(choice("방").disabled).toBe(false);
});

it("기본 가구는 버리기가 없다", () => {
  render(<Harness />);
  expect(document.querySelectorAll(".neko-gifts__drop")).toHaveLength(0);
});
