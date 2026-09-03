// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

/**
 * 게임 흐름 테스트. 두음법칙 자체는 lib/hangul 이 덮고, 여기서는 그 규칙이 실제
 * 게임에서 어떻게 쓰이는지(턴 전환, 되돌리기, 승패)를 본다.
 *
 * 고양이가 낼 단어는 시나리오마다 정해준다 — 모델을 부르지 않는다.
 */
const catReply = vi.fn();
vi.mock("../agent/word-chain", () => ({
  wordChainReply: (...args: unknown[]) => catReply(...args),
}));

import { useWordChainGame } from "./useWordChainGame";

const setup = () => renderHook(() => useWordChainGame(vi.fn()));

beforeEach(() => catReply.mockReset());

describe("끝말잇기 흐름", () => {
  it("두음법칙으로 이어받은 단어를 받아준다 — 예전엔 거부했다", async () => {
    catReply.mockResolvedValueOnce("안녕").mockResolvedValueOnce("어부");
    const { result } = setup();
    await act(async () => { await result.current.startGame(); });

    let outcome;
    await act(async () => { outcome = await result.current.submitWord("영어"); });

    expect(outcome).toMatchObject({ type: "cat_word", catWord: "어부" });
    expect(result.current.usedWords).toEqual(["안녕", "영어", "어부"]);
    expect(result.current.lastChar).toBe("부");
    expect(result.current.phase).toBe("user_turn");
  });

  it("ㄹ 이 ㄴ 으로 바뀌는 것도 받아준다 (라→나)", async () => {
    catReply.mockResolvedValueOnce("신라").mockResolvedValueOnce("비누");
    const { result } = setup();
    await act(async () => { await result.current.startGame(); });

    let outcome;
    await act(async () => { outcome = await result.current.submitWord("나비"); });
    expect(outcome).toMatchObject({ type: "cat_word" });
  });

  it("두음법칙이 아닌 변환은 거부하고, 안내는 실제 정답을 가리킨다", async () => {
    catReply.mockResolvedValueOnce("가루");
    const { result } = setup();
    await act(async () => { await result.current.startGame(); });

    let outcome!: { type: string; error?: string };
    await act(async () => {
      outcome = (await result.current.submitWord("우유")) as typeof outcome;
    });

    expect(outcome.type).toBe("invalid_start");
    expect(outcome.error).toContain("누"); // 루→누 가 맞는 변환
    expect(outcome.error).not.toContain("우유");
  });

  it("안내한 글자로 내면 반드시 통과한다", async () => {
    // 예전에는 "나도 가능" 이라 해놓고 "나비" 를 거부했다.
    catReply.mockResolvedValueOnce("신라");
    const { result } = setup();
    await act(async () => { await result.current.startGame(); });

    let rejected!: { error?: string };
    await act(async () => {
      rejected = (await result.current.submitWord("가방")) as typeof rejected;
    });
    const suggested = rejected.error!.match(/두음법칙: "(.)"/)![1];

    catReply.mockResolvedValueOnce("비누");
    let outcome;
    await act(async () => { outcome = await result.current.submitWord(suggested + "비"); });
    expect(outcome).toMatchObject({ type: "cat_word" });
  });

  it("이미 나온 단어는 거부한다", async () => {
    // 중복 검사에 닿으려면 이어받기 조건은 통과해야 한다 — 나비 → 비누 → 누나 →
    // 다시 나비. 시작 글자는 맞지만 이미 쓴 단어다.
    catReply.mockResolvedValueOnce("나비").mockResolvedValueOnce("누나");
    const { result } = setup();
    await act(async () => { await result.current.startGame(); });
    await act(async () => { await result.current.submitWord("비누"); });

    let outcome;
    await act(async () => { outcome = await result.current.submitWord("나비"); });
    expect(outcome).toMatchObject({ type: "duplicate" });
  });

  it("고양이가 못 이으면 진다", async () => {
    catReply.mockResolvedValueOnce("안녕").mockResolvedValueOnce("");
    const { result } = setup();
    await act(async () => { await result.current.startGame(); });

    let outcome;
    await act(async () => { outcome = await result.current.submitWord("영어"); });

    expect(outcome).toMatchObject({ type: "cat_failed", neededChar: "어" });
    expect(result.current.phase).toBe("done");
  });

  it("고양이가 없는 단어라고 하면 유저 단어를 되돌린다", async () => {
    catReply.mockResolvedValueOnce("안녕").mockResolvedValueOnce("INVALID");
    const { result } = setup();
    await act(async () => { await result.current.startGame(); });

    let outcome;
    await act(async () => { outcome = await result.current.submitWord("영어어"); });

    expect(outcome).toMatchObject({ type: "user_invalid", word: "영어어" });
    expect(result.current.usedWords).toEqual(["안녕"]);
    expect(result.current.currentWord).toBe("안녕");
    expect(result.current.phase).toBe("done");
  });

  it("reset 하면 처음 상태로 돌아간다", async () => {
    catReply.mockResolvedValueOnce("안녕");
    const { result } = setup();
    await act(async () => { await result.current.startGame(); });
    act(() => result.current.reset());

    expect(result.current.phase).toBe("idle");
    expect(result.current.usedWords).toEqual([]);
    expect(result.current.lastChar).toBe("");
    expect(result.current.turnCount).toBe(0);
  });
});
