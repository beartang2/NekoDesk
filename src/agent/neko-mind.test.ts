import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "./types";

/** 네코의 마음 1단계(docs/neko-mind.md): 노트 저장, 사용자 사실이 새는지, 생각하기 실패 처리, 산책 주제 */
const h = vi.hoisted(() => ({ kv: new Map<string, string>(), reply: null as unknown, fail: false, slow: false, mems: [] as unknown[], judge: "", judged: 0, sent: "", touched: [] as number[][] }));
vi.hoisted(() => {
  const kv = new Map<string, string>();
  globalThis.localStorage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) } as Storage;
});
vi.mock("../api/tauri", () => ({
  memoryApi: { list: async () => h.mems, touch: async (ids: number[]) => void h.touched.push(ids) },
  settingsApi: { get: async (k: string) => h.kv.get(k) ?? null, set: async (k: string, v: string) => void h.kv.set(k, v) },
}));
vi.mock("./llm-client", () => ({
  DEFAULT_CHAT_SYSTEM_PROMPT: "기본",
  fetchCompletion: async () => { h.judged++; return h.judge; },
  fetchCompletionMessage: async (_m: unknown, _p: unknown, _u: unknown, signal?: AbortSignal) => {
    h.sent = JSON.stringify(_m);
    if (h.fail) throw new Error("꺼짐");
    if (h.slow) await new Promise((_, no) => signal?.addEventListener("abort", () => no(new Error("abort"))));
    return { text: "", toolCalls: h.reply ? [{ name: "neko_think", params: h.reply }] : [] };
  },
}));

import { chooseAmong, chooseWalkTopic, dedupeNotes, dreamThink, mayDream, noteDream, DREAM_GAP_MS, forgetNote, leaksFact, loadMind, mindMaterial, noteWonder, parseMind, recentInterests, restThink, takeGreeting, think, currentLean } from "./neko-mind";
import { useSessionStore } from "../stores/sessionStore";

const mem = (id: number, kind: string, content: string, created_at = "2026-11-01 09:00:00"): Memory => ({ id, kind, content, created_at, use_count: 0 });
const MEMS = [
  mem(1, "fact", "사용자의 동생 이름은 김하린이다"),
  mem(2, "fact", "사용자는 망원동 한강로 12에 산다"),
  mem(3, "preference", "사용자는 비 오는 날을 좋아한다"),
  mem(4, "neko", "산책하다 알게 됨: 고양이는 하루 16시간 잔다"),
];

beforeEach(() => { h.kv.clear(); h.reply = null; h.fail = false; h.slow = false; h.mems = []; h.judge = ""; h.judged = 0; useSessionStore.setState({ sessions: [] }); });

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
  it("이름·주소처럼 사실에 있는 글자는 걸리고(띄어쓰기를 바꿔도), 취향에도 있는 건 넘어간다", () => {
    expect(leaksFact("김하린이 좋아할 간식", MEMS)).toBe(true);
    expect(leaksFact("김 하 린 간식", MEMS)).toBe(true);
    expect(leaksFact("망원동 한강로 산책길", MEMS)).toBe(true);
    expect(leaksFact("비 오는 날 새들은 어디서 쉴까", MEMS)).toBe(false);
    expect(leaksFact("고양이는 왜 오래 잘까", MEMS)).toBe(false);
    expect(leaksFact("아무거나", [mem(9, "preference", "x")])).toBe(false); // 사실이 없으면 안 걸린다
  });

  it("웹에서 온 산책 기억이 사실 조각을 허용시키지 못한다(허용은 취향뿐)", () => {
    const planted = [...MEMS, mem(8, "neko", "산책하다 알게 됨: 김하린 망원동 한강로")];
    expect(leaksFact("김하린 망원동", planted)).toBe(true);
  });

  it("노트를 쓰는 생각하기엔 사용자 사실을 안 보인다(취향만). 첫마디는 본다", () => {
    const noFacts = mindMaterial({ v: 1, notes: [], topics: [] }, MEMS, { facts: false }).join("\n");
    expect(noFacts).not.toContain("김하린");
    expect(noFacts).not.toContain("망원동");
    expect(noFacts).toContain("비 오는 날을 좋아한다");
    expect(mindMaterial({ v: 1, notes: [], topics: [] }, MEMS, { facts: true }).join("\n")).toContain("김하린");
  });

  it("재료로 들어간 기억만 꺼내 쓴 것으로 찍는다(기억 잊기, 0.1.29) — 사실을 안 보이는 생각하기면 사실 기억은 안 찍는다", async () => {
    h.touched = [];
    mindMaterial({ v: 1, notes: [], topics: [] }, MEMS, { facts: false });
    await new Promise((ok) => setTimeout(ok, 0));
    expect(h.touched).toEqual([[4, 3]]);
    h.touched = [];
    mindMaterial({ v: 1, notes: [], topics: [] }, MEMS, { facts: true });
    await new Promise((ok) => setTimeout(ok, 0));
    expect(h.touched[0].sort()).toEqual([1, 2, 3, 4]);
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
    const text = mindMaterial({ v: 1, notes: [], topics: [{ topic: "고양이의 잠", at: ["2026-11-02", "2026-11-09"] }] }, MEMS, { facts: false }).join("\n");
    expect(text).toContain("고양이의 잠 — 2번: 11/2, 11/9");
    expect(text).toContain("떠올림 0번");
    expect(text).toContain("사용자는 비 오는 날을 좋아한다");
  });
});

describe("산책 주제", () => {
  it("고른 주제를 돌려주고 알아본 주제에 날짜를 남긴다(고른 것은 노트가 아니다 — 같이 떠올린 것만). 같은 주제를 다시 고르면 날짜가 는다", async () => {
    h.kv.set("neko_mind", JSON.stringify({ v: 1, notes: [], topics: [{ topic: "비 오는 날 새들", at: ["2026-11-02"] }] }));
    h.reply = { pick: "비 오는 날 새들", why: "오랜만에 다시", note: { kind: "want", text: "창밖을 오래 보고 싶어" } };
    expect(await chooseWalkTopic(MEMS)).toBe("비 오는 날 새들");
    const m = await loadMind();
    expect(m.topics[0].at).toHaveLength(2);
    expect(m.notes.map((n) => [n.kind, n.text])).toEqual([["want", "창밖을 오래 보고 싶어"]]);
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

describe("2단계", () => {
  const CHOICES = [{ key: "trinket", label: "주운 것" }, { key: "weather", label: "날씨" }];
  it("보기 중에서 고르면 그 이름, 보기 밖이면 null(지금 동작으로). 고른 갈래(선물 종류)는 노트에 안 남긴다 — 같이 떠올린 궁금만", async () => {
    h.reply = { pick: "weather", why: "비가 와서" };
    expect(await chooseAmong("선물", CHOICES, [], MEMS)).toBe("weather");
    expect((await loadMind()).notes).toEqual([]); // "고름: 날씨" 같은 줄은 속마음이 아니다(사용자)
    h.reply = { pick: "weather", why: "비가 와서", note: { kind: "wonder", text: "비는 어디서 올까" } };
    expect(await chooseAmong("선물", CHOICES, [], MEMS)).toBe("weather");
    expect((await loadMind()).notes.map((n) => [n.kind, n.text])).toEqual([["wonder", "비는 어디서 올까"]]);
    // 예전에 적힌 고름(선물 종류·산책 주제·그림)은 읽을 때 버린다 — 행동 기록이라 속마음 재료가 아니다(docs/neko-heart.md §0)
    const old = parseMind(JSON.stringify({ notes: [
      { at: "2026-11-20T01:00:00Z", kind: "chose", what: "walk_gift", text: "놀이" },
      { at: "2026-11-20T02:00:00Z", kind: "chose", what: "walk_topic", text: "새는 왜 깃털을 부풀릴까" },
      { at: "2026-11-20T03:00:00Z", kind: "wonder", text: "깃털은 몇 개일까", why: "옛 칸" },
    ] }));
    expect(old.notes).toEqual([{ at: "2026-11-20T03:00:00Z", kind: "wonder", text: "깃털은 몇 개일까" }]);
    h.reply = { pick: "drawing", why: "" };
    expect(await chooseAmong("선물", CHOICES, [], MEMS)).toBeNull();
  });

  it("첫마디: 졸 때 생각해 두고(2시간에 한 번), 깨면 한 번만 꺼낸다", async () => {
    h.reply = { pick: "다녀왔어? 창밖에 비 와", why: "비가 와서", like: ["window"], tired: [] };
    await restThink({ greet: true });
    h.reply = { pick: "또 생각함", why: "" };
    await restThink({ greet: true }); // 2시간 안 — 다시 안 부른다
    expect(await takeGreeting()).toBe("다녀왔어? 창밖에 비 와");
    expect(await takeGreeting()).toBeNull();
  });
});

describe("속마음(docs/neko-heart.md)", () => {
  const trait = (id: string, kind: string, text: string, extra = {}) => ({ id, kind, text, since: "2026-11-20", at: "2026-11-22", n: 2, ...extra });
  it("생각하기 재료에 '나는 이런 고양이'가 붙고(옛 키의 갈래는 새 갈래로 옮겨 읽는다), 굳은 노트는 빠진다", async () => {
    h.kv.set("neko_mind", JSON.stringify({ v: 1, notes: [
      { at: "2026-11-21T09:00:00Z", kind: "wonder", text: "굳은 노트" }, { at: "2026-11-23T09:00:00Z", kind: "wonder", text: "새 노트" },
    ], topics: [] }));
    h.kv.set("neko_heart", JSON.stringify({ traits: [trait("a", "like", "창가 햇볕"), trait("s", "secret", "몰래 하는 것")], folded: "2026-11-22T00:00:00Z" }));
    const text = mindMaterial(await loadMind(), MEMS, { facts: false }).join("\n");
    expect(text).toContain("## 나는 이런 고양이");
    expect(text).toContain("[관심사] 창가 햇볕");
    expect(text).toContain("몰래 하는 것"); // 자기 마음엔 비밀도 보인다
    expect(text).toContain("새 노트");
    expect(text).not.toContain("굳은 노트");
  });
  it("첫마디를 생각할 때만 아직 말 안 한 비밀을 번호와 함께 주고, 털어놓으면(tell) 털어놓은 날이 붙는다", async () => {
    h.kv.set("neko_heart2", JSON.stringify({ traits: [trait("s", "secret", "몰래 하는 것"), trait("a", "interest", "햇볕")] }));
    h.reply = { pick: "사실은 몰래 하는 게 있어", why: "요즘 가까워져서", like: [], tired: [], tell: "s" };
    await restThink({ greet: true });
    expect(h.sent).toContain("아직 사용자에게 말하지 않은 비밀");
    expect(h.sent).toContain("- s 몰래 하는 것");
    const heart = JSON.parse(h.kv.get("neko_heart2")!);
    expect(heart.traits.find((x: { id: string }) => x.id === "s").told).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await takeGreeting()).toBe("사실은 몰래 하는 게 있어");
    // 기울기만 생각할 땐(첫마디 아님) 비밀 칸·tell 이 없다
    h.kv.set("neko_greeting", JSON.stringify({ text: "", at: 0, askedAt: 0 }));
    h.kv.set("neko_heart2", JSON.stringify({ traits: [trait("k", "secret", "또 다른 것")] }));
    h.reply = { pick: "그냥", why: "", like: ["yarn"], tired: [], tell: "k" };
    await restThink({ greet: false });
    expect(h.sent).not.toContain("아직 사용자에게 말하지 않은 비밀");
    expect(JSON.parse(h.kv.get("neko_heart2")!).traits[0].told).toBeUndefined();
  });
});

describe("3단계: 기울기", () => {
  it("쉴 때 생각하기가 좋아하는 것·질린 것(보기 안의 것만)을 정하고 감독이 하루 동안 읽는다", async () => {
    h.reply = { pick: "털실이 재밌어", why: "어제 털실이 잘 굴러서", like: ["yarn", "window", "nope", "yarn"], tired: ["box", "yarn", "giftplay", "dig"] };
    await restThink({ greet: false });
    const lean = currentLean()!;
    expect(lean.like).toEqual(["yarn", "window"]);
    expect(lean.tired).toEqual(["box", "giftplay"]); // 좋아하는 것과 겹친 건 빼고 둘까지
    expect((await loadMind()).lean?.why).toBe("어제 털실이 잘 굴러서");
    expect(currentLean(Date.now() + 25 * 3_600_000)).toBeNull(); // 하루 지나면 없음(가중치 1)
    expect(await takeGreeting()).toBeNull(); // greet 아니면 첫마디 안 남김
  });

  it("까닭에 사용자 사실이 섞이면 기울기는 남기고 까닭은 버린다. 망가진 기울기는 안 읽는다", async () => {
    h.kv.set("neko_greeting", JSON.stringify({ text: "", at: 0, askedAt: 0 }));
    h.reply = { pick: "기분 좋아", why: "김하린이 와서", like: ["groom"], tired: [] };
    h.mems = MEMS;
    await restThink({ greet: false });
    const m = await loadMind();
    expect(m.lean?.like).toEqual(["groom"]);
    expect(m.lean?.why).toBeUndefined();
    expect(parseMind(JSON.stringify({ lean: { at: "x", like: ["yarn"] } })).lean).toBeUndefined();
  });
});

describe("산책 주제가 한쪽으로 쏠리지 않게(0.1.22): 규칙 대신 재료를 넓힌다", () => {
  const visits = (field: string | undefined, days: string[]) => ({ topic: `${field ?? "옛"} ${days[0]}`, at: days, ...(field ? { field } : {}) });

  it("최근 10번의 갈래를 묶어 보여 준다(네코가 붙인 갈래로 센다), 계절·지나는 곳·관심도 재료에", () => {
    const mind = parseMind(JSON.stringify({ topics: [
      visits("동물", ["2026-11-01", "2026-11-03", "2026-11-05", "2026-11-07"]),
      visits("동물", ["2026-11-09", "2026-11-11", "2026-11-13", "2026-11-15"]),
      visits("날씨", ["2026-11-16"]),
      visits(undefined, ["2026-11-17"]),
    ] }));
    const text = mindMaterial(mind, MEMS, { facts: false, places: ["망원 시장", "한강 공원"], interests: ["요리", "여행"], now: new Date("2026-11-20T09:00:00+09:00") }).join("\n");
    expect(text).toContain("최근 10번의 갈래: 동물 8번, 날씨 1번, (갈래 안 적음) 1번");
    expect(text).toContain("가을");
    expect(text).toContain("## 이번 산책에 지나는 곳\n망원 시장, 한강 공원");
    expect(text).toContain("## 사용자가 요즘 이야기한 것(관심)\n요리, 여행");
  });

  it("주제를 고를 때 네코가 붙인 갈래를 함께 남긴다", async () => {
    h.reply = { pick: "늦가을 은행잎이 노란 까닭", why: "고양이 얘기만 했네", field: "계절" };
    await chooseWalkTopic(MEMS, undefined, ["한강 공원"]);
    expect((await loadMind()).topics[0]).toMatchObject({ topic: "늦가을 은행잎이 노란 까닭", field: "계절" });
  });

  it("대화 제목에서 관심 낱말(하루 한 번 판정) — 사용자 사실 조각을 담은 낱말은 버린다", async () => {
    h.mems = MEMS;
    useSessionStore.setState({ sessions: [
      { id: "a", title: "파스타 레시피", date: "", createdAt: 3 }, { id: "b", title: "제주 여행 계획", date: "", createdAt: 2 }, { id: "c", title: "새 대화", date: "", createdAt: 1 },
    ] as never });
    h.judge = "요리, 여행, 김하린, - 사진";
    expect(await recentInterests(MEMS)).toEqual(["요리", "여행", "사진"]);
    h.judge = "다른 답";
    expect(await recentInterests(MEMS)).toEqual(["요리", "여행", "사진"]); // 오늘은 다시 안 묻는다
    expect(h.judged).toBe(1);
  });
});

describe("노트 중복(0.1.22, 사용자: 같은 글이면 새로 쌓지 않기)", () => {
  it("같은 종류·글이면 하나만, 가장 최근 자리·날짜로", async () => {
    await noteWonder("고양이 꿈은 무슨 색일까");
    await noteWonder("비 오는 날 새들은?");
    await noteWonder("고양이 꿈은 무슨 색일까");
    const m = await loadMind();
    expect(m.notes.map((n) => n.text)).toEqual(["비 오는 날 새들은?", "고양이 꿈은 무슨 색일까"]);
    const n = (kind: "wonder" | "want", text: string) => ({ at: "2026-11-20T00:00:00Z", kind, text });
    expect(dedupeNotes([n("wonder", "날씨"), n("want", "날씨")])).toHaveLength(2); // 종류가 다르면 따로
  });
});

describe("꿈(0.1.25)", () => {
  it("재료만 — 사용자 사실은 안 보이고 그림 목록에 번호, 고른 번호·그릴 것·깨서 할 말을 받는다", async () => {
    h.mems = MEMS;
    h.reply = { pick: "털실 산을 넘는 꿈", why: "", see: 2, draw: "", greet: "꿈에서 털실 산을 넘었어" };
    const d = await dreamThink(["은행잎 — 노랗다", "털실 뭉치"]);
    expect(d).toEqual({ text: "털실 산을 넘는 꿈", see: 2, draw: "", greet: "꿈에서 털실 산을 넘었어" });
    expect(h.sent).toContain("1. 은행잎 — 노랗다");
    expect(h.sent).toContain("비 오는 날을 좋아한다"); // 취향은 보인다
    expect(h.sent).not.toContain("김하린");
    expect(h.sent).not.toContain("한강로");
  });
  it("없는 번호는 0, 사실 조각이 든 꿈은 버리고, 실패하면 null(꿈 없이 잔다)", async () => {
    h.mems = MEMS;
    h.reply = { pick: "달을 쫓는 꿈", why: "", see: 9, draw: "달" };
    expect(await dreamThink(["털실"])).toMatchObject({ see: 0, draw: "달" });
    h.reply = { pick: "김하린이 나온 꿈", why: "" };
    expect(await dreamThink([])).toBeNull();
    h.fail = true;
    expect(await dreamThink([])).toBeNull();
  });
  it("꿈은 노트에 '꿈'으로, 깨서 할 말은 첫마디로. 하루 두 번·3시간 간격", async () => {
    await noteDream({ text: "생선 비가 내리는 꿈", see: 0, draw: "생선", greet: "꿈에 생선 비가 왔어" });
    const m = await loadMind();
    expect(m.notes[m.notes.length - 1]).toMatchObject({ kind: "dream", text: "생선 비가 내리는 꿈" });
    expect(await takeGreeting()).toBe("꿈에 생선 비가 왔어");
    const at = (d: number, hh: number) => new Date(2026, 10, d, hh).toISOString();
    const mk = (...ts: string[]) => ({ v: 1 as const, topics: [], notes: ts.map((t) => ({ at: t, kind: "dream" as const, text: "꿈" })) });
    expect(mayDream(mk(at(20, 9)), new Date(2026, 10, 20, 11))).toBe(false); // 3시간 안
    expect(mayDream(mk(at(20, 9)), new Date(2026, 10, 20, 12, 1))).toBe(true);
    expect(mayDream(mk(at(20, 3), at(20, 9)), new Date(2026, 10, 20, 15))).toBe(false); // 오늘 두 번
    expect(mayDream(mk(at(20, 3), at(20, 9)), new Date(2026, 10, 21, 9))).toBe(true); // 다음 날
  });
});
