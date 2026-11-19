import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => ({ ok: true, walk: null })));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { syncApi } from "./tauri";

describe("산책 선점·끝 알림", () => {
  it("시각을 정수 ms 로 보낸다 — 경로의 끝 시각은 소수가 섞이는데, 그대로 보내면 백엔드(i64)가 인자를 못 읽어 선점이 통째로 실패했다", async () => {
    // 경로 시각은 거리·머무는 시간(난수)을 더해 나와 소수가 된다(예: 1763541234567.25)
    await syncApi.walkClaim(1763541234567, 1763543034567.25);
    await syncApi.walkEnd(1763541234567, 1763541834566.75);
    expect(invoke.mock.calls).toEqual([
      ["walk_claim", { start: 1763541234567, end: 1763543034567 }],
      ["walk_end", { start: 1763541234567, end: 1763541834567 }],
    ]);
  });
});
