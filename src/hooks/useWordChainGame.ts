import { useState, useCallback } from "react";
import { wordChainReply } from "../agent/word-chain";
import { dueumAlternative, isPlayableWord, matchesStartChar } from "../lib/hangul";
import type { CatEmotion } from "../agent/types";

export type WordChainPhase = "idle" | "user_turn" | "cat_turn" | "done";

export type WordChainResult =
  | { type: "invalid_word"; error: string }
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

// 두음법칙 판정은 lib/hangul 이 혼자 안다. 예전에는 이 파일 안에 규칙이 세 벌
// (canonicalChosung · matchesStartChar · dueumHint) 있었고 서로 어긋나 있었다.

/** 이어받을 글자 안내. 두음법칙으로 바꿔 쓸 수 있으면 같이 알려준다. */
function startCharHint(lastChar: string): string {
  const alt = dueumAlternative(lastChar);
  return alt ? `"${lastChar}" (두음법칙: "${alt}"도 가능)` : `"${lastChar}"`;
}

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

    if (!isPlayableWord(cleaned)) {
      return {
        type: "invalid_word",
        error: [...cleaned].length < 2
          ? "두 글자 이상인 한글 단어를 입력해줘!"
          : "한글 단어만 낼 수 있어!",
      };
    }
    if (lastChar && !matchesStartChar(cleaned, lastChar)) {
      return { type: "invalid_start", error: `${startCharHint(lastChar)}로 시작하는 단어를 입력해줘!` };
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
        setTurnCount((t) => t - 1); // 무효 처리된 턴은 세지 않는다
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
