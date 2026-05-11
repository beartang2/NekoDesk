import type { CatEmotion } from "../agent/types";
import jumpCatUrl from "../assets/cat/jumpcat.png";
import mochiIdleUrl from "../assets/cat/mochi-idle.png";
import mochiBoxUrl from "../assets/cat/mochi-box.png";
import sleepingCatUrl from "../assets/cat/sleepingcat1.png";
import sleepingCat2Url from "../assets/cat/sleepingcat2.png";
import sleepingCat3Url from "../assets/cat/sleepingcat3.png";
import sleepingCat4Url from "../assets/cat/sleepingcat4.png";
import sleepingCat5Url from "../assets/cat/sleepingcat5.png";

export interface SpriteFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AnimDef {
  src: string;
  frames: SpriteFrame[];
  interval: number;
  scale: number;
  recolor: boolean;
  offsetX: number;
  offsetY: number;
}

export interface CatVariant {
  id: string;
  name: string;
  swatchCss: string;
  coat: {
    light: string;
    base: string;
    shadow: string;
  };
  sleepySrc: string;
}

export const CANVAS_WIDTH = 96;
export const CANVAS_HEIGHT = 104;
export const DISPLAY_WIDTH = 104;
export const DISPLAY_HEIGHT = 112;
export const DEFAULT_VARIANT_ID = "cream";

function stripFrames(frameWidth: number, frameHeight: number, count: number): SpriteFrame[] {
  return Array.from({ length: count }, (_, index) => ({
    x: index * frameWidth,
    y: 0,
    w: frameWidth,
    h: frameHeight,
  }));
}

function gridFrames(
  frameWidth: number,
  frameHeight: number,
  cells: Array<readonly [col: number, row: number]>
): SpriteFrame[] {
  return cells.map(([col, row]) => ({
    x: col * frameWidth,
    y: row * frameHeight,
    w: frameWidth,
    h: frameHeight,
  }));
}

const BASE_ANIMATIONS: Record<CatEmotion, AnimDef> = {
  idle: {
    src: mochiIdleUrl,
    frames: stripFrames(32, 32, 10),
    interval: 180,
    scale: 2.1,
    recolor: true,
    offsetX: 4,
    offsetY: 0,
  },
  curious: {
    src: mochiIdleUrl,
    frames: [
      ...stripFrames(32, 32, 3),
      ...stripFrames(32, 32, 2).slice(1),
    ],
    interval: 210,
    scale: 2.1,
    recolor: true,
    offsetX: 4,
    offsetY: 0,
  },
  working: {
    src: jumpCatUrl,
    frames: stripFrames(32, 32, 13),
    interval: 95,
    scale: 2.05,
    recolor: true,
    offsetX: 0,
    offsetY: 0,
  },
  happy: {
    src: jumpCatUrl,
    frames: stripFrames(32, 32, 13),
    interval: 80,
    scale: 2.05,
    recolor: true,
    offsetX: 0,
    offsetY: 0,
  },
  proud: {
    src: mochiIdleUrl,
    frames: [0, 1, 2, 1].map((index) => stripFrames(32, 32, 3)[index] ?? stripFrames(32, 32, 3)[0]),
    interval: 220,
    scale: 2.1,
    recolor: true,
    offsetX: 4,
    offsetY: 0,
  },
  sleepy: {
    src: sleepingCatUrl,
    frames: stripFrames(64, 64, 6),
    interval: 260,
    scale: 1.08,
    recolor: false,
    offsetX: 0,
    offsetY: 0,
  },
  error: {
    src: mochiIdleUrl,
    frames: [3, 4, 5, 4].map((index) => stripFrames(32, 32, 6)[index] ?? stripFrames(32, 32, 6)[0]),
    interval: 180,
    scale: 2.1,
    recolor: true,
    offsetX: 4,
    offsetY: 0,
  },
  cozy: {
    src: mochiBoxUrl,
    frames: stripFrames(32, 32, 4),
    interval: 300,
    scale: 2.1,
    recolor: true,
    offsetX: 4,
    offsetY: 0,
  },
};

export const CAT_VARIANTS: CatVariant[] = [
  {
    id: "cream",
    name: "크림",
    swatchCss: "linear-gradient(135deg, #f4e9d5 0%, #f4e9d5 50%, #b08a67 50%, #b08a67 100%)",
    coat: {
      light: "#f4e9d5",
      base: "#d6b898",
      shadow: "#b08a67",
    },
    sleepySrc: sleepingCatUrl,
  },
  {
    id: "brown",
    name: "브라운",
    swatchCss: "linear-gradient(135deg, #c49b74 0%, #c49b74 50%, #7f5a41 50%, #7f5a41 100%)",
    coat: {
      light: "#d8b28b",
      base: "#b27f5c",
      shadow: "#7f5a41",
    },
    sleepySrc: sleepingCat2Url,
  },
  {
    id: "orange",
    name: "치즈",
    swatchCss: "linear-gradient(135deg, #f1a24b 0%, #f1a24b 50%, #c7691e 50%, #c7691e 100%)",
    coat: {
      light: "#ffc67a",
      base: "#ee9641",
      shadow: "#c7691e",
    },
    sleepySrc: sleepingCat3Url,
  },
  {
    id: "gray",
    name: "그레이",
    swatchCss: "linear-gradient(135deg, #8a8c93 0%, #8a8c93 50%, #50525a 50%, #50525a 100%)",
    coat: {
      light: "#afb2bb",
      base: "#7e818b",
      shadow: "#50525a",
    },
    sleepySrc: sleepingCat4Url,
  },
  {
    id: "white",
    name: "화이트",
    swatchCss: "linear-gradient(135deg, #f4f4f2 0%, #f4f4f2 50%, #c9c9c6 50%, #c9c9c6 100%)",
    coat: {
      light: "#fafaf7",
      base: "#ecebe7",
      shadow: "#c9c9c6",
    },
    sleepySrc: sleepingCat5Url,
  },
];

export function getCatVariant(id: string): CatVariant {
  return CAT_VARIANTS.find((variant) => variant.id === id) ?? CAT_VARIANTS[0];
}

export function getAnimation(emotion: CatEmotion, variantId: string): AnimDef {
  const variant = getCatVariant(variantId);
  const animation = BASE_ANIMATIONS[emotion] ?? BASE_ANIMATIONS.idle;
  if (emotion !== "sleepy") return animation;
  return {
    ...animation,
    src: variant.sleepySrc,
  };
}
