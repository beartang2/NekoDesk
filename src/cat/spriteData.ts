import type { CatEmotion } from "../agent/types";

/**
 * 고양이 스프라이트.
 *
 * 그림은 털색(변형)마다 폴더 하나, 상태마다 가로 스트립 한 장이다. 프레임은 모두
 * 32×32 이고 Idle 만 10칸, 나머지는 8칸이다.
 *
 * 예전엔 회색 고양이 한 장을 캔버스에서 픽셀 단위로 물들여 색을 만들었다. 털색마다
 * 그림이 따로 있는 지금은 그럴 일이 없다 — 눈·코·무늬까지 그림이 가진 그대로 나온다.
 */

/** 프레임 한 칸. 스트립이라 모두 같은 크기다. */
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
  offsetX: number;
  offsetY: number;
}

export interface CatVariant {
  id: string;
  name: string;
  /** 설정·빈 화면의 색 미리보기. 그림에서 가장 많이 쓰인 두 색이다. */
  swatchCss: string;
  /** src/assets/cat/variants 아래 폴더 이름. 파일 이름의 앞머리이기도 하다. */
  dir: string;
}

/** 그림에 있는 상태들. 감정(CatEmotion)보다 적어서 여럿이 한 그림을 나눠 쓴다. */
type CatState = "Idle" | "Pet" | "Happy" | "Sad" | "Box" | "Sleep";

const FRAME_SIZE = 32;
const FRAME_COUNT: Record<CatState, number> = {
  Idle: 10,
  Pet: 8,
  Happy: 8,
  Sad: 8,
  Box: 8,
  Sleep: 8,
};

export const CANVAS_WIDTH = 96;
export const CANVAS_HEIGHT = 104;
export const DISPLAY_WIDTH = 104;
export const DISPLAY_HEIGHT = 112;
export const DEFAULT_VARIANT_ID = "tabby";

/**
 * 스트립 URL 을 빌드 타임에 모은다.
 *
 * 30 장을 손으로 import 하면 색을 하나 추가할 때마다 6 줄을 더 적어야 하고, 한 줄을
 * 빠뜨려도 그 상태에서만 티가 난다. 폴더를 기준으로 읽으면 파일을 넣는 것이 곧 등록이다.
 */
const STRIPS = import.meta.glob<string>(
  [
    "../assets/cat/variants/*/*_*.png",
    // 한 장에 다 모아둔 참고용 시트는 코드가 안 쓴다. 빼지 않으면 빌드 결과에
    // 그대로 실린다(변형마다 한 장씩).
    "!../assets/cat/variants/*/*_AllStates_Sheet.png",
  ],
  { eager: true, query: "?url", import: "default" }
);

function stripUrl(dir: string, state: CatState): string {
  const path = `../assets/cat/variants/${dir}/${dir}_${state}.png`;
  const url = STRIPS[path];
  if (!url) {
    // 그림이 없으면 고양이가 통째로 사라진다. 어느 파일인지 바로 알 수 있게 알린다.
    console.warn(`[cat] 스프라이트가 없어: ${path}`);
  }
  return url ?? "";
}

function stripFrames(count: number): SpriteFrame[] {
  return Array.from({ length: count }, (_, index) => ({
    x: index * FRAME_SIZE,
    y: 0,
    w: FRAME_SIZE,
    h: FRAME_SIZE,
  }));
}

/**
 * 감정마다 어떤 그림을 어떤 속도로 쓸지.
 *
 * 그림이 여섯 갈래뿐이라 비슷한 감정은 같은 그림을 나눠 쓰되 속도로 결을 다르게 한다
 * (예: 기쁨은 빠르게, 뿌듯함은 느긋하게).
 */
const ANIMATIONS: Record<CatEmotion, { state: CatState; interval: number }> = {
  idle: { state: "Idle", interval: 200 },
  // 궁금할 때는 같은 앉은 자세를 조금 더 또랑또랑하게.
  curious: { state: "Idle", interval: 130 },
  // 일할 때는 상자 책상에 앉아 연필을 쥔 그림.
  working: { state: "Box", interval: 160 },
  happy: { state: "Happy", interval: 110 },
  // 쓰다듬는 중. 하트가 하나씩 올라온다.
  proud: { state: "Pet", interval: 150 },
  sleepy: { state: "Sleep", interval: 300 },
  sad: { state: "Sad", interval: 240 },
  // 실패했을 때도 시무룩한 그림을 쓴다 — 따로 그린 것이 없다.
  error: { state: "Sad", interval: 200 },
  // 같은 상자 그림을 느리게. 일하는 게 아니라 쉬는 결.
  cozy: { state: "Box", interval: 300 },
};

/** 32px 프레임을 96×104 캔버스에 채우는 배율. */
const SCALE = 2.6;

export const CAT_VARIANTS: CatVariant[] = [
  {
    id: "tabby",
    name: "고등어",
    swatchCss: "linear-gradient(135deg, #eeeff3 0%, #eeeff3 50%, #acaeb6 50%, #acaeb6 100%)",
    dir: "Tabby",
  },
  {
    id: "tuxedo",
    name: "턱시도",
    swatchCss: "linear-gradient(135deg, #fafafc 0%, #fafafc 50%, #4a4854 50%, #4a4854 100%)",
    dir: "Tuxedo",
  },
  {
    id: "calico",
    name: "삼색",
    swatchCss: "linear-gradient(135deg, #fcfaf6 0%, #fcfaf6 40%, #f2a860 40%, #f2a860 70%, #48424a 70%, #48424a 100%)",
    dir: "Calico",
  },
  {
    id: "siamese",
    name: "샴",
    swatchCss: "linear-gradient(135deg, #f9f3e8 0%, #f9f3e8 50%, #5c4032 50%, #5c4032 100%)",
    dir: "Siamese",
  },
  {
    id: "russianblue",
    name: "러시안블루",
    swatchCss: "linear-gradient(135deg, #acb4c4 0%, #acb4c4 50%, #8e98aa 50%, #8e98aa 100%)",
    dir: "RussianBlue",
  },
];

export function getCatVariant(id: string): CatVariant {
  return CAT_VARIANTS.find((variant) => variant.id === id) ?? CAT_VARIANTS[0];
}

export function getAnimation(emotion: CatEmotion, variantId: string): AnimDef {
  const variant = getCatVariant(variantId);
  const { state, interval } = ANIMATIONS[emotion] ?? ANIMATIONS.idle;
  return {
    src: stripUrl(variant.dir, state),
    frames: stripFrames(FRAME_COUNT[state]),
    interval,
    scale: SCALE,
    // CatCanvas 의 그리기 자리에 예전 그림에 맞춘 보정(+6, -6)이 박혀 있다.
    // 지금 그림은 프레임 한가운데 있어 그 보정을 여기서 상쇄한다.
    offsetX: -6,
    offsetY: 6,
  };
}
