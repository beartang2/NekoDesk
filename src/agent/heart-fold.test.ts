import { beforeEach, describe, expect, it, vi } from "vitest";

/** 쉴 때 성격 굳히기(docs/neko-heart.md §3): 검사·적용·하루 한 번·사용자 사실 안 보임 */
const h = vi.hoisted(() => {
  const kv = new Map<string, string>();
  globalThis.localStorage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) } as Storage;
  return { set: new Map<string, string>(), sent: "" as string, reply: null as unknown, mems: [] as unknown[] };
});
vi.mock("../api/tauri", () => ({
  settingsApi: { get: async (k: string) => h.set.get(k) ?? null, set: async (k: string, v: string) => void h.set.set(k, v) },
  memoryApi: { list: async () => h.mems, touch: async () => {} },
  syncApi: { status: async () => ({}) },
}));
vi.mock("./llm-client", () => ({
  DEFAULT_CHAT_SYSTEM_PROMPT: "기본",
  fetchCompletion: async () => "",
  fetchCompletionMessage: async (m: unknown) => { h.sent = JSON.stringify(m); return h.reply; },
}));

import { applyFold, foldHeart } from "./heart-fold";
import { parseHeart } from "./neko-heart";
import type { Memory } from "./types";

const mem = (id: number, kind: string, content: string): Memory => ({ id, kind, content, created_at: "2026-11-20 00:00:00", use_count: 0 });
const FACTS = [mem(1, "fact", "사용자의 동생 이름은 김하린이다"), mem(2, "preference", "사용자는 비 오는 날을 좋아한다")];
const tr = (id: string, kind: string, text: string, n = 1) => ({ id, kind, text, since: "2026-11-20", at: "2026-11-21", n });
const HEART = parseHeart(JSON.stringify({ traits: [tr("a", "like", "창가 햇볕", 2), tr("b", "fear", "청소기 소리"), tr("c", "habit", "아침마다 기지개")] }));

beforeEach(() => { h.set.clear(); h.sent = ""; h.reply = null; h.mems = FACTS; });

describe("applyFold 검사", () => {
  it("더하기·다시 확인·바꾸기(같은 번호, 새것이 이김)·버리기를 적용하고 굳힌 때·날을 적는다", () => {
    const { heart, record } = applyFold(HEART, {
      add: [{ kind: "rule", text: "밥그릇은 꼭 반만 먹는다" }],
      keep: ["a", "a", "zz"],
      revise: [{ id: "c", kind: "habit", text: "저녁마다 기지개" }],
      drop: ["b"],
    }, FACTS, "2026-11-23", "2026-11-23T01:00:00Z");
    expect(heart.traits.map((t) => [t.id, t.text, t.n])).toEqual([["a", "창가 햇볕", 3], ["c", "저녁마다 기지개", 2], [heart.traits[2].id, "밥그릇은 꼭 반만 먹는다", 1]]);
    expect(heart).toMatchObject({ folded: "2026-11-23T01:00:00Z", day: "2026-11-23" });
    expect(record).toEqual({ add: ["밥그릇은 꼭 반만 먹는다"], revise: [{ from: "아침마다 기지개", to: "저녁마다 기지개" }], drop: ["청소기 소리"], keep: 1 });
  });
  it("모르는 종류·빈 글·사용자 사실 조각·없는 번호는 버리고, 한 번에 더하기·버리기 5개까지", () => {
    const { heart, record } = applyFold(HEART, {
      add: [{ kind: "boss", text: "모르는 종류" }, { kind: "like", text: "" }, { kind: "like", text: "김하린이랑 놀기" }, { kind: "like", text: "비 오는 날 창가" },
        ...Array.from({ length: 6 }, (_, i) => ({ kind: "like", text: `놀이 ${i}` }))],
      revise: [{ id: "zz", text: "없는 번호" }],
      drop: ["zz"],
    }, FACTS, "2026-11-23", "2026-11-23T01:00:00Z");
    // 앞 다섯 제안만 본다 — 그중 사실 조각(김하린)·모르는 종류·빈 글은 버리고, 취향에도 있는 조각(비 오는 날)은 남는다
    expect(record.add).toEqual(["비 오는 날 창가", "놀이 0"]);
    expect(record.drop).toEqual([]);
    expect(heart.traits).toHaveLength(5);
  });
  it("안 털어놓은 비밀은 5개까지 더한다", () => {
    const five = parseHeart(JSON.stringify({ traits: Array.from({ length: 5 }, (_, i) => tr(`s${i}`, "secret", `비밀 ${i}`)) }));
    expect(applyFold(five, { add: [{ kind: "secret", text: "또 비밀" }, { kind: "like", text: "햇볕" }] }, FACTS, "2026-11-23", "x").record.add).toEqual(["햇볕"]);
  });
});

describe("foldHeart", () => {
  const notes = [
    { at: "2026-11-21T09:00:00Z", kind: "wonder", text: "굳힌 사건" },
    { at: "2026-11-23T08:00:00Z", kind: "chose", what: "walk_topic", text: "고른 주제", why: "비가 와서" },
    { at: "2026-11-23T09:00:00Z", kind: "wonder", text: "새 사건" },
  ];
  it("굳힌 뒤의 노트만 사건으로 주고, 사용자 사실은 안 보인다. 하루 한 번", async () => {
    h.set.set("neko_mind", JSON.stringify({ v: 1, notes, topics: [] }));
    h.set.set("neko_heart", JSON.stringify({ traits: [tr("a", "like", "창가 햇볕")], folded: "2026-11-22T00:00:00Z" }));
    h.reply = { text: "", toolCalls: [{ name: "heart_fold", params: { keep: ["a"], add: [{ kind: "habit", text: "비 오면 창가에" }] } }] };
    const r = await foldHeart();
    expect(r).toMatchObject({ add: ["비 오면 창가에"], keep: 1 });
    expect(h.sent).toContain("새 사건");
    expect(h.sent).not.toContain("굳힌 사건");
    expect(h.sent).not.toContain("고른 주제"); // 고른 것(산책 주제·그림)은 성격의 재료가 아니다(사용자)
    expect(h.sent).not.toContain("김하린");
    expect(h.sent).toContain("a [좋아함] 창가 햇볕");
    const saved = JSON.parse(h.set.get("neko_heart")!);
    expect(saved.folded).toBe("2026-11-23T09:00:00Z");
    // 같은 날 두 번째는 안 한다(모델을 안 부른다)
    h.sent = "";
    expect(await foldHeart()).toBeNull();
    expect(h.sent).toBe("");
  });
  it("모델이 답을 못 하면 오늘은 그만(성격은 그대로)", async () => {
    h.set.set("neko_mind", JSON.stringify({ v: 1, notes, topics: [] }));
    h.reply = null;
    expect(await foldHeart()).toBeNull();
    expect(JSON.parse(h.set.get("neko_heart")!).traits).toEqual([]);
  });
});
