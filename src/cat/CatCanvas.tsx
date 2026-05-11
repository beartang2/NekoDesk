import React, { useRef, useEffect, useState, useCallback } from "react";
import { Palette } from "lucide-react";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  CAT_VARIANTS,
  DEFAULT_VARIANT_ID,
  DISPLAY_HEIGHT,
  DISPLAY_WIDTH,
  getAnimation,
  getCatVariant,
} from "./spriteData";
import type { CatEmotion } from "../agent/types";
import "./CatCanvas.css";

const HEARTS = ["♡", "♡", "♡", "✦", "˚"];
const PET_DURATION_MS = 2000;

interface Heart {
  id: number;
  char: string;
  x: number;
}

let heartIdCounter = 0;

const imageCache = new Map<string, HTMLImageElement>();
const VARIANT_STORAGE_KEY = "nekodesk_cat_variant";

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const [variantId, setVariantId] = useState<string>(
    () => getCatVariant(localStorage.getItem(VARIANT_STORAGE_KEY) ?? DEFAULT_VARIANT_ID).id
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [petEmotion, setPetEmotion] = useState<CatEmotion | null>(null);
  const [hearts, setHearts] = useState<Heart[]>([]);
  const petTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const displayEmotion = petEmotion ?? emotion;
  const anim = getAnimation(displayEmotion, variantId);

  const handlePet = useCallback(() => {
    if (settingsOpen) return;
    // Add hearts
    const newHearts: Heart[] = Array.from({ length: 4 }, () => ({
      id: heartIdCounter++,
      char: HEARTS[Math.floor(Math.random() * HEARTS.length)],
      x: 20 + Math.random() * 60,
    }));
    setHearts((prev) => [...prev, ...newHearts]);
    setTimeout(() => {
      setHearts((prev) => prev.filter((h) => !newHearts.some((n) => n.id === h.id)));
    }, 1000);

    // 외부 콜백
    onPet?.();

    // Override emotion
    setPetEmotion("proud");
    if (petTimerRef.current) clearTimeout(petTimerRef.current);
    petTimerRef.current = setTimeout(() => {
      setPetEmotion(null);
      petTimerRef.current = null;
    }, PET_DURATION_MS);
  }, [settingsOpen]);

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
      const drawX = Math.floor((CANVAS_WIDTH - drawWidth) / 2) + anim.offsetX;
      const drawY = Math.floor(CANVAS_HEIGHT - drawHeight - 4) + anim.offsetY;

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

  const handleVariantChange = useCallback((id: string) => {
    setVariantId(id);
    localStorage.setItem(VARIANT_STORAGE_KEY, id);
    setSettingsOpen(false);
  }, []);

  return (
    <div className="cat-canvas-wrap">
      <div className={`cat-canvas-stage cat-canvas-stage--${displayEmotion}`}>
        <div className="cat-canvas-pet-area" onClick={handlePet} title="쓰다듬기">
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

        <button
          className="cat-skin-toggle"
          onClick={(e) => { e.stopPropagation(); setSettingsOpen((open) => !open); }}
          title="고양이 색상 선택"
        >
          <Palette size={11} />
        </button>

        {settingsOpen && (
          <div className="cat-skin-picker">
            <span className="cat-skin-picker__label">고양이 색상</span>
            {CAT_VARIANTS.map((variant) => (
              <button
                key={variant.id}
                className={`cat-skin-option ${variant.id === variantId ? "cat-skin-option--active" : ""}`}
                onClick={() => handleVariantChange(variant.id)}
              >
                <span
                  className="cat-skin-swatch"
                  style={{ background: variant.swatchCss }}
                />
                <span>{variant.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
