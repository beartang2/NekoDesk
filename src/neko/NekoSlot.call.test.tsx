// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

/** 산책 중 부르기(0.1.24, 사용자): 지도·'산책 중' 그림을 눌러도 안 돌아오고, 부르기 버튼도 없다 — 채팅을 보낼 때만 부른다 */
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
  it("지도·'산책 중' 그림·자리를 눌러도 부르지 않고, 부르기 버튼도 없다(0.1.24 — 지도를 가렸다. 부르기는 채팅 보내기뿐, walkWatch)", () => {
    const at = () => useNekoApp.getState().calledAt;
    const { getByTestId, queryByRole, container } = render(<NekoSlot placement="dock" onRubPet={() => {}} away walk={walk} />);
    const before = at();
    fireEvent.click(getByTestId("map"));
    fireEvent.click(getByTestId("away"));
    fireEvent.click(container.querySelector(".neko-slot")!);
    expect(at()).toBe(before);
    expect(queryByRole("button", { name: /부르기|불러오기/ })).toBeNull();
  });
});
