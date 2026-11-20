/** 폰의 기기 배율(고양이·창문·선물을 같이 줄인다) */
export const PHONE_K: number;
export function setStageK(k: number): void;
export function stageK(): number;
/** 무대 폭 W·바닥 y(px) → 크기 배율 S(기기 배율 포함) */
export function stageS(W: number, floorY: number): number;
