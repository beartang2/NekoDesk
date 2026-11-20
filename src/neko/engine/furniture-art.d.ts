export type FurnitureKind = "lamp" | "cattower" | "wheel" | "sofa" | "box";
export interface FurnitureSurface { y: number; x0: number; x1: number }
/** 가구마다 기준 크기(고양이 키 단위, by = 키 "h"·폭 "w"), 모양 칸, 올라앉는 면(고양이 키 단위) */
export const FURNITURE_ART: Record<FurnitureKind, { size: number; by: "h" | "w"; span: number; surfaces: FurnitureSurface[] }>;
/** 한 칸 px(u)와 그린 크기(px). slotW 를 주면 폭이 칸의 90% 를 넘지 않게(fit < 1) */
export function furnitureBox(kind: FurnitureKind, S: number, slotW?: number): { u: number; w: number; h: number; fit: number };
/** 올라앉는 면(px, 가운데 x·바닥 y 기준) */
export function furnitureSurfaces(kind: FurnitureKind, S: number, slotW?: number): FurnitureSurface[];
export function drawFurniture(
  g: CanvasRenderingContext2D,
  kind: FurnitureKind,
  x: number,
  bottom: number,
  S: number,
  o?: { on?: boolean; accent?: string; spin?: number; edge?: number; layer?: "back" | "front" | "all"; slotW?: number; shadow?: string | null },
): void;
