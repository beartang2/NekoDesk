// @vitest-environment jsdom

import { it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { parseServerToolCaps } from "./claude-caps";

it("Models API 의 capabilities.server_tools 에서 지원 여부를 읽는다", () => {
  expect(parseServerToolCaps({ capabilities: { server_tools: { web_search: { supported: true }, web_fetch: { supported: false } } } }))
    .toEqual({ web_search: true, web_fetch: false });
  expect(parseServerToolCaps({ id: "x" })).toEqual({ web_search: false, web_fetch: false });
  expect(parseServerToolCaps(null)).toEqual({ web_search: false, web_fetch: false });
});
