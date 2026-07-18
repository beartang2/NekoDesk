import React, { useRef, useEffect, useState, useCallback } from "react";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  getAnimation,
  getCatVariant,
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

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  const value = parseInt(normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function pickCoatTone(
  luminance: number,
  palette: { light: { r: number; g: number; b: number }; base: { r: number; g: number; b: number }; shadow: { r: number; g: number; b: number } }
) {
  if (luminance > 188) return palette.light;
  if (luminance > 126) return palette.base;
  return palette.shadow;
}

function recolorCoat(ctx: CanvasRenderingContext2D, variantId: string) {
  const variant = getCatVariant(variantId);
  const mainPalette = {
    light: hexToRgb(variant.coat.light),
    base: hexToRgb(variant.coat.base),
    shadow: hexToRgb(variant.coat.shadow),
  };
  const imageData = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 0) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const pinkish = r > g + 20 && b > g - 10 && r > 120;
    const darkOutline = luminance < 58;
    const likelyCoat =
      saturation < 0.38 ||
      (r > g && g >= b && saturation < 0.62);

    if (pinkish || darkOutline || !likelyCoat) continue;

    const target = pickCoatTone(luminance, mainPalette);

    data[i] = target.r;
    data[i + 1] = target.g;
    data[i + 2] = target.b;
  }

  ctx.putImageData(imageData, 0, 0);
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

      if (anim.recolor) {
        recolorCoat(ctx, variantId);
      }
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
