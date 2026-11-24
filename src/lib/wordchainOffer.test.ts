import { describe, expect, it } from "vitest";
import { OFFER_TTL_MS, parseOffer, pendingOffer, repliesTo, type WordchainOffer } from "./wordchainOffer";

/** 산책 선물 끝말잇기 대기(0.1.32, 사용자: 선물 낱말에 바로 답하면 게임이 이어지게) */
const offer: WordchainOffer = { game: "wordchain", word: "사과", at: 1_000 };
const a = (o?: WordchainOffer) => ({ role: "assistant", ...(o ? { offer: o } : {}) });
const u = { role: "user" };

describe("대기 중인 첫 낱말", () => {
  it("마지막 메시지가 그 선물이면 대기 — 그 뒤에 사용자 말이 있으면(다른 얘기) 끝, 시간이 지나도 끝", () => {
    expect(pendingOffer([u, a(offer)], 2_000)).toEqual(offer);
    expect(pendingOffer([a(offer), a()], 2_000)).toEqual(offer); // 네코 말(브리핑 등)만 뒤에 붙었으면 그대로
    expect(pendingOffer([a(offer), u], 2_000)).toBeNull();
    expect(pendingOffer([a(offer), u, a()], 2_000)).toBeNull();
    expect(pendingOffer([a(offer)], 1_000 + OFFER_TTL_MS)).toBeNull();
    expect(pendingOffer([a()], 2_000)).toBeNull();
  });
  it("이어 답했는가: 한글 낱말 하나, 끝 글자로 시작(두음법칙 포함)", () => {
    expect(repliesTo(offer, " 과자 ")).toBe(true);
    expect(repliesTo(offer, "바다")).toBe(false);
    expect(repliesTo(offer, "좋아 하자")).toBe(false);
    expect(repliesTo({ ...offer, word: "신라" }, "나비")).toBe(true);
  });
  it("동기화로 받은 값은 검사해 읽는다", () => {
    expect(parseOffer({ game: "wordchain", word: "사과", at: 5 })).toEqual({ game: "wordchain", word: "사과", at: 5 });
    expect(parseOffer({ game: "wordchain", word: "a", at: 5 })).toBeUndefined();
    expect(parseOffer({ game: "drawing", word: "사과", at: 5 })).toBeUndefined();
    expect(parseOffer(null)).toBeUndefined();
  });
});
