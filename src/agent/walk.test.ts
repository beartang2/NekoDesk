// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmMessage } from "./types";

const { completion, subagent, save } = vi.hoisted(() => ({
  completion: vi.fn(),
  subagent: vi.fn(),
  save: vi.fn(async () => ({})),
}));

vi.mock("./llm-client", () => ({
  DEFAULT_CHAT_SYSTEM_PROMPT: "기본",
  fetchCompletionMessage: (...a: unknown[]) => completion(...a),
}));
vi.mock("./subagent", () => ({ runSubagent: (...a: unknown[]) => subagent(...a) }));
vi.mock("./memory-merge", () => ({ saveMemory: (...a: unknown[]) => save(...(a as [])) }));
vi.mock("./tool-registry", () => ({ getTool: () => ({ execute: vi.fn(async () => "맑음") }) }));
vi.mock("../api/tauri", () => ({
  memoryApi: { list: vi.fn(async () => []) },
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
  shelfApi: { add: vi.fn() },
}));

import { memoryApi } from "../api/tauri";
import { giftWeights, rollGift, startWalkBrain, type GiftKind } from "./walk";

const ALL: Record<GiftKind, boolean> = {
  trinket: true, place: true, weather: true, link: true, memory: true, drawing: true, game: true,
};
const report = (params: Record<string, unknown>) => ({
  text: "", reasoning: "", toolCalls: [{ id: "r", name: "walk_report", params }],
});

beforeEach(() => {
  completion.mockReset();
  subagent.mockReset();
  save.mockClear();
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
    const w = { ...giftWeights(ALL, []), trinket: 1, place: 0, weather: 3, link: 0, memory: 0, drawing: 0, game: 0 };
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

  it("주운 것은 모양을 검사해 선물함에 넣고, 일지에 알린다", async () => {
    const { useNekoGifts } = await import("../neko/gifts");
    useNekoGifts.setState({ gifts: [], loaded: true });
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // 무게 첫 칸 = 주운 것
    subagent.mockResolvedValueOnce("");
    completion.mockResolvedValueOnce(report({
      learned: [], diary: "d", gift_title: "병뚜껑", gift_body: "반짝여", gift_play: "roll",
      gift_shape: { parts: [{ t: "circle", x: 0, y: -6, r: 6, c: "silver" }, { t: "evil", code: "x" }] },
    }));
    const r = await startWalkBrain({ places: [], here: null }).result;
    rnd.mockRestore();
    expect(r.gift?.kind).toBe("trinket");
    expect(r.gift?.shape?.parts).toEqual([{ t: "circle", x: 0, y: -6, r: 6, c: "silver" }]);
    expect(r.content).toContain("선물함에 넣어 뒀어");
    expect(useNekoGifts.getState().gifts.map((g) => [g.title, g.play])).toEqual([["병뚜껑", "roll"]]);
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
      gift_shape: { parts: [{ t: "circle", x: 0, y: -6, r: 6, c: "red" }] },
    }));
    completion.mockResolvedValueOnce({ text: "", reasoning: "", toolCalls: [{ id: "f", name: "gift_shape_fix", params: {
      gift_shape: { parts: [{ t: "poly", round: 0, c: "red", pts: [[0, -20], [8, -6], [-8, -6]] }] },
    } }] });
    const r = await startWalkBrain({ places: [], here: null }).result;
    rnd.mockRestore(); gc.mockRestore(); td.mockRestore();
    const sent = completion.mock.calls[1][0] as LlmMessage[];
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
