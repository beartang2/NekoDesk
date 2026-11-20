import type { FurnitureKind } from "./furniture-art";

export type DreamContent = { shape: unknown } | { furniture: FurnitureKind; accent?: string };
export interface DreamOptions {
  /** 바라보는 쪽(±1) */
  face?: number;
  /** 0~1 나타나기(점 하나 → 점 둘 → 구름) */
  k?: number;
  /** 초. 아주 느린 둥실(동작 줄이기면 0) */
  t?: number;
  dark?: boolean;
  /** 무대 크기: 구름을 안으로 민다 */
  W?: number;
  H?: number;
  /** 가장자리 그림자 흐림(px, DPR 반영) */
  edge?: number;
  content?: DreamContent | null;
}
/** 구름 자리(무대 px) */
export function dreamCloud(hx: number, hy: number, S: number, o?: { face?: number; W?: number; H?: number }): { cx: number; cy: number; r: number };
/** 꿈 말풍선: 머리 가운데(hx, hy) 위 */
export function drawDream(g: CanvasRenderingContext2D, hx: number, hy: number, S: number, o?: DreamOptions): void;
