// decor-draw.js 의 타입. 설계: docs/neko-gifts.md §4
import type { GiftShape } from "./gift-shape";
import type { NekoDecorSpot, NekoGiftSize } from "./neko-engine";

export interface DecorGeom { W: number; floorY: number; S: number }
/** setDecor 와 같은 모양(엔진 없이 그릴 때도 같은 걸 넘긴다) */
export type DecorItem = { id: string; shape: unknown; size?: NekoGiftSize; play?: unknown; lastPlayed?: number; scale?: number; at?: "sidebar" | "dock" | "screen" } & NekoDecorSpot;
export interface DecorBox { bd: { x0: number; x1: number; y0: number; y1: number; w: number; h: number }; u: number; w: number; h: number }

export const DECOR_SIZE: number;
export const WALL_GAP: number;
export const SIZE_K: Record<NekoGiftSize, number>;
export function sizeK(size: unknown): number;
/** 사용자 배율 범위(새 기본 기준) */
export const SCALE_MIN: number;
export const SCALE_MAX: number;
/** 사용자 배율 0.5~3(이상하면 1) */
export function clampScale(s: unknown): number;
/** 선 고양이 키(S 단위) */
export const CAT_H: number;
/** 자리별 물건 높이 상한(px): 방 0.8×floorY, 거실 floorY, 마당 고양이 키 3배. 장소를 모르면 Infinity */
export function capPx(at: "sidebar" | "dock" | "screen" | undefined, g: { floorY: number; S: number }): number;
/** 그릴 배율 = 크기 × 사용자 배율, 그 자리 상한까지. capped = 상한에 걸림 */
export function decorK(shape: GiftShape, size: unknown, scale: unknown, at: "sidebar" | "dock" | "screen" | undefined, g: { floorY: number; S: number }): { k: number; capped: boolean };
export function decorDims(shape: GiftShape, k: number, S: number): DecorBox;
export function decorM(S: number): number;
export function wallSpan(h: number, g: DecorGeom): number;
/** 벽에 건 것(at 이 방·거실, 폭 w 를 줄 때)은 날씨 창문과 겹치면 창턱 아래로 내려 그린다 */
export function decorAt(d: { surface: "floor" | "wall"; u: number; v?: number; at?: string }, h: number, g: DecorGeom, w?: number): [number, number];
/** 고양이보다 높은 거실(폰 가로 화면)의 기준 바닥 높이와 그때 선물 배율(고양이 대비 70%) */
export const TALL_DOCK_Y: number;
export const TALL_DOCK_K: number;
export function spotOf(x: number, bottom: number, h: number, g: DecorGeom): NekoDecorSpot;
export function paintDecor(g: CanvasRenderingContext2D, shape: GiftShape, L: DecorBox & { x: number; bottom: number; onFloor: boolean }, geom: DecorGeom,
  o?: { shadow?: string; sc?: [number, number]; rot?: number; wob?: number; edge?: number }): void;
/** 끄는 중인 물건(높이 h)을 무대 안에 묶는다(엔진 끌기와 같다). [x, bottom] */
export function clampDrag(h: number, g: DecorGeom, x: number, bottom: number): [number, number];
export const FALL_G: number;
export const FALL_VMAX: number;
export const FALL_BOUNCE: number;
/** 던진 물건 떨어뜨리기 한 걸음(고양이와 같은 중력·튕김). f 를 고친다. 바닥에 내려앉아 멈추면 true */
export function fallStep(f: { x: number; bottom: number; vx: number; vy: number }, dt: number, g: { W: number; floorY: number; S: number }): boolean;
/** 사용자가 끄는 물건: 물건 가운데 x, 바닥 y(css px). 잡은 점과 칸 가운데·바닥의 차이는 창이 기억해 뺀다 */
export interface DecorDrag { id: string; x: number; bottom: number }
interface DecorView { W: number; floorY: number; scale: number }
/**
 * 엔진 없이 선물만 그린다(모니터별 선물 창). 캔버스를 W×H(css px) × dpr 로 맞추고 다 지운 뒤 그린다.
 * 멈춘 모양이다 — 바뀔 때만 부르면 된다. scale 은 엔진 setScale 과 같은 값(0.35~1.4 로 묶임).
 * drag: 끄는 물건을 그 자리(엔진처럼 묶음)에 들어 올린 모양으로 맨 위에
 */
export function drawDecor(canvas: HTMLCanvasElement, items: DecorItem[],
  o: { W: number; H: number; floorY: number; scale: number; dpr?: number; dark?: boolean; drag?: DecorDrag | null }): void;
/** 놓인 물건마다 그린 칸(css px, 그린 순서). 누르기 판정·'정리' 버튼 자리(엔진은 x + w, y) */
export function decorBoxes(items: DecorItem[], o: DecorView): { id: string; x: number; y: number; w: number; h: number }[];
/** 이 점(css px)이 놓인 물건 위면 그 id(위에 그린 것부터). drawDecor 와 같은 자리 */
export function hitDecorAt(items: DecorItem[], o: DecorView, x: number, y: number): string | null;
/** 끄는 중: 실제로 그릴 자리(묶음)와 놓을 자리(spot → gifts place). 없는 id 면 null */
export function dragDecor(items: DecorItem[], o: DecorView, id: string, x: number, bottom: number): { x: number; bottom: number; spot: NekoDecorSpot } | null;
