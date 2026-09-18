import React, { useRef, useEffect, useState, useCallback } from "react";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  getAnimation,
} from "./spriteData";
import type { CatEmotion } from "../agent/types";
import { useTrackpadPet } from "../hooks/useTrackpadPet";
import { useCatStore } from "../stores/catStore";
import "./CatCanvas.css";

const HEARTS = ["♡", "♡", "♡", "✦", "˚"];
const HAPPY_HEARTS = ["♡", "♡", "✦", "★", "✿", "˚", "♡"];
const PET_DURATION_MS = 2000;
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

export function CatCanvas({ emotion, onPet }: CatCanvasProps) {
  const variantId = useCatStore((s) => s.variantId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [petEmotion, setPetEmotion] = useState<CatEmotion | null>(null);
  const [hearts, setHearts] = useState<Heart[]>([]);
  const petTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const petCountRef = useRef(0);
  const petResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const displayEmotion = petEmotion ?? emotion;
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
      setPetEmotion(null);
      petTimerRef.current = null;
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

      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      const drawWidth = Math.round(frame.w * anim.scale);
      const drawHeight = Math.round(frame.h * anim.scale);
      const drawX = Math.floor((CANVAS_WIDTH - drawWidth) / 2) + anim.offsetX + 6;
      const drawY = Math.floor(CANVAS_HEIGHT - drawHeight - 4) + anim.offsetY - 6;

      ctx.drawImage(
        image,
        frame.x,
        frame.y,
        frame.w,
        frame.h,
        drawX,
        drawY,
        drawWidth,
        drawHeight
      );
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
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            className="cat-canvas"
            style={{
              imageRendering: "pixelated",
              width: `${DISPLAY_WIDTH}px`,
              height: `${DISPLAY_HEIGHT}px`,
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
