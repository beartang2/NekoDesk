import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "./types";

/** 네코의 마음 1단계(docs/neko-mind.md): 노트 저장, 사용자 사실이 새는지, 생각하기 실패 처리, 산책 주제 */
const h = vi.hoisted(() => ({ kv: new Map<string, string>(), reply: null as unknown, fail: false, slow: false }));
vi.hoisted(() => {
  const kv = new Map<string, string>();
  globalThis.localStorage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) } as Storage;
});
vi.mock("../api/tauri", () => ({
  memoryApi: { list: async () => [] },
  settingsApi: { get: async (k: string) => h.kv.get(k) ?? null, set: async (k: string, v: string) => void h.kv.set(k, v) },
}));
vi.mock("./llm-client", () => ({
  DEFAULT_CHAT_SYSTEM_PROMPT: "기본",
  fetchCompletionMessage: async (_m: unknown, _p: unknown, _u: unknown, signal?: AbortSignal) => {
    if (h.fail) throw new Error("꺼짐");
    if (h.slow) await new Promise((_, no) => signal?.addEventListener("abort", () => no(new Error("abort"))));
    return { text: "", toolCalls: h.reply ? [{ name: "neko_think", params: h.reply }] : [] };
  },
}));

import { chooseWalkTopic, forgetNote, leaksFact, loadMind, mindMaterial, noteWonder, parseMind, think } from "./neko-mind";

const mem = (id: number, kind: string, content: string, created_at = "2026-11-01 09:00:00"): Memory => ({ id, kind, content, created_at, use_count: 0 });
const MEMS = [
  mem(1, "fact", "사용자의 동생 이름은 김하린이다"),
  mem(2, "fact", "사용자는 망원동 한강로 12에 산다"),
  mem(3, "preference", "사용자는 비 오는 날을 좋아한다"),
  mem(4, "neko", "산책하다 알게 됨: 고양이는 하루 16시간 잔다"),
];

beforeEach(() => { h.kv.clear(); h.reply = null; h.fail = false; h.slow = false; });

describe("노트 읽기", () => {
  it("모르는 칸·망가진 줄은 버리고, 옛 값이 없으면 빈 마음", () => {
    expect(parseMind(null)).toEqual({ v: 1, notes: [], topics: [] });
    expect(parseMind("{망가짐")).toEqual({ v: 1, notes: [], topics: [] });
    const m = parseMind(JSON.stringify({
      v: 2, extra: 1,
      notes: [{ at: "2026-11-19T08:00:00Z", kind: "wonder", text: "비 오는 날 새는?" }, { at: "x", kind: "wonder", text: "날짜 없음" }, { at: "2026-11-19T08:00:00Z", kind: "nope", text: "?" }],
      topics: [{ topic: "고양이의 잠", at: ["2026-11-02", "bad"] }, { topic: "", at: ["2026-11-02"] }],
    }));
    expect(m.notes).toHaveLength(1);
    expect(m.topics).toEqual([{ topic: "고양이의 잠", at: ["2026-11-02"] }]);
  });
});

describe("사용자 사실이 새는지", () => {
  it("이름·주소처럼 사실에만 있는 글자는 걸리고, 취향·네코 자신의 재료에도 있는 건 넘어간다", () => {
    expect(leaksFact("김하린이 좋아할 간식", MEMS)).toBe(true);
    expect(leaksFact("망원동 한강로 산책길", MEMS)).toBe(true);
    expect(leaksFact("비 오는 날 새들은 어디서 쉴까", MEMS)).toBe(false);
    expect(leaksFact("고양이는 왜 오래 잘까", MEMS)).toBe(false);
    expect(leaksFact("아무거나", [mem(9, "preference", "x")])).toBe(false); // 사실이 없으면 안 걸린다
  });
});

describe("생각하기", () => {
  it("툴로 답하면 고른 것·까닭·노트, 툴을 안 부르거나 실패·시간 초과면 null", async () => {
    h.reply = { pick: "  비 오는 날 새들  ", why: "창밖에 비가 와서", note: { kind: "wonder", text: "새 둥지는 젖을까" } };
    expect(await think("주제", [])).toEqual({ pick: "비 오는 날 새들", why: "창밖에 비가 와서", note: { kind: "wonder", text: "새 둥지는 젖을까" } });
    h.reply = { pick: "주제", why: "", note: { kind: "모름", text: "x" } };
    expect((await think("주제", []))?.note).toBeUndefined();
    h.reply = null;
    expect(await think("주제", [])).toBeNull();
    h.fail = true;
    expect(await think("주제", [])).toBeNull();
    h.fail = false; h.slow = true; h.reply = { pick: "늦음", why: "" };
    expect(await think("주제", [], undefined, 30)).toBeNull();
  });

  it("재료엔 날짜·횟수가 붙는다(판단 규칙은 없다)", () => {
    const text = mindMaterial({ v: 1, notes: [], topics: [{ topic: "고양이의 잠", at: ["2026-11-02", "2026-11-09"] }] }, MEMS).join("\n");
    expect(text).toContain("고양이의 잠 — 2번: 11/2, 11/9");
    expect(text).toContain("떠올림 0번");
    expect(text).toContain("사용자는 비 오는 날을 좋아한다");
  });
});

describe("산책 주제", () => {
  it("고른 주제를 돌려주고 날짜·고른 까닭·궁금한 것을 노트에 남긴다. 같은 주제를 다시 고르면 날짜가 는다", async () => {
    h.kv.set("neko_mind", JSON.stringify({ v: 1, notes: [], topics: [{ topic: "비 오는 날 새들", at: ["2026-11-02"] }] }));
    h.reply = { pick: "비 오는 날 새들", why: "오랜만에 다시", note: { kind: "want", text: "창밖을 오래 보고 싶어" } };
    expect(await chooseWalkTopic(MEMS)).toBe("비 오는 날 새들");
    const m = await loadMind();
    expect(m.topics[0].at).toHaveLength(2);
    expect(m.notes.map((n) => n.kind)).toEqual(["chose", "want"]);
    expect(m.notes[0]).toMatchObject({ what: "walk_topic", text: "비 오는 날 새들", why: "오랜만에 다시" });
  });

  it("사용자 사실이 담긴 주제는 버리고 아무것도 남기지 않는다(하위 에이전트가 스스로 고른다)", async () => {
    h.reply = { pick: "김하린 동생 선물", why: "" };
    expect(await chooseWalkTopic(MEMS)).toBeNull();
    expect(h.kv.get("neko_mind")).toBeUndefined();
    h.reply = null;
    expect(await chooseWalkTopic(MEMS)).toBeNull();
  });

  it("다음에 궁금한 것은 노트로, 사실이 섞이면 버린다. 설정에서 하나씩 지운다", async () => {
    await noteWonder("고양이 꿈은 무슨 색일까", MEMS);
    await noteWonder("망원동 한강로 고양이", MEMS);
    const m = await loadMind();
    expect(m.notes.map((n) => n.text)).toEqual(["고양이 꿈은 무슨 색일까"]);
    expect((await forgetNote(m.notes[0])).notes).toEqual([]);
  });
});
