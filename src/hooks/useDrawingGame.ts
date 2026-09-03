import { useState, useRef, useCallback, useEffect } from "react";
import { generateGameWords, guessDrawing } from "../agent/drawing-game";
import type { CatEmotion } from "../agent/types";

// ── Types ──────────────────────────────────────────────────────────────────────

export type GamePhase =
  | "idle"
  | "setup"
  | "playing"
  | "guessing"
  | "round_result"
  | "done";

export interface GameConfig {
  mode: "mono" | "color";
  rounds: 3 | 5;
}

export interface DrawingGameState {
  phase: GamePhase;
  config: GameConfig;
  currentWord: string;
  timeLeft: number;
  round: number;
  totalRounds: number;
  score: number;
  speech: string | null;
  guessResult: string | null;
  isCorrect: boolean | null;
  timedOut: boolean;
}

export interface DrawingGameActions {
  startSetup: () => void;
  startGame: (config: GameConfig) => void;
  submitDrawing: (dataUrl: string) => void;
  nextRound: () => void;
  resetGame: () => void;
  updateConfig: (config: GameConfig) => void;
}

const INITIAL_CONFIG: GameConfig = { mode: "mono", rounds: 3 };
const DRAW_TIME = 30; // seconds per round

// ── Hook ───────────────────────────────────────────────────────────────────────

export function useDrawingGame(
  onEmotionChange: (emotion: CatEmotion, durationMs?: number) => void,
  onSpeechChange: (speech: string | null) => void,
  onCorrect?: () => void,
): DrawingGameState & DrawingGameActions {
  const [phase, setPhase] = useState<GamePhase>("idle");
  const [config, setConfig] = useState<GameConfig>(INITIAL_CONFIG);
  const [words, setWords] = useState<string[]>([]);
  const [round, setRound] = useState(0);
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState(DRAW_TIME);
  const [speech, setSpeech] = useState<string | null>(null);
  const [guessResult, setGuessResult] = useState<string | null>(null);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isSubmittingRef = useRef(false);

  // speech 변경 시 부모에도 전달
  const setSpeechBoth = useCallback((text: string | null) => {
    setSpeech(text);
    onSpeechChange(text);
  }, [onSpeechChange]);

  // 타이머 정리
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // playing 단계 진입 시 타이머 시작 (시간 초과 시 timedOut 신호)
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (phase !== "playing") {
      clearTimer();
      return;
    }
    setTimeLeft(DRAW_TIME);
    setTimedOut(false);
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearTimer();
          setSpeechBoth("시간 초과! 맞춰볼게...");
          onEmotionChange("curious", 999999);
          setTimedOut(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return clearTimer;
  }, [phase, clearTimer, setSpeechBoth, onEmotionChange]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const startSetup = useCallback(() => {
    setPhase("setup");
    setScore(0);
    setRound(0);
    setGuessResult(null);
    setIsCorrect(null);
    setSpeechBoth(null);
    onEmotionChange("curious", 999999);
  }, [setSpeechBoth, onEmotionChange]);

  const startGame = useCallback(async (cfg: GameConfig) => {
    setConfig(cfg);
    setScore(0);
    setRound(1);
    setGuessResult(null);
    setIsCorrect(null);
    setTimedOut(false);
    isSubmittingRef.current = false;
    setSpeechBoth(null);
    onEmotionChange("working", 999999);

    const fetched = await generateGameWords(cfg.rounds);
    setWords(fetched);

    setSpeechBoth("열심히 그려봐! ✏️");
    onEmotionChange("curious", 90000);
    setPhase("playing");
  }, [setSpeechBoth, onEmotionChange]);

  const submitDrawing = useCallback(async (dataUrl: string) => {
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    clearTimer();
    setPhase("guessing");
    setSpeechBoth("그림 보는 중...");
    onEmotionChange("curious", 999999);

    let guess = "모르겠어";
    try {
      guess = await guessDrawing(dataUrl);
    } catch {
      guess = "모르겠어";
    }

    const currentWord = words[round - 1] ?? "";
    const correct = guess === currentWord || currentWord.includes(guess) || guess.includes(currentWord);

    setGuessResult(guess);
    setIsCorrect(correct);

    if (correct) {
      setScore((s) => s + 1);
      setSpeechBoth(`맞아요! "${guess}" 정답! 🎉`);
      onEmotionChange("happy", 999999);
      onCorrect?.();
    } else {
      setSpeechBoth(`음... "${guess}"? 정답은 "${currentWord}"였어요!`);
      onEmotionChange("sad", 999999);
    }

    setPhase("round_result");
    isSubmittingRef.current = false;
  }, [clearTimer, setSpeechBoth, onEmotionChange, words, round]);

  const nextRound = useCallback(async () => {
    const nextRoundNum = round + 1;
    const totalRounds = config.rounds;

    if (nextRoundNum > totalRounds) {
      // 게임 종료
      const finalScore = score + (isCorrect ? 0 : 0); // score is already updated
      setPhase("done");
      if (finalScore === totalRounds) {
        setSpeechBoth(`완벽해요! ${finalScore}/${totalRounds} 만점! 🏆`);
        onEmotionChange("proud", 999999);
      } else if (finalScore >= Math.ceil(totalRounds / 2)) {
        setSpeechBoth(`잘했어요! ${finalScore}/${totalRounds}점! 🐱`);
        onEmotionChange("happy", 999999);
      } else {
        setSpeechBoth(`다음엔 더 잘할 수 있어! ${finalScore}/${totalRounds}점`);
        onEmotionChange("sleepy", 999999);
      }
      return;
    }

    setRound(nextRoundNum);
    setGuessResult(null);
    setIsCorrect(null);
    setTimedOut(false);
    isSubmittingRef.current = false;
    setSpeechBoth("열심히 그려봐! ✏️");
    onEmotionChange("curious", 90000);
    setPhase("playing");
  }, [round, config.rounds, score, isCorrect, setSpeechBoth, onEmotionChange, words]);

  const resetGame = useCallback(() => {
    clearTimer();
    setPhase("idle");
    setScore(0);
    setRound(0);
    setWords([]);
    setGuessResult(null);
    setIsCorrect(null);
    setSpeechBoth(null);
    onEmotionChange("idle", 100);
  }, [clearTimer, setSpeechBoth, onEmotionChange]);

  const updateConfig = useCallback((cfg: GameConfig) => {
    setConfig(cfg);
  }, []);

  return {
    phase,
    config,
    currentWord: words[round - 1] ?? "",
    timeLeft,
    round,
    totalRounds: config.rounds,
    score,
    speech,
    guessResult,
    isCorrect,
    timedOut,
    startSetup,
    startGame,
    submitDrawing,
    nextRound,
    resetGame,
    updateConfig,
  };
}
