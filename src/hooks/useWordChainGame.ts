import { useState, useCallback } from "react";
import { wordChainReply } from "../agent/llm-client";
import type { CatEmotion } from "../agent/types";

export type WordChainPhase = "idle" | "user_turn" | "cat_turn" | "done";

export type WordChainResult =
  | { type: "invalid_start"; error: string }
  | { type: "duplicate"; error: string }
  | { type: "user_invalid"; word: string }
  | { type: "cat_word"; catWord: string }
  | { type: "cat_failed"; neededChar: string }
  | { type: "error" };

export interface WordChainGame {
  phase: WordChainPhase;
  lastChar: string;
  usedWords: string[];
  turnCount: number;
  currentWord: string;
  startGame: () => Promise<string | null>;
  submitWord: (word: string) => Promise<WordChainResult>;
  reset: () => void;
  endGame: () => void;
  disputeContext: () => string;
}

// ── 두음법칙 ─────────────────────────────────────────────────────────────────
// 한국어 음절 분해: 유니코드 한글 음절 = 가(0xAC00) + (초성*21 + 중성)*28 + 종성
const KO_BASE = 0xAC00;
// ㅑ(2) ㅒ(3) ㅕ(4) ㅖ(5) ㅛ(10) ㅠ(13) ㅣ(18) — 두음법칙 적용 대상 중성
const YI_VOWELS = new Set([2, 3, 4, 5, 10, 13, 18]);

function canonicalChosung(char: string): number | null {
  const code = char.charCodeAt(0) - KO_BASE;
  if (code < 0 || code > 11171) return null;
  const jung = Math.floor(code / 28) % 21;
  const cho = Math.floor(code / 28 / 21);
  // 두음법칙 적용
  if (cho === 5 /* ㄹ */) return YI_VOWELS.has(jung) ? 11 /* ㅇ */ : 2 /* ㄴ */;
  if (cho === 2 /* ㄴ */ && YI_VOWELS.has(jung)) return 11 /* ㅇ */;
  return cho;
}

// 다음 단어 시작 글자가 두음법칙을 포함하여 lastChar와 동치인지 확인
// 두음법칙은 lastChar의 초성이 ㄹ/ㄴ일 때만 적용 (ㅇ끼리 무조건 매칭 방지)
function matchesStartChar(word: string, lastChar: string): boolean {
  if (!lastChar) return true;
  if (word[0] === lastChar) return true;

  const lastCode = lastChar.charCodeAt(0) - KO_BASE;
  if (lastCode < 0 || lastCode > 11171) return false;
  const lastJung = Math.floor(lastCode / 28) % 21;
  const lastCho = Math.floor(lastCode / 28 / 21);

  const wordCode = word[0].charCodeAt(0) - KO_BASE;
  if (wordCode < 0 || wordCode > 11171) return false;
  const wordCho = Math.floor(wordCode / 28 / 21);

  // ㄹ + 이계 모음 → ㅇ 또는 ㄴ으로 시작 허용
  if (lastCho === 5 /* ㄹ */ && YI_VOWELS.has(lastJung)) {
    return wordCho === 11 /* ㅇ */ || wordCho === 2 /* ㄴ */;
  }
  // ㄴ + 이계 모음 → ㅇ으로 시작 허용
  if (lastCho === 2 /* ㄴ */ && YI_VOWELS.has(lastJung)) {
    return wordCho === 11 /* ㅇ */;
  }

  return false;
}

// 두음법칙 힌트 문자열 생성 (예: "녕" → "녕(=영)")
function dueumHint(lastChar: string): string {
  const code = lastChar.charCodeAt(0) - KO_BASE;
  if (code < 0 || code > 11171) return `"${lastChar}"`;
  const jong = code % 28;
  const jung = Math.floor(code / 28) % 21;
  const cho = Math.floor(code / 28 / 21);
  const canonical = canonicalChosung(lastChar)!;
  if (canonical === cho) return `"${lastChar}"`;
  // 두음법칙 적용 시 대표 글자 만들기 (종성 유지, 초성만 교체)
  const altChar = String.fromCharCode(KO_BASE + (canonical * 21 + jung) * 28 + jong);
  return `"${lastChar}" (두음법칙: "${altChar}"도 가능)`;
}

// ─────────────────────────────────────────────────────────────────────────────

export function useWordChainGame(
  onEmotionChange: (emotion: CatEmotion, durationMs?: number) => void
): WordChainGame {
  const [phase, setPhase] = useState<WordChainPhase>("idle");
  const [lastChar, setLastChar] = useState("");
  const [usedWords, setUsedWords] = useState<string[]>([]);
  const [turnCount, setTurnCount] = useState(0);
  const [currentWord, setCurrentWord] = useState("");

  const startGame = useCallback(async (): Promise<string | null> => {
    setPhase("cat_turn");
    onEmotionChange("working", 20000);
    try {
      const word = await wordChainReply("", []);
      if (!word) throw new Error("empty");
      const char = word[word.length - 1];
      setCurrentWord(word);
      setLastChar(char);
      setUsedWords([word]);
      setTurnCount(1);
      setPhase("user_turn");
      onEmotionChange("curious", 60000);
      return word;
    } catch {
      setPhase("idle");
      return null;
    }
  }, [onEmotionChange]);

  const submitWord = useCallback(async (word: string): Promise<WordChainResult> => {
    const cleaned = word.trim();

    if (lastChar && !matchesStartChar(cleaned, lastChar)) {
      return { type: "invalid_start", error: `${dueumHint(lastChar)}로 시작하는 단어를 입력해줘!` };
    }
    if (usedWords.includes(cleaned)) {
      return { type: "duplicate", error: `"${cleaned}"는 이미 나온 단어야!` };
    }

    const newUsed = [...usedWords, cleaned];
    const userLastChar = cleaned[cleaned.length - 1];
    setUsedWords(newUsed);
    setCurrentWord(cleaned);
    setTurnCount(t => t + 1);
    setPhase("cat_turn");
    onEmotionChange("working", 15000);

    try {
      const catWord = await wordChainReply(userLastChar, newUsed, cleaned);
      if (catWord === "INVALID") {
        setUsedWords(usedWords); // 유저 단어 취소
        setCurrentWord(usedWords[usedWords.length - 1] ?? "");
        setPhase("done");
        onEmotionChange("proud", 8000);
        return { type: "user_invalid", word: cleaned };
      }
      if (!catWord || !matchesStartChar(catWord, userLastChar) || newUsed.includes(catWord)) {
        setPhase("done");
        onEmotionChange("sad", 8000);
        return { type: "cat_failed", neededChar: userLastChar };
      }
      const catLastChar = catWord[catWord.length - 1];
      setUsedWords([...newUsed, catWord]);
      setCurrentWord(catWord);
      setLastChar(catLastChar);
      setTurnCount(t => t + 1);
      setPhase("user_turn");
      onEmotionChange("happy", 4000);
      return { type: "cat_word", catWord };
    } catch {
      setPhase("done");
      return { type: "error" };
    }
  }, [lastChar, usedWords, onEmotionChange]);

  const reset = useCallback(() => {
    setPhase("idle");
    setLastChar("");
    setUsedWords([]);
    setTurnCount(0);
    setCurrentWord("");
  }, []);

  const endGame = useCallback(() => {
    setPhase("done");
  }, []);

  const disputeContext = useCallback((): string => {
    return `[끝말잇기 게임 중 | 지금까지 나온 단어: ${usedWords.join(" → ")} | 마지막 단어: "${currentWord}"] 유저가 방금 나온 단어에 이의를 제기했어. web search로 "${currentWord}"가 실제 한국어 단어(표준국어대사전)인지 확인해줘. 있으면 게임 계속이라고 하고, 없으면 내가 졌다고 하고 응답 끝에 [[GAME_OVER]]를 포함해줘.`;
  }, [usedWords, currentWord]);

  return { phase, lastChar, usedWords, turnCount, currentWord, startGame, submitWord, reset, endGame, disputeContext };
}
