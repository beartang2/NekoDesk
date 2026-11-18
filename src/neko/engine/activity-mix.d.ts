// activity-mix.js 의 타입. 설계: docs/neko-activity-mix.md 1부

export type NekoPart = "body" | "move" | "paws" | "head" | "ears" | "mouth" | "tail";
export type NekoStance = "sit" | "loaf" | "stand" | "move" | "lie";
export type NekoSlot = "floor" | "wall" | "air" | "head" | "decor";
/** 기본 상태(주 활동이 없을 때) */
export type NekoBaseKey = "base:stand" | "base:sit" | "base:loaf" | "base:lie";

export interface NekoMixDecl {
  /** 차지하는 부위: 그 부위 값은 이 활동이 정한다 */
  hold: NekoPart[];
  /** 얹는 부위: 비어 있으면 자기 값, 다른 쪽이 차지하면 양보하고 overlay 차이만 더한다 */
  ride?: NekoPart[];
  stance?: NekoStance;
  /** 곁들임으로 얹힐 때 아래쪽의 stance 가 이 중 하나여야 한다 */
  needs?: NekoStance[];
  slots?: NekoSlot[];
  /** both 면 곁들임도 된다 */
  role?: "main" | "both";
  /** 곁들일 때 상태 글자 앞말 */
  with?: string;
  /** 부위로는 되지만 같이 안 하는 활동·기본 상태 */
  notWith?: string[];
  /** 2단계: 한 번(약 3분) 하면 바뀌는 숨은 게이지 */
  fills?: NekoFills;
  /** 2단계: 혼자 놀기 후보(giftplay 는 놓인 선물이 있을 때만 — 감독이 본다) */
  solo?: boolean;
  /** 한 번짜리: 시작해서 끝날 때까지 가장 긴 시간(ms). 스케줄러가 이것 + 여유만큼 기다린다 */
  maxMs?: number;
}
export interface NekoFills { energy: number; curiosity: number; clean: number; affection: number }

export const PARTS: NekoPart[];
export const POSE_PART: Record<string, NekoPart>;
export const ADD_KEYS: readonly ("tt" | "ear" | "sq" | "tilt" | "dy" | "tail")[];
export const MIX: Record<string, NekoMixDecl>;
export function baseOf(pose: "stand" | "sit" | "loaf" | "lie"): NekoBaseKey;
type Look = (key: string) => NekoMixDecl | undefined;
/** on = 주 활동 키(없으면 기본 상태 키), side = 곁들임 */
export function mixable(on: string | null, side: string | null, look?: Look): { ok: boolean; why: string };
export function mergePose(
  on: string, side: string,
  onPose: Record<string, unknown> | null, sidePose: Record<string, unknown> | null,
  sideAdd: Partial<Record<(typeof ADD_KEYS)[number], number>> | null, look?: Look,
): Record<string, unknown> & { add: Partial<Record<(typeof ADD_KEYS)[number], number>> };
export function mixTable(look?: Look): string[];
