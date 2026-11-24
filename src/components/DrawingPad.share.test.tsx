// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";

/** 폰 그림판의 저장(↓): iOS 공유 창으로 내보낸다. 내보냈으면 ✓, 그냥 닫았으면 그대로, 못 띄웠으면 ✕ */
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@crabnebula/tauri-plugin-drag", () => ({ startDrag: vi.fn() }));
vi.mock("../api/tauri", () => ({ todosApi: {}, scheduleApi: {}, settingsApi: { get: async () => null, set: async () => {} }, shelfApi: {} }));
vi.mock("../lib/platform", () => ({ IS_PHONE: true, IS_MAC: false }));

import { DrawingPadCard } from "./RightPanel";

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} disconnect() {} } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => ({ fillRect() {}, getImageData: () => ({}) })) as unknown as HTMLCanvasElement["getContext"];
  HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,AAAA";
});
afterEach(() => { cleanup(); h.invoke.mockReset(); });

describe("폰 그림판 저장", () => {
  const save = (c: HTMLElement) => c.querySelector<HTMLButtonElement>(".draw-tool-btn--save")!;

  it("공유 창으로 내보내면 ✓, 그냥 닫으면 ↓ 그대로, 못 띄우면 ✕. 맥의 바탕화면 저장은 부르지 않는다", async () => {
    const { container } = render(<DrawingPadCard />);
    h.invoke.mockResolvedValueOnce(false); // 공유 창을 그냥 닫았다
    fireEvent.click(save(container));
    await waitFor(() => expect(h.invoke).toHaveBeenCalledWith("share_image", { dataUrl: "data:image/png;base64,AAAA" }));
    expect(save(container).textContent).toBe("↓");
    h.invoke.mockResolvedValueOnce(true); // 사진에 저장·다른 앱으로 보냄
    fireEvent.click(save(container));
    await waitFor(() => expect(save(container).textContent).toBe("✓"));
    expect(h.invoke.mock.calls.every((c) => c[0] === "share_image")).toBe(true);
  });

  it("공유 창을 못 띄우면 ✕", async () => {
    const { container } = render(<DrawingPadCard />);
    h.invoke.mockRejectedValueOnce(new Error("no"));
    fireEvent.click(save(container));
    await waitFor(() => expect(save(container).textContent).toBe("✕"));
  });
});
