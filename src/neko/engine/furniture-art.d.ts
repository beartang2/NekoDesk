export type FurnitureKind = "lamp" | "cattower" | "wheel" | "sofa" | "box" | "table";
/** 올라앉는 면. hold = 물건도 얹는다(탁자 윗면) */
export interface FurnitureSurface { y: number; x0: number; x1: number; hold?: boolean }
/** 가구마다 기준 크기(고양이 키 단위, by = 키 "h"·폭 "w"), 모양 칸, 올라앉는 면(고양이 키 단위) */
export const FURNITURE_ART: Record<FurnitureKind, { size: number; by: "h" | "w"; span: number; surfaces: FurnitureSurface[] }>;
/** 한 칸 px(u)와 그린 크기(px). slotW 를 주면 폭이 칸의 90% 를 넘지 않게(fit < 1) */
/** 포인트 색 → 같은 계열의 가구 색(채도 상한 sMax, 밝기 l). 없으면 "" */
export function accentTone(hex: string | undefined, sMax: number, l: number): string;
/** 캣휠 바퀴 원(px): 바닥에서 가운데까지 dy(위가 음수)·테 바깥 반지름 r */
/** 상자 입구(px, 가운데·바닥 기준): 앞벽 끝 x0·x1, 테두리 높이 rim(위가 음수) — 안에 든 고양이를 테두리 아래에선 이 폭으로 자른다 */
export function boxOpening(S: number, slotW?: number): { x0: number; x1: number; rim: number };
export function wheelCircle(S: number, slotW?: number): { dy: number; r: number; rIn: number };
export function furnitureBox(kind: FurnitureKind, S: number, slotW?: number): { u: number; w: number; h: number; fit: number };
/** 올라앉는 면(px, 가운데 x·바닥 y 기준). list = 가구 항목이 준 면 목록(고양이 키 단위) — 있으면 종류 표 대신 */
export function furnitureSurfaces(kind: FurnitureKind, S: number, slotW?: number, list?: FurnitureSurface[]): FurnitureSurface[];
export function drawFurniture(
  g: CanvasRenderingContext2D,
  kind: FurnitureKind,
  x: number,
  bottom: number,
  S: number,
  o?: { on?: boolean; accent?: string; spin?: number; edge?: number; layer?: "back" | "front" | "all"; slotW?: number; shadow?: string | null },
): void;
