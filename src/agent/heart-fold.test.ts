import { beforeEach, describe, expect, it, vi } from "vitest";

/** 쉴 때 속마음 굳히기(docs/neko-heart.md §3): 검사·적용·기억으로 보내기·한 번 훑기·하루 한 번·사용자 사실 안 보임 */
const h = vi.hoisted(() => {
  const kv = new Map<string, string>();
  globalThis.localStorage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) } as Storage;
  return { set: new Map<string, string>(), sent: "" as string, reply: null as unknown, mems: [] as unknown[], saved: [] as [string, string][] };
});
vi.mock("../api/tauri", () => ({
  settingsApi: { get: async (k: string) => h.set.get(k) ?? null, set: async (k: string, v: string) => void h.set.set(k, v) },
  memoryApi: { list: async () => h.mems, touch: async () => {}, save: async (content: string, kind: string) => void h.saved.push([kind, content]) },
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
const HEART = parseHeart(JSON.stringify({ traits: [tr("a", "interest", "창가 햇볕", 2), tr("b", "temper", "청소기 소리"), tr("c", "temper", "아침마다 기지개")] }));

beforeEach(() => { h.set.clear(); h.sent = ""; h.reply = null; h.mems = FACTS; h.saved = []; });

describe("applyFold 검사", () => {
  it("더하기·다시 확인·바꾸기(같은 번호, 새것이 이김)·버리기를 적용하고 굳힌 때·날을 적는다", () => {
    const { heart, record } = applyFold(HEART, {
      add: [{ kind: "value", text: "밥그릇은 꼭 반만 먹는다" }],
      keep: ["a", "a", "zz"],
      revise: [{ id: "c", kind: "temper", text: "저녁마다 기지개" }],
      drop: ["b"],
    }, FACTS, "2026-11-23", "2026-11-23T01:00:00Z");
    expect(heart.traits.map((t) => [t.id, t.text, t.n])).toEqual([["a", "창가 햇볕", 3], ["c", "저녁마다 기지개", 2], [heart.traits[2].id, "밥그릇은 꼭 반만 먹는다", 1]]);
    expect(heart).toMatchObject({ folded: "2026-11-23T01:00:00Z", day: "2026-11-23" });
    expect(record).toEqual({ add: ["밥그릇은 꼭 반만 먹는다"], revise: [{ from: "아침마다 기지개", to: "저녁마다 기지개" }], drop: ["청소기 소리"], keep: 1 });
  });
  it("모르는 종류·빈 글·사용자 사실 조각·없는 번호는 버리고, 한 번에 더하기·버리기 5개까지", () => {
    const { heart, record } = applyFold(HEART, {
      add: [{ kind: "like", text: "옛 갈래" }, { kind: "interest", text: "" }, { kind: "interest", text: "김하린이랑 놀기" }, { kind: "interest", text: "비 오는 날 창가" },
        ...Array.from({ length: 6 }, (_, i) => ({ kind: "interest", text: `놀이 ${i}` }))],
      revise: [{ id: "zz", text: "없는 번호" }],
      drop: ["zz"],
    }, FACTS, "2026-11-23", "2026-11-23T01:00:00Z");
    // 앞 다섯 제안만 본다 — 그중 사실 조각(김하린)·모르는 갈래(옛 갈래 포함)·빈 글은 버리고, 취향에도 있는 조각(비 오는 날)은 남는다
    expect(record.add).toEqual(["비 오는 날 창가", "놀이 0"]);
    expect(record.drop).toEqual([]);
    expect(heart.traits).toHaveLength(5);
  });
  it("안 털어놓은 비밀은 5개까지 더한다", () => {
    const five = parseHeart(JSON.stringify({ traits: Array.from({ length: 5 }, (_, i) => tr(`s${i}`, "secret", `비밀 ${i}`)) }));
    expect(applyFold(five, { add: [{ kind: "secret", text: "또 비밀" }, { kind: "interest", text: "햇볕" }] }, FACTS, "2026-11-23", "x").record.add).toEqual(["햇볕"]);
  });
  it("알게 된 사실은 기억으로: remember(사건)·move(지금 줄 — 속마음에서 빠진다). 사실 조각·없는 번호는 버리고 평소엔 5개까지", () => {
    const { heart, record, remember } = applyFold(HEART, {
      remember: ["고양이는 하루 열여섯 시간 잔다", "김하린 생일", "고양이는 하루 열여섯 시간 잔다", ...Array.from({ length: 6 }, (_, i) => `사실 ${i}`)],
      move: ["a", "zz"],
    }, FACTS, "2026-11-23", "x");
    expect(heart.traits.map((t) => t.id)).toEqual(["b", "c"]);
    expect(remember).toEqual(["창가 햇볕", "고양이는 하루 열여섯 시간 잔다", "사실 0", "사실 1"]);
    expect(record.remember).toEqual(remember);
    expect(record.drop).toEqual([]); // 옮긴 건 버린 게 아니다
  });
  it("한 번 훑기(review)는 옮기기·버리기를 넉넉히 받고(더하기는 그대로 5) 훑으면 표시를 지운다", () => {
    const many = parseHeart(JSON.stringify({ traits: Array.from({ length: 12 }, (_, i) => tr(`x${i}`, "like", `옛 줄 ${i}`)) }), true);
    expect(many.review).toBe(true);
    const { heart, remember } = applyFold(many, {
      move: many.traits.slice(0, 8).map((t) => t.id), drop: ["x8", "x9"],
      add: Array.from({ length: 7 }, (_, i) => ({ kind: "identity", text: `나는 ${i}` })),
    }, FACTS, "2026-11-23", "x");
    expect(remember).toHaveLength(8);
    expect(heart.traits.map((t) => t.text)).toEqual(["옛 줄 10", "옛 줄 11", "나는 0", "나는 1", "나는 2", "나는 3", "나는 4"]);
    expect(heart.review).toBeUndefined();
    expect(applyFold(HEART, { move: ["a", "b", "c"] }, FACTS, "2026-11-23", "x").remember).toHaveLength(3); // 평소 5 — 셋은 된다
  });
});

describe("foldHeart", () => {
  const notes = [
    { at: "2026-11-21T09:00:00Z", kind: "wonder", text: "굳힌 사건" },
    { at: "2026-11-23T08:00:00Z", kind: "chose", what: "walk_topic", text: "고른 주제", why: "비가 와서" },
    { at: "2026-11-23T09:00:00Z", kind: "wonder", text: "새 사건" },
  ];
  it("굳힌 뒤의 노트만 사건으로 주고, 사용자 사실은 안 보인다. 알게 된 사실은 기억(neko)으로. 하루 한 번", async () => {
    h.set.set("neko_mind", JSON.stringify({ v: 1, notes, topics: [] }));
    h.set.set("neko_heart2", JSON.stringify({ traits: [tr("a", "interest", "창가 햇볕")], folded: "2026-11-22T00:00:00Z" }));
    h.reply = { text: "", toolCalls: [{ name: "heart_fold", params: { keep: ["a"], add: [{ kind: "temper", text: "비 오면 창가에" }], remember: ["새는 비를 피해 처마에 숨는다"] } }] };
    const r = await foldHeart();
    expect(r).toMatchObject({ add: ["비 오면 창가에"], keep: 1, remember: ["새는 비를 피해 처마에 숨는다"] });
    expect(h.saved).toEqual([["neko", "새는 비를 피해 처마에 숨는다"]]);
    expect(h.sent).toContain("새 사건");
    expect(h.sent).not.toContain("굳힌 사건");
    expect(h.sent).not.toContain("고른 주제"); // 예전 고름 노트는 읽을 때 버린다(사용자)
    expect(h.sent).not.toContain("김하린");
    expect(h.sent).toContain("a [관심사] 창가 햇볕");
    expect(h.sent).not.toContain("옛 갈래에서 옮겨 온");
    const saved = JSON.parse(h.set.get("neko_heart2")!);
    expect(saved.folded).toBe("2026-11-23T09:00:00Z");
    // 같은 날 두 번째는 안 한다(모델을 안 부른다)
    h.sent = "";
    expect(await foldHeart()).toBeNull();
    expect(h.sent).toBe("");
  });
  it("모델이 답을 못 하면 오늘은 그만(속마음은 그대로)", async () => {
    h.set.set("neko_mind", JSON.stringify({ v: 1, notes, topics: [] }));
    h.reply = null;
    expect(await foldHeart()).toBeNull();
    expect(JSON.parse(h.set.get("neko_heart2")!).traits).toEqual([]);
  });
  it("옛 키에서 옮겨 온 뒤 첫 굳히기는 한 번 훑기 — 굳힌 노트도 다 보고, 옛 줄을 기억으로 옮기고, 옛 키는 그대로 둔다", async () => {
    h.set.set("neko_mind", JSON.stringify({ v: 1, notes, topics: [] }));
    const oldHeart = JSON.stringify({ traits: [tr("a", "like", "고양이 수염은 몸 너비만 하다"), tr("b", "rule", "밥은 천천히")], folded: "2026-11-22T00:00:00Z", day: "2026-11-23" });
    h.set.set("neko_heart", oldHeart);
    h.reply = { text: "", toolCalls: [{ name: "heart_fold", params: { move: ["a"], keep: ["b"] } }] };
    const r = await foldHeart();
    expect(r).toMatchObject({ remember: ["고양이 수염은 몸 너비만 하다"], keep: 1 });
    expect(h.sent).toContain("굳힌 사건");
    expect(h.sent).toContain("옛 갈래에서 옮겨 온");
    expect(h.sent).toContain("b [가치관] 밥은 천천히");
    expect(h.saved).toEqual([["neko", "고양이 수염은 몸 너비만 하다"]]);
    const saved = JSON.parse(h.set.get("neko_heart2")!);
    expect(saved.traits.map((t: { id: string }) => t.id)).toEqual(["b"]);
    expect(saved.review).toBeUndefined();
    expect(h.set.get("neko_heart")).toBe(oldHeart);
  });
  it("한 번 훑기가 실패하면 표시가 남아 다음 날 다시 훑는다", async () => {
    h.set.set("neko_heart", JSON.stringify({ traits: [tr("a", "like", "햇볕")] }));
    h.reply = null;
    expect(await foldHeart()).toBeNull();
    expect(JSON.parse(h.set.get("neko_heart2")!)).toMatchObject({ review: true, traits: [{ id: "a", kind: "interest" }] });
  });
});
