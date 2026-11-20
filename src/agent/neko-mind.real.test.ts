import { describe, expect, it, vi } from "vitest";
import type { Memory } from "./types";

/**
 * 실서버 확인(로컬 모델이 127.0.0.1:8803 에 떠 있을 때만, memory-merge.test 와 같다): 고양이 기록만 잔뜩 있는 마음으로 산책 주제를
 * 여러 번 뽑아 갈래 분포를 찍는다. 최근 갈래 묶음·계절·지나는 곳·관심을 보면 네코가 스스로 다른 갈래로도 가야 한다(0.1.22).
 * 작은 로컬 모델에서도 툴 호출이 깨지지 않는지 같이 본다
 */
const LLM_URL = "http://127.0.0.1:8803";
vi.hoisted(() => {
  const kv = new Map<string, string>([["nekodesk_llm_url", "http://127.0.0.1:8803"]]);
  globalThis.localStorage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) } as Storage;
});
const serverUp = await fetch(`${LLM_URL}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);

const db = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock("../api/tauri", () => ({
  memoryApi: { list: async () => [] },
  settingsApi: { get: async (k: string) => db.kv.get(k) ?? null, set: async (k: string, v: string) => void db.kv.set(k, v) },
}));

const cat = (i: number, content: string): Memory => ({ id: i, kind: "neko", content: `산책하다 알게 됨: ${content}`, created_at: "2026-11-1" + (i % 9) + " 09:00:00", use_count: i % 3 });
const MEMS: Memory[] = [
  cat(1, "고양이는 하루 16시간 잔다"), cat(2, "고양이 수염은 폭을 잰다"), cat(3, "고양이 골골송은 뼈를 튼튼하게 한다는 연구가 있다"),
  cat(4, "고양이는 단맛을 못 느낀다"), cat(5, "고양이 귀는 32개 근육으로 움직인다"),
  { id: 9, kind: "preference", content: "사용자는 비 오는 날을 좋아한다", created_at: "2026-11-01 09:00:00", use_count: 0 },
];
const day = (d: number) => `2026-11-${String(d).padStart(2, "0")}`;
const CAT_HEAVY = {
  v: 1,
  notes: [{ at: "2026-11-18T09:00:00Z", kind: "wonder", text: "고양이는 왜 상자를 좋아할까" }],
  topics: [
    { topic: "고양이 수면 연구", at: [day(2), day(5)], field: "동물" }, { topic: "고양이 수염의 쓸모", at: [day(7)], field: "동물" },
    { topic: "골골송의 비밀", at: [day(9), day(11)], field: "동물" }, { topic: "고양이 미각", at: [day(13)], field: "동물" },
    { topic: "고양이 귀 근육", at: [day(15), day(17)], field: "동물" }, { topic: "고양이와 상자", at: [day(18)], field: "동물" },
  ],
};

describe.skipIf(!serverUp)("산책 주제 분포 — 실서버", () => {
  it("고양이 기록만 잔뜩 있어도 여러 번 뽑으면 다른 갈래로도 간다", async () => {
    const { chooseWalkTopic, loadMind } = await import("./neko-mind");
    db.kv.set("neko_mind", JSON.stringify(CAT_HEAVY));
    const picked: string[] = [];
    for (let i = 0; i < 8; i++) {
      const t = await chooseWalkTopic(MEMS, undefined, ["망원 시장", "한강 공원", "동네 서점"]);
      picked.push(t ?? "(실패)");
    }
    const fields = (await loadMind()).topics.slice(-8).map((t) => t.field ?? "?");
    console.log("뽑은 주제:", picked.join(" | "));
    console.log("갈래:", fields.join(", "));
    expect(picked.filter((p) => p !== "(실패)").length).toBeGreaterThanOrEqual(6); // 작은 모델에서도 툴 호출이 대부분 된다
    expect(new Set(fields).size).toBeGreaterThanOrEqual(2);
  }, 240_000);
});
