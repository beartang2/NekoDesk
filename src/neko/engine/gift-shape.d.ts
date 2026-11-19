// gift-shape.js 의 타입. 설계: docs/neko-gifts.md §2

type GiftBase =
  | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink" | "brown"
  | "gray" | "white" | "black" | "gold" | "silver";
/** 팔레트 색. .dark 는 같은 색의 그늘, .light 는 밝은 쪽 */
export type GiftColor = GiftBase | `${GiftBase}.dark` | `${GiftBase}.light`;

export type GiftPart =
  | { t: "circle"; x: number; y: number; r: number; c: GiftColor }
  | { t: "ellipse"; x: number; y: number; rx: number; ry: number; rot: number; c: GiftColor }
  | { t: "rrect"; x: number; y: number; w: number; h: number; rad: number; rot: number; c: GiftColor }
  | { t: "poly"; pts: [number, number][]; round: number; c: GiftColor }
  | { t: "line"; pts: [number, number][]; w: number; c: GiftColor }
  | { t: "dot"; x: number; y: number; r: number; c: GiftColor };

/** 32×32 칸, 가운데 x = 0, 바닥 y = 0(위가 음수) */
export interface GiftShape {
  v: 1;
  parts: GiftPart[];
  /** 그림(작은 PNG data URL)을 칸(x, y 가운데, w×h) 안에 비율 그대로, 도형 위에. 채팅 낙서 액자. 모델에겐 안 알린다 */
  img?: { x: number; y: number; w: number; h: number; src: string };
  /** 스스로 빛나는 물건의 빛 색(팔레트 이름). 둘레에 은은한 빛무리를 그린다. 없으면 빛 없음 */
  glow?: GiftColor;
}

export const GIFT_PALETTE: Record<GiftBase, string>;
/** 툴 스키마에 줄 색 이름 전부(이름 · 이름.dark · 이름.light) */
export const GIFT_COLORS: GiftColor[];
export const DEFAULT_SHAPE: GiftShape;
/** 모델이 적은 값을 그릴 수 있는 꼴로. 쓸 만한 도형이 없으면 DEFAULT_SHAPE */
export function validateShape(raw: unknown): GiftShape;
export function shapeBounds(shape: GiftShape): { x0: number; x1: number; top: number; w: number; h: number };
/** img 의 data URL 길이 상한 */
export const IMG_MAX: number;
/** 그림(img)을 다 읽으면 부른다 — 한 번만 그리는 곳은 여기서 다시 그린다. 끄는 함수를 돌려준다 */
export function onShapeImage(fn: () => void): () => void;
/** 이미 그려 둔 그림(캔버스 등)을 그 data URL 로 넣어 둔다(읽기를 안 기다리게) */
export function primeShapeImage(src: string, source: CanvasImageSource): void;
/** (x, bottom) 에 그린다. unit = 한 칸의 px */
export function drawShape(ctx: CanvasRenderingContext2D, shape: GiftShape, x: number, bottom: number, unit: number, edge?: number): void;
