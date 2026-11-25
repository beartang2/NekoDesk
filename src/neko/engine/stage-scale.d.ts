/** 폰의 기기 배율(고양이·창문·선물을 같이 줄인다) */
export const PHONE_K: number;
export function setStageK(k: number): void;
/** 방(sidebar)의 배율 — 맥·폰 같은 값 */
export const ROOM_K: number;
/** 그 장소에 곱하는 배율(방은 ROOM_K, 나머지는 기기 배율) */
export function stageK(place?: string): number;
/** 맥 거실이 크기를 멈추는 높이(px) */
export const DOCK_GROW_H: number;
/** 크기를 잴 때 쓰는 무대 높이(맥 거실은 DOCK_GROW_H 까지만) */
export function sizeH(place: string | undefined, H: number): number;
/** 무대 폭 W·바닥 y(px)·장소 → 크기 배율 S(방은 ROOM_K, 나머지는 기기 배율 포함, 맥 거실은 DOCK_GROW_H 에서 멈춤) */
export function stageS(W: number, floorY: number, place?: string): number;
