// decor-draw.js 의 타입. 설계: docs/neko-gifts.md §4
import type { GiftShape } from "./gift-shape";
import type { NekoDecorSpot, NekoGiftSize } from "./neko-engine";

export interface DecorGeom { W: number; floorY: number; S: number }
/** setDecor 와 같은 모양(엔진 없이 그릴 때도 같은 걸 넘긴다) */
export type DecorItem = { id: string; shape: unknown; size?: NekoGiftSize; play?: unknown; lastPlayed?: number } & NekoDecorSpot;
export interface DecorBox { bd: { x0: number; x1: number; y0: number; y1: number; w: number; h: number }; u: number; w: number; h: number }

export const DECOR_SIZE: number;
export const WALL_GAP: number;
export const SIZE_K: Record<NekoGiftSize, number>;
export function sizeK(size: unknown): number;
export function decorDims(shape: GiftShape, k: number, S: number): DecorBox;
export function decorM(S: number): number;
export function wallSpan(h: number, g: DecorGeom): number;
export function decorAt(d: { surface: "floor" | "wall"; u: number; v?: number }, h: number, g: DecorGeom): [number, number];
export function spotOf(x: number, bottom: number, h: number, g: DecorGeom): NekoDecorSpot;
export function paintDecor(g: CanvasRenderingContext2D, shape: GiftShape, L: DecorBox & { x: number; bottom: number; onFloor: boolean }, geom: DecorGeom,
  o?: { shadow?: string; sc?: [number, number]; rot?: number; wob?: number; edge?: number }): void;
/**
 * 엔진 없이 선물만 그린다(모니터별 선물 창). 캔버스를 W×H(css px) × dpr 로 맞추고 다 지운 뒤 그린다.
 * 멈춘 모양이다 — 바뀔 때만 부르면 된다. scale 은 엔진 setScale 과 같은 값(0.35~1.4 로 묶임)
 */
export function drawDecor(canvas: HTMLCanvasElement, items: DecorItem[], o: { W: number; H: number; floorY: number; scale: number; dpr?: number; dark?: boolean }): void;
/** 이 점(css px)이 놓인 물건 위면 그 id. drawDecor 와 같은 자리 */
export function hitDecorAt(items: DecorItem[], o: { W: number; floorY: number; scale: number }, x: number, y: number): string | null;
