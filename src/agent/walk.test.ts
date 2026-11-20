// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmMessage } from "./types";

const { completion, subagent, save, topic, wonder, among } = vi.hoisted(() => ({
  completion: vi.fn(),
  subagent: vi.fn(),
  save: vi.fn(async () => ({})),
  topic: vi.fn(async (): Promise<string | null> => null),
  wonder: vi.fn(async () => {}),
  among: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock("./llm-client", () => ({
  DEFAULT_CHAT_SYSTEM_PROMPT: "기본",
  fetchCompletionMessage: (...a: unknown[]) => completion(...a),
}));
vi.mock("./subagent", () => ({ runSubagent: (...a: unknown[]) => subagent(...a) }));
vi.mock("./memory-merge", () => ({ saveMemory: (...a: unknown[]) => save(...(a as [])) }));
// 생각하기(neko-mind)는 따로 시험한다. 여기선 고른 주제가 하위 에이전트에 어떻게 가는지만
vi.mock("./neko-mind", () => ({
  chooseWalkTopic: (...a: unknown[]) => topic(...(a as [])),
  noteWonder: (...a: unknown[]) => wonder(...(a as [])),
  chooseAmong: (...a: unknown[]) => among(...(a as [])),
}));
vi.mock("./tool-registry", () => ({ getTool: () => ({ execute: vi.fn(async () => "맑음") }) }));
vi.mock("../api/tauri", () => ({
  memoryApi: { list: vi.fn(async () => []) },
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
  shelfApi: { add: vi.fn() },
}));

import { memoryApi } from "../api/tauri";
import { giftWeights, rollGift, startWalkBrain, type GiftKind } from "./walk";

const ALL: Record<GiftKind, boolean> = {
  trinket: true, place: true, weather: true, link: true, memory: true, drawing: true, game: true, furniture: true,
};
const report = (params: Record<string, unknown>) => ({
  text: "", reasoning: "", toolCalls: [{ id: "r", name: "walk_report", params }],
});

beforeEach(() => {
  completion.mockReset();
  subagent.mockReset();
  save.mockClear();
  topic.mockReset(); topic.mockResolvedValue(null);
  among.mockReset(); among.mockResolvedValue(null);
  wonder.mockClear();
});

describe("선물 굴리기", () => {
  it("못 주는 종류는 0, 최근 5번에 나온 만큼 반씩 깎인다", () => {
    const w = giftWeights({ ...ALL, place: false, drawing: false }, ["game", "trinket", "trinket"]);
    expect(w.place).toBe(0);
    expect(w.drawing).toBe(0);
    expect(w.trinket).toBe(giftWeights(ALL, []).trinket / 4);
    expect(w.game).toBe(giftWeights(ALL, []).game / 2);
    // 5번보다 오래된 건 안 센다.
    expect(giftWeights(ALL, ["game", "trinket", "trinket", "trinket", "trinket", "trinket"]).game).toBe(
      giftWeights(ALL, []).game
    );
  });

  it("주입한 난수로 무게 구간을 고른다", () => {
    const w = { ...giftWeights(ALL, []), trinket: 1, place: 0, weather: 3, link: 0, memory: 0, drawing: 0, game: 0, furniture: 0 };
    expect(rollGift(w, () => 0)).toBe("trinket");
    expect(rollGift(w, () => 0.24)).toBe("trinket");
    expect(rollGift(w, () => 0.26)).toBe("weather");
    expect(rollGift(w, () => 0.999)).toBe("weather");
  });
});

describe("산책 머리", () => {
  it("인상 깊다고 여러 개 표시해도 오래 기억하는 건 하나뿐이다", async () => {
    subagent.mockResolvedValueOnce("고양이 수염은 폭을 잰다");
    completion.mockResolvedValueOnce(report({
      learned: [
        { content: "수염으로 폭을 잰다", impressive: true },
        { content: "고양이는 단맛을 못 느낀다", impressive: true },
        { content: "골목 이름", impressive: false },
      ],
      diary: "골목을 걸었어.",
      gift_title: "나뭇잎",
      gift_body: "빨갛게 물든 거야.",
    }));

    const r = await startWalkBrain({ places: [], here: null }).result;

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]).toEqual([expect.stringContaining("수염으로 폭을 잰다"), "neko"]);
    // 나머지는 이 대화의 단기기억으로만.
    expect(r.prompt).toContain("고양이는 단맛을 못 느낀다");
    expect(r.prompt.startsWith(r.content)).toBe(true);
    expect(r.content).toContain("골목을 걸었어.");
    expect(r.gift?.title).toBe("나뭇잎");
  });

  it("조사는 바깥 툴로만 한다", async () => {
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({ learned: [], diary: "d", gift_title: "t", gift_body: "b" }));
    await startWalkBrain({ places: [], here: null }).result;
    expect(subagent.mock.calls[0][2]).toEqual(["web.search", "weather.get"]);
  });

  it("검색 지시엔 사용자 기억을 넣지 않는다 — 네코 제 기억(지난 산책)만", async () => {
    vi.mocked(memoryApi.list).mockResolvedValueOnce([
      { id: 1, kind: "preference", content: "사용자는 비밀 프로젝트 X 를 한다", created_at: "", use_count: 0 },
      { id: 2, kind: "neko", content: "산책하다 알게 됨: 고양이는 하루 16시간 잔다", created_at: "", use_count: 0 },
    ]);
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({ learned: [], diary: "d", gift_title: "t", gift_body: "b" }));
    await startWalkBrain({ places: [], here: null }).result;
    const task = subagent.mock.calls[0][0] as string;
    expect(task).not.toContain("비밀 프로젝트");
    expect(task).toContain("16시간");
  });

  it("네코가 고른 주제는 한 줄만 하위 에이전트에 가고, 다음에 궁금한 것은 노트로 남긴다", async () => {
    vi.mocked(memoryApi.list).mockResolvedValueOnce([
      { id: 1, kind: "fact", content: "사용자의 동생 이름은 김하린이다", created_at: "", use_count: 0 },
    ]);
    topic.mockResolvedValueOnce("비 오는 날 새들의 쉼터");
    among.mockResolvedValueOnce("trinket"); // 사용자 기억 선물(memory)이 굴러 나오면 궁금한 것을 일부러 안 남긴다 — 그 길은 따로 본다
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({ learned: [], diary: "d", gift_title: "t", gift_body: "b", next_wonder: "새 둥지는 젖을까" }));
    await startWalkBrain({ places: [], here: null }).result;
    const task = subagent.mock.calls[0][0] as string;
    expect(task).toContain("이번엔 '비 오는 날 새들의 쉼터'가 궁금해서 나왔어");
    expect(task).not.toContain("김하린");
    expect(wonder).toHaveBeenCalledWith("새 둥지는 젖을까", expect.any(Array));
  });

  it("가져갈 선물은 네코가 고른 것(가능한 것 중에서), 사용자 기억 선물이면 다음에 궁금한 것을 안 남긴다", async () => {
    vi.mocked(memoryApi.list).mockResolvedValueOnce([
      { id: 1, kind: "preference", content: "사용자는 비를 좋아한다", created_at: "", use_count: 0 },
    ]);
    among.mockResolvedValueOnce("memory");
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({ learned: [], diary: "d", gift_title: "t", gift_body: "b", next_wonder: "다음엔 뭘 볼까" }));
    const r = await startWalkBrain({ places: [], here: null }).result;
    expect(r.gift?.kind).toBe("memory");
    const offered = (among.mock.calls[0] as unknown[])[2] as { key: string }[];
    expect(offered.map((c) => c.key)).not.toContain("place"); // 들른 곳이 없으면 보기에도 없다
    expect(wonder).not.toHaveBeenCalled();
  });

  it("가구를 물어오면 선물함이 아니라 가구 탭으로(무엇처럼 쓰는지와 함께), 7일 안에 물어왔으면 보기에서 빠진다", async () => {
    const { useNekoFurniture } = await import("../neko/furniture");
    among.mockResolvedValueOnce("furniture");
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({ learned: [], diary: "d", gift_title: "등나무 의자", gift_body: "공원 벤치 옆에서 봤어", furniture_kind: "sofa" }));
    const r = await startWalkBrain({ places: [], here: null }).result;
    expect(r.content).toContain("가구 탭에 넣어 뒀어");
    await new Promise((ok) => setTimeout(ok, 20));
    expect(useNekoFurniture.getState().items.find((f) => f.title === "등나무 의자")).toMatchObject({ kind: "sofa", body: "공원 벤치 옆에서 봤어" });
    // 최근 7일 안에 물어왔다 → 다음 산책의 보기엔 가구가 없다
    const { settingsApi } = await import("../api/tauri");
    vi.mocked(settingsApi.get).mockImplementation(async (k: string) => (k === "neko_furniture" ? JSON.stringify({ v: 1, items: [{ id: "walk:a", kind: "sofa", found: new Date().toISOString().slice(0, 10), place: null }] }) : null));
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({ learned: [], diary: "d", gift_title: "t", gift_body: "b" }));
    await startWalkBrain({ places: [], here: null }).result;
    const offered = (among.mock.calls[among.mock.calls.length - 1] as unknown[])[2] as { key: string }[];
    expect(offered.map((c) => c.key)).not.toContain("furniture");
    vi.mocked(settingsApi.get).mockImplementation(async () => null);
  });

  it("주제를 못 고르면(생각하기 실패) 지금처럼 하위 에이전트가 스스로 고른다", async () => {
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({ learned: [], diary: "d", gift_title: "t", gift_body: "b" }));
    await startWalkBrain({ places: [], here: null }).result;
    expect(subagent.mock.calls[0][0]).toContain("지금 네가 궁금한 걸 하나 골라");
    expect(wonder).not.toHaveBeenCalled();
  });

  it("듣던 곡 제목은 하위 에이전트·보고에 안 들어가고, 느낌 한 줄만 간다", async () => {
    const vibe = { text: "잔잔한 재즈, 비 오는 밤 같은 분위기", reasoning: "", toolCalls: [] };
    completion.mockResolvedValueOnce(vibe).mockResolvedValueOnce(report({ learned: [], diary: "노래 들으며 걸었어", gift_title: "t", gift_body: "b" }));
    subagent.mockResolvedValueOnce("");
    const before = { music: true, activity: "typing", track: { title: "Autumn Leaves", artist: "Chet Baker" }, sleepy: true, at: new Date(2026, 10, 18, 20).getTime() };
    await startWalkBrain({ places: [], here: null, before, rand: () => 0.9 }).result;
    const task = subagent.mock.calls[0][0] as string;
    expect(task).toContain("잔잔한 재즈");
    expect(task).toContain("노트북 타이핑");
    expect(task).toContain("참고만");
    for (const leak of ["Autumn Leaves", "Chet Baker"]) {
      expect(task).not.toContain(leak);
      expect(JSON.stringify(completion.mock.calls[1][0])).not.toContain(leak); // 보고(일지)에도
    }
    expect(JSON.stringify(completion.mock.calls[1][0])).toContain("잔잔한 재즈"); // 일지가 상태에서 이어지게
    expect(JSON.stringify(completion.mock.calls[0][0])).toContain("Autumn Leaves"); // 제목은 느낌 호출만 본다
  });

  it("느낌 한 줄에 제목이 섞이면 버리고, 3번에 1번은 상태를 아예 안 넘긴다", async () => {
    completion.mockResolvedValueOnce({ text: "Autumn Leaves 같은 쓸쓸함", reasoning: "", toolCalls: [] })
      .mockResolvedValueOnce(report({ learned: [], diary: "d", gift_title: "t", gift_body: "b" }));
    subagent.mockResolvedValueOnce("");
    const before = { music: true, track: { title: "Autumn Leaves" } };
    await startWalkBrain({ places: [], here: null, before, rand: () => 0.9 }).result;
    expect(subagent.mock.calls[0][0]).not.toContain("Autumn Leaves");
    expect(subagent.mock.calls[0][0]).toContain("음악을 들으며 나왔어");

    completion.mockReset(); subagent.mockReset();
    completion.mockResolvedValueOnce(report({ learned: [], diary: "d", gift_title: "t", gift_body: "b" }));
    subagent.mockResolvedValueOnce("");
    await startWalkBrain({ places: [], here: null, before, rand: () => 0.1 }).result;
    expect(JSON.stringify(completion.mock.calls)).not.toContain("Autumn Leaves"); // 느낌 호출도 없다
    expect(subagent.mock.calls[0][0]).not.toContain("나가기 전");
  });

  it("한 문장을 넘는 건 오래 기억하지 않는다", async () => {
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({ learned: [{ content: "가".repeat(121), impressive: true }], diary: "d", gift_title: "t", gift_body: "b" }));
    await startWalkBrain({ places: [], here: null }).result;
    expect(save).not.toHaveBeenCalled();
  });

  it("abort 하면 reject 없이 그때까지 알아낸 것으로 보고한다", async () => {
    subagent.mockResolvedValueOnce("단풍은 기온이 떨어지면 든다 https://example.com/leaf");
    // 정리 단계에서 멈춰 있다가 abort 되면 끊긴다.
    completion.mockImplementation(
      (_m: LlmMessage[], _p: unknown, _u: unknown, signal: AbortSignal) =>
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
    );
    const brain = startWalkBrain({ places: [], here: null });
    await vi.waitFor(() => expect(completion).toHaveBeenCalled());
    brain.abort();

    const r = await brain.result;
    expect(r.content).toBeTruthy();
    expect(r.prompt).toContain("단풍은 기온이 떨어지면 든다");
    expect(save).not.toHaveBeenCalled();
  });

  it("주운 것은 모양을 검사해 선물함에 넣는다(일지엔 안내를 안 붙인다)", async () => {
    const { useNekoGifts } = await import("../neko/gifts");
    useNekoGifts.setState({ gifts: [], loaded: true });
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // 무게 첫 칸 = 주운 것
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({
      learned: [], diary: "d", gift_title: "병뚜껑", gift_body: "반짝여",
    }));
    // 그림은 이름이 정해진 뒤 따로 그린다(gift-draw.ts)
    completion.mockResolvedValueOnce({ text: "", reasoning: "", toolCalls: [{ id: "d", name: "gift_draw", params: {
      gift_play: "roll",
      gift_shape: { parts: [{ t: "circle", x: 0, y: -6, r: 6, c: "silver" }, { t: "evil", code: "x" }] },
    } }] });
    const r = await startWalkBrain({ places: [], here: null }).result;
    rnd.mockRestore();
    expect(r.gift?.kind).toBe("trinket");
    expect(r.gift?.shape?.parts).toEqual([{ t: "circle", x: 0, y: -6, r: 6, c: "silver" }]);
    expect(r.content).not.toContain("선물함"); // 일지엔 선물함 안내를 붙이지 않는다
    expect(JSON.stringify(completion.mock.calls[1][0])).toContain("그릴 물건: 병뚜껑");
    await vi.waitFor(() => expect(useNekoGifts.getState().gifts.map((g) => [g.title, g.play])).toEqual([["병뚜껑", "roll"]]));
  });

  it("그린 선물을 그림으로 보여 주고, 고친 모양이 오면 그걸 쓴다", async () => {
    // jsdom 엔 캔버스가 없어 그리기 함수만 받아 주는 가짜를 쓴다
    const ctx = new Proxy({}, { get: (_, k) => (k === "createLinearGradient" ? () => ({ addColorStop() {} }) : () => {}) });
    const gc = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const td = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AA");
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // 주운 것
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({
      learned: [], diary: "d", gift_title: "단풍잎", gift_body: "b",
    }));
    completion.mockResolvedValueOnce({ text: "", reasoning: "", toolCalls: [{ id: "d", name: "gift_draw", params: {
      gift_shape: { parts: [{ t: "circle", x: 0, y: -6, r: 6, c: "red" }] },
    } }] });
    completion.mockResolvedValueOnce({ text: "", reasoning: "", toolCalls: [{ id: "f", name: "gift_shape_fix", params: {
      gift_shape: { parts: [{ t: "poly", round: 0, c: "red", pts: [[0, -20], [8, -6], [-8, -6]] }] },
    } }] });
    const r = await startWalkBrain({ places: [], here: null }).result;
    rnd.mockRestore(); gc.mockRestore(); td.mockRestore();
    const sent = completion.mock.calls[2][0] as LlmMessage[];
    expect(JSON.stringify(sent[1].content)).toContain("data:image/png;base64,AA");
    expect(r.gift?.shape?.parts[0]).toMatchObject({ t: "poly", round: 0 });
  });

  it("조사가 매달려 있어도 abort 하면 바로 돌아온다", async () => {
    subagent.mockImplementation(() => new Promise(() => {}));
    const brain = startWalkBrain({ places: [], here: null });
    brain.abort();
    await expect(brain.result).resolves.toMatchObject({ content: "산책 다녀왔어.", gift: null });
  });
});
