// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

/** 산책 중 부르기(0.1.21, 사용자): 지도·'산책 중' 그림을 눌러도 안 돌아오고, 오른쪽 아래 버튼만 부른다 */
vi.mock("./nekoHost", () => ({
  ensureNeko: () => ({ resume: () => {}, pause: () => {}, on: () => () => {} }),
  nekoCanvas: () => document.createElement("canvas"),
  useNekoController: () => null,
}));
vi.mock("./nekoStore", () => {
  const state = { stage: { placement: "dock", dockH: 120, sidebarH: 200 }, setStageHeight: () => {} };
  return { useNekoStore: (sel: (s: typeof state) => unknown) => sel(state) };
});
vi.mock("./NekoAway", () => ({ NekoAway: () => <div data-testid="away">산책 중</div> }));
vi.mock("../components/WalkMap", () => ({ WalkMap: () => <div data-testid="map" />, LastWalkModal: () => null }));
vi.mock("./NekoRoom", () => ({ RoomGifts: () => null }));
vi.mock("./WeatherWindow", () => ({ WeatherWindow: () => null }));
vi.mock("./Wallpaper", () => ({ DockWall: () => null }));
vi.mock("./gifts", () => ({ useNekoGifts: { getState: () => ({ place: () => {} }) } }));

import { NekoSlot } from "./NekoSlot";
import { useNekoApp } from "./director/stores";
import type { Walk } from "../lib/walk";

afterEach(() => cleanup());

const walk = { home: null, onMap: false, places: [], path: [[0, 0, Date.now()], [0, 0, Date.now() + 3_600_000]] } as unknown as Walk;

describe("산책 중 부르기", () => {
  it("지도·'산책 중' 그림·자리를 눌러도 부르지 않고, 버튼은 부른다", () => {
    const at = () => useNekoApp.getState().calledAt;
    const { getByTestId, getByRole, container } = render(<NekoSlot placement="dock" onRubPet={() => {}} away walk={walk} />);
    const before = at();
    fireEvent.click(getByTestId("map"));
    fireEvent.click(getByTestId("away"));
    fireEvent.click(container.querySelector(".neko-slot")!);
    expect(at()).toBe(before);
    fireEvent.click(getByRole("button", { name: /부르기|불러오기/ }));
    expect(at()).not.toBe(before);
  });

  it("산책을 다녀왔거나 다른 기기의 산책이면(walk 없음) 버튼도 없다", () => {
    const { queryByRole } = render(<NekoSlot placement="dock" onRubPet={() => {}} away walk={null} />);
    expect(queryByRole("button", { name: /부르기|불러오기/ })).toBeNull();
  });
});
