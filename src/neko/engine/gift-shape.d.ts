// gift-shape.js 의 타입. 설계: docs/neko-gifts.md §2

export type GiftColor =
  | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink" | "brown"
  | "gray" | "white" | "black" | "gold" | "silver";

export type GiftPart =
  | { t: "circle"; x: number; y: number; r: number; c: GiftColor }
  | { t: "ellipse"; x: number; y: number; rx: number; ry: number; rot: number; c: GiftColor }
  | { t: "rrect"; x: number; y: number; w: number; h: number; rad: number; rot: number; c: GiftColor }
  | { t: "poly"; pts: [number, number][]; c: GiftColor }
  | { t: "dot"; x: number; y: number; c: GiftColor };

/** 32×32 칸, 가운데 x = 0, 바닥 y = 0(위가 음수) */
export interface GiftShape {
  v: 1;
  parts: GiftPart[];
}

export const GIFT_PALETTE: Record<GiftColor, string>;
export const DEFAULT_SHAPE: GiftShape;
/** 모델이 적은 값을 그릴 수 있는 꼴로. 쓸 만한 도형이 없으면 DEFAULT_SHAPE */
export function validateShape(raw: unknown): GiftShape;
export function shapeBounds(shape: GiftShape): { x0: number; x1: number; top: number; w: number; h: number };
/** (x, bottom) 에 그린다. unit = 한 칸의 px */
export function drawShape(ctx: CanvasRenderingContext2D, shape: GiftShape, x: number, bottom: number, unit: number, edge?: number): void;
