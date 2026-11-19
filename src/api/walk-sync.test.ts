import { describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async () => ({ ok: true, walk: null })));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { syncApi } from "./tauri";
import { buildPath, fallbackLegs, walkEnd, walkStart, WALK_MS } from "../lib/walk";

describe("산책 선점·끝 알림", () => {
  it("시각을 정수 ms 로 보낸다 — 경로의 끝 시각은 소수라, 그대로 보내면 백엔드(i64)가 인자를 못 읽어 선점이 통째로 실패했다", async () => {
    const legs = fallbackLegs();
    const path = buildPath(legs, Date.now(), WALK_MS, legs.slice(1).map(() => (2 + Math.random() * 3) * 60_000));
    const w = { home: null, onMap: false, places: [], path };
    expect(Number.isInteger(walkEnd(w))).toBe(false); // 이 테스트가 지키는 전제
    await syncApi.walkClaim(walkStart(w), walkEnd(w));
    await syncApi.walkEnd(walkStart(w), walkEnd(w));
    for (const [, args] of invoke.mock.calls as unknown as [string, { start: number; end: number }][]) {
      expect(Number.isInteger(args.start) && Number.isInteger(args.end)).toBe(true);
    }
    expect(invoke.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(["walk_claim", "walk_end"]);
  });
});
