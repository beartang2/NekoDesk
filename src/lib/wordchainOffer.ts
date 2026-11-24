import { isPlayableWord, matchesStartChar } from "./hangul";

/**
 * 산책 선물로 네코가 꺼낸 끝말잇기 첫 낱말(0.1.32, 사용자: 선물로 끝말잇기 하자 했을 때 그 낱말에 바로 답하면 게임이 이어지게).
 * 선물 보고가 구조로 낸 낱말(walk_report game_word)이 산책 일지 메시지의 meta 에 실려 동기화된다 — 다른 기기에서 답해도 이어진다.
 * 그 메시지 뒤에 사용자 말이 없고 OFFER_TTL_MS 안이면 대기 중이다. 다른 말을 하면(그 뒤에 사용자 말이 생기면) 조용히 끝난다.
 */
export interface WordchainOffer {
  game: "wordchain";
  word: string;
  /** 선물을 남긴 때(ms) */
  at: number;
}

/** 산책은 자리를 비운 사이에 다녀오니 몇 시간 뒤에 답해도 받는다. 하루를 넘기면 끝 */
export const OFFER_TTL_MS = 12 * 3_600_000;

/** 받은 값 → 대기 낱말(망가졌으면 없음) */
export function parseOffer(raw: unknown): WordchainOffer | undefined {
  const r = (raw ?? null) as Record<string, unknown> | null;
  return r && r.game === "wordchain" && typeof r.word === "string" && isPlayableWord(r.word) && Number.isFinite(r.at)
    ? { game: "wordchain", word: r.word, at: r.at as number } : undefined;
}

/** 지금 대기 중인 첫 낱말: 마지막 메시지가 그 선물이고(뒤에 사용자 말 없음) 시간 안 */
export function pendingOffer(messages: { role: string; offer?: WordchainOffer }[], now: number): WordchainOffer | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return null;
    if (m.role === "assistant" && m.offer) return now - m.offer.at < OFFER_TTL_MS ? m.offer : null;
  }
  return null;
}

/** 사용자 말이 그 낱말에 이어 낸 낱말인가(한글 낱말 하나, 끝 글자로 시작 — 두음법칙 포함) */
export const repliesTo = (offer: WordchainOffer, text: string): boolean => {
  const t = text.trim();
  return isPlayableWord(t) && matchesStartChar(t, offer.word[offer.word.length - 1]);
};
