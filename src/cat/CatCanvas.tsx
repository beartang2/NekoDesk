import React, { useRef, useEffect, useState, useCallback } from "react";
import { SPRITE_FRAME_SIZE, SPRITE_SCALE, getAnimation } from "./spriteData";
import type { CatEmotion } from "../agent/types";
import { useTrackpadPet } from "../hooks/useTrackpadPet";
import { useCatStore } from "../stores/catStore";
import "./CatCanvas.css";

const HEARTS = ["♡", "♡", "♡", "✦", "˚"];
const HAPPY_HEARTS = ["♡", "♡", "✦", "★", "✿", "˚", "♡"];
const PET_DURATION_MS = 2000;
/**
 * 쓰다듬기가 끝나고 원래 감정으로 돌아가기 전에 잠깐 거치는 평소 모습.
 *
 * 곧장 넘어가면 하트를 띄우며 좋아하던 고양이가 다음 순간 상자에서 자고 있다.
 * 사이에 한 박자를 두면 "기뻐함 → 진정 → 원래 하던 것" 으로 읽힌다.
 */
const PET_SETTLE_MS = 1600;
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
 * 화면 배율에 맞춰 정수 확대율을 고른다.
 *
 * 레티나(배율 2)면 2.5 × 2 = 5 — 원본 1픽셀이 장치 픽셀 5칸 정사각형이 된다.
 * 소수로 확대하면 어떤 픽셀은 3칸, 어떤 픽셀은 2칸이 되어 그림이 준 비율이 깨진다.
 */
function pixelScale(): { device: number; css: number } {
  const dpr = window.devicePixelRatio || 1;
  const device = Math.max(1, Math.round(SPRITE_SCALE * dpr));
  return { device, css: device / dpr };
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

  const [scale] = useState(pixelScale);
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
      setPetEmotion("idle");
      petTimerRef.current = setTimeout(() => {
        setPetEmotion(null);
        petTimerRef.current = null;
      }, PET_SETTLE_MS);
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
            width={SPRITE_FRAME_SIZE * scale.device}
            height={SPRITE_FRAME_SIZE * scale.device}
            className="cat-canvas"
            style={{
              // CSS 크기는 장치 픽셀 수를 화면 배율로 되돌린 값이다. 여기서 한 번 더
              // 늘리면(예전엔 96 을 104 로 늘렸다) 정수 확대가 도로 무너진다.
              width: `${SPRITE_FRAME_SIZE * scale.css}px`,
              height: `${SPRITE_FRAME_SIZE * scale.css}px`,
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
