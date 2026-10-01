import React, { useRef, useEffect, useState, useCallback } from "react";
import { SPRITE_DISPLAY_SIZE, getAnimation } from "./spriteData";
import type { CatEmotion } from "../agent/types";
import { useTrackpadPet } from "../hooks/useTrackpadPet";
import { useCatStore } from "../stores/catStore";
import "./CatCanvas.css";

const HEARTS = ["♡", "♡", "♡", "✦", "˚"];
const HAPPY_HEARTS = ["♡", "♡", "✦", "★", "✿", "˚", "♡"];
const PET_DURATION_MS = 2000;
/**
 * 쓰다듬기가 끝나고 원래 감정으로 돌아가기 전에 거치는 평소 모습.
 *
 * 곧장 넘어가면 하트를 띄우며 좋아하던 고양이가 다음 순간 상자에서 자고 있다.
 * 사이를 두되, 초 단위로 못 박지 않고 **평소 동작 몇 바퀴**로 센다. 그래야 꼬리가
 * 살랑이다 끊기지 않고 한 바퀴를 마친 자리에서 다음 상태로 넘어간다.
 */
const PET_SETTLE_CYCLES = 2.5;

/**
 * 그래도 이만큼은 머문다.
 *
 * 평소 동작의 한 바퀴 길이는 털색마다 다르다(치즈냥은 Idle 그림이 없어 3칸짜리
 * 대용이라 한 바퀴가 0.6초뿐이다). 바퀴 수로만 세면 그 아이만 눈 깜짝할 새 지나간다.
 */
const PET_SETTLE_MIN_MS = 3000;
const PET_HAPPY_THRESHOLD = 5; // 이 횟수 이상 쓰다듬으면 happy 애니메이션
const PET_RESET_MS = 3000;     // 마지막 쓰다듬기로부터 이 시간이 지나면 카운트 리셋

interface Heart {
  id: number;
  char: string;
  x: number;
}

let heartIdCounter = 0;

const imageCache = new Map<string, HTMLImageElement>();

function getSpriteImage(src: string): HTMLImageElement {
  const existing = imageCache.get(src);
  if (existing) return existing;

  const image = new Image();
  image.src = src;
  imageCache.set(src, image);
  return image;
}

// ── Canvas renderer ───────────────────────────────────────────────────────────

interface CatCanvasProps {
  emotion: CatEmotion;
  onPet?: () => void;
}

/**
 * 캔버스 백킹 버퍼 크기(장치 픽셀).
 *
 * 화면 크기는 `SPRITE_DISPLAY_SIZE` 로 고정이다. 여기서 정하는 건 그 자리에 장치
 * 픽셀을 몇 칸 채울지뿐 — 레티나면 두 배로 채워야 선명하다.
 */
function backingSize(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.max(1, Math.round(SPRITE_DISPLAY_SIZE * dpr));
}

export function CatCanvas({ emotion, onPet }: CatCanvasProps) {
  const variantId = useCatStore((s) => s.variantId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [petEmotion, setPetEmotion] = useState<CatEmotion | null>(null);
  const [hearts, setHearts] = useState<Heart[]>([]);
  const petTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const petCountRef = useRef(0);
  const petResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [backing] = useState(backingSize);
  const displayEmotion = petEmotion ?? emotion;

  // 평소 동작 한 바퀴 = 프레임 수 × 프레임 간격. 털색을 바꾸면 길이도 따라 바뀐다.
  const idleAnim = getAnimation("idle", variantId);
  const settleMsRef = useRef(PET_SETTLE_MIN_MS);
  settleMsRef.current = Math.max(
    idleAnim.frames.length * idleAnim.interval * PET_SETTLE_CYCLES,
    PET_SETTLE_MIN_MS
  );
  const anim = getAnimation(displayEmotion, variantId);

  const handlePet = useCallback(() => {

    // 쓰다듬기 횟수 증가
    petCountRef.current += 1;
    const isHappy = petCountRef.current >= PET_HAPPY_THRESHOLD;

    // 일정 시간 후 카운트 리셋
    if (petResetTimerRef.current) clearTimeout(petResetTimerRef.current);
    petResetTimerRef.current = setTimeout(() => {
      petCountRef.current = 0;
      petResetTimerRef.current = null;
    }, PET_RESET_MS);

    // 횟수에 따라 하트 개수/종류 변경
    const heartPool = isHappy ? HAPPY_HEARTS : HEARTS;
    const heartCount = isHappy ? 7 : 4;
    const newHearts: Heart[] = Array.from({ length: heartCount }, () => ({
      id: heartIdCounter++,
      char: heartPool[Math.floor(Math.random() * heartPool.length)],
      x: 10 + Math.random() * 80,
    }));
    setHearts((prev) => [...prev, ...newHearts]);
    setTimeout(() => {
      setHearts((prev) => prev.filter((h) => !newHearts.some((n) => n.id === h.id)));
    }, 1000);

    // 외부 콜백
    onPet?.();

    // 횟수에 따라 애니메이션 전환: 5회 이상이면 happy, 미만이면 proud
    const nextEmotion = isHappy ? "happy" : "proud";
    setPetEmotion(nextEmotion);
    if (petTimerRef.current) clearTimeout(petTimerRef.current);
    petTimerRef.current = setTimeout(() => {
      setPetEmotion("idle");
      petTimerRef.current = setTimeout(() => {
        setPetEmotion(null);
        petTimerRef.current = null;
      }, settleMsRef.current);
    }, PET_DURATION_MS);
  }, [onPet]);

  // 트랙패드로 쓰다듬기. 문지르는 동안 handlePet 이 (스로틀되어) 반복 호출된다.
  const { isPetting, togglePetting, onHoverMove, bindRef } = useTrackpadPet(handlePet);

  // 클릭: 한 번 쓰다듬고 + 쓰다듬기 모드(커서 숨김) 토글
  const handleClick = useCallback(() => {
    handlePet();
    togglePetting();
  }, [handlePet, togglePetting]);

  // Advance frame
  useEffect(() => {
    setFrameIdx(0);
    const id = setInterval(() => {
      setFrameIdx((prev) => (prev + 1) % anim.frames.length);
    }, anim.interval);
    return () => clearInterval(id);
  }, [emotion, anim.frames.length, anim.interval]);

  // Draw to canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const image = getSpriteImage(anim.src);

    const draw = () => {
      const frame = anim.frames[frameIdx] ?? anim.frames[0];
      if (!frame) return;

      // 캔버스가 프레임과 같은 크기라 여백 계산도, 자리 보정도 없다. 원본 1픽셀이
      // 화면의 정사각 N칸으로 그대로 확대된다.
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, canvas.width, canvas.height);
    };

    if (image.complete) {
      draw();
      return;
    }

    image.addEventListener("load", draw);
    return () => image.removeEventListener("load", draw);
  }, [frameIdx, anim, variantId]);

  return (
    <div className="cat-canvas-wrap">
      <div className={`cat-canvas-stage cat-canvas-stage--${displayEmotion}`}>
        <div
          ref={bindRef}
          className={`cat-canvas-pet-area${isPetting ? " cat-canvas-pet-area--petting" : ""}`}
          onClick={handleClick}
          onMouseMove={onHoverMove}
          // title={isPetting ? "트랙패드를 문질러 쓰다듬기 (Esc 로 종료)" : "클릭해서 쓰다듬기"}
        >
          <canvas
            ref={canvasRef}
            width={backing}
            height={backing}
            className="cat-canvas"
            style={{
              // 화면 크기는 모니터와 무관하게 이 값으로 고정이다. 백킹만 배율을 탄다.
              width: `${SPRITE_DISPLAY_SIZE}px`,
              height: `${SPRITE_DISPLAY_SIZE}px`,
            }}
          />
          {hearts.map((h) => (
            <span
              key={h.id}
              className="cat-heart"
              style={{ left: `${h.x}%` }}
            >
              {h.char}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
