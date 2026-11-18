import { create } from "zustand";
import { settingsApi } from "../api/tauri";
import { validateShape, type GiftShape } from "./engine/gift-shape";
import type { NekoDecorSpot, NekoGiftPlay, NekoGiftSize } from "./engine/neko-engine";
import type { NekoPlacement } from "./nekoStore";

/**
 * 선물함: 네코가 산책에서 주워 온 물건(설계 docs/neko-gifts.md §3·§4).
 *
 * settings DB 키 하나에 JSON 배열로 둔다 — 많아야 100개라 테이블을 따로 만들 일이 아니다. 놓인 자리는 장소
 * (방·거실·마당 = 네코 자리) + 그 무대 안의 면과 비율(u: 무대 폭 비율)이다. 장소마다 놓을 수 있는 크기가 다르다.
 */

const KEY = "neko_gifts";
export const MAX_GIFTS = 100;
/**
 * 액자를 걸 높이(벽 v 비율). 마당은 벽이 없고 화면 전체 높이라 0.6 이면 화면 한가운데 손톱만 하게 떠 다른 창에
 * 가려 안 보였다 — 고양이 머리 조금 위(바닥에서 화면 높이의 13%쯤, 1080 모니터면 120px 남짓)에 건다
 */
const FRAME_V: Record<NekoPlacement, number> = { sidebar: 0.6, dock: 0.6, screen: 0.13 };
/** 큰 물건 전용(scratch·lean·hide)도 넣는다 — 엔진이 크기에 안 맞는 놀이는 바꿔 논다 */
export const PLAYS: NekoGiftPlay[] = ["roll", "bat", "sniff", "sit_on", "carry", "scratch", "lean", "hide"];
export const GIFT_SIZES: NekoGiftSize[] = ["small", "medium", "large"];

/** 장소 = 네코 자리. 사이드바는 방, 채팅 바 아래는 거실, 모니터 화면은 마당 */
export const PLACE_NAME: Record<NekoPlacement, string> = { sidebar: "방", dock: "거실", screen: "마당" };
/** 장소마다 놓을 수 있는 크기. 방엔 작은 것만, 거실엔 중간 것까지, 마당엔 다 */
const FITS: Record<NekoPlacement, readonly NekoGiftSize[]> = { sidebar: ["small"], dock: ["small", "medium"], screen: GIFT_SIZES };
/** 이 크기를 이 장소에 놓을 수 있나. 크기가 없으면 엔진이 medium 으로 그린다 */
export const fits = (size: NekoGiftSize | undefined, at: NekoPlacement): boolean => FITS[at].includes(size ?? "medium");
/** 이 크기를 놓을 수 있는 가장 작은 장소 */
export const smallestPlace = (size?: NekoGiftSize): NekoPlacement =>
  (["sidebar", "dock", "screen"] as const).find((p) => fits(size, p)) ?? "screen";

/**
 * 놓인 자리: 장소(at) + 그 무대 안 자리. 바닥: u = 무대 폭(양끝 여백 제외) 비율. 벽: u 와 v = 바닥 위 쓸 수 있는 높이 비율. 모두 0~1.
 * screen: 마당(at "screen")에서 놓인 모니터(CGDisplay UUID). 없으면 주 모니터다(예전에 놓은 것). 그 모니터가 빠져 있으면
 * 값은 그대로 두고 주 모니터에 보여 준다 — 다시 꽂으면 제자리로 돌아간다
 */
export type GiftPlacement = NekoDecorSpot & { at: NekoPlacement; screen?: string };

/** 마당 모니터: 지금 모니터(id), 주 모니터(main), 꽂혀 있는 모니터들(known) */
export interface ScreenPick { id: string; main: string; known: readonly string[] }
/** 놓인 모니터가 빠져 있거나 정해지지 않았으면 주 모니터 */
export const shownScreen = (p: GiftPlacement, s: Pick<ScreenPick, "main" | "known">): string =>
  p.screen && s.known.includes(p.screen) ? p.screen : s.main;

export interface NekoGift {
  id: string;
  /** ISO 시각 */
  at: string;
  title: string;
  body: string;
  shape: GiftShape;
  /** 네코가 이걸로 노는 방식(산책 머리가 고름). 없으면 엔진이 모양으로 짐작 */
  play?: NekoGiftPlay;
  /** 실제 물건 크기(무대·입에서 그리는 크기). 없으면 medium. 선물함 칸에선 칸에 맞춘다 */
  size?: NekoGiftSize;
  placed?: GiftPlacement;
  /** 네코가 그린 그림 액자(agent/neko-drawing.ts). '놓기'(auto)는 바닥 대신 벽에 건다 */
  frame?: true;
  /** 네코가 마지막으로 갖고 논 때(epoch ms, 엔진 decorPlayed). 오래 안 논 것부터 논다 */
  lastPlayed?: number;
}

/** 그 장소에 놓인 것을 엔진 setDecor 모양으로. 마당은 screen 을 주면 그 모니터에 보이는 것만(없으면 모니터를 안 가린다) */
export function decorItems(gifts: NekoGift[], at: NekoPlacement, screen?: ScreenPick) {
  return gifts.flatMap((g) => {
    if (g.placed?.at !== at) return [];
    if (at === "screen" && screen && shownScreen(g.placed, screen) !== screen.id) return [];
    const { at: _at, screen: _scr, ...spot } = g.placed;
    return [{ id: g.id, shape: g.shape, play: g.play, size: g.size, lastPlayed: g.lastPlayed, ...spot }];
  });
}

/** 넘치면 놓이지 않은 것 중 오래된 것부터 뺀다. 놓인 건 사용자가 고른 것이라 남긴다. */
export function capGifts(list: NekoGift[], max = MAX_GIFTS): NekoGift[] {
  const out = list.slice();
  while (out.length > max) {
    const i = out.findIndex((g) => !g.placed);
    out.splice(i >= 0 ? i : 0, 1);
  }
  return out;
}

/** 이미 놓인 것들과 가장 멀리 떨어진 자리(0~1). 처음이면 가운데 조금 옆. */
export function freeSpot(placed: number[]): number {
  if (!placed.length) return 0.35;
  const xs = [...placed].sort((a, b) => a - b), cands = [0, 1, ...xs.slice(1).map((x, i) => (x + xs[i]) / 2)];
  const gap = (u: number) => Math.min(...xs.map((x) => Math.abs(x - u)));
  return cands.reduce((best, u) => (gap(u) > gap(best) ? u : best), cands[0]);
}

interface GiftStore {
  gifts: NekoGift[];
  loaded: boolean;
  load: () => Promise<void>;
  /** 모양은 받은 그대로 넘겨도 된다(여기서 검사한다) */
  add: (g: Omit<NekoGift, "id" | "at" | "shape" | "play" | "size"> & Partial<Pick<NekoGift, "id" | "at">> & { shape: unknown; play?: unknown; size?: unknown }) => void;
  /**
   * 장소 at 의 그 자리에 놓는다("auto" 면 그 장소 바닥의 빈 곳). at 을 안 주면 놓여 있던 장소 그대로(무대 안에서
   * 끌어 옮길 때). 다른 장소를 주면 그리로 옮긴다. 그 장소에 안 맞는 크기면 아무것도 안 한다. null 이면 치운다(선물함으로)
   * screen: 마당의 모니터. 안 주면 놓여 있던 모니터 그대로(처음 놓는 거면 주 모니터 = 없음). 마당이 아니면 버린다
   */
  place: (id: string, spot: NekoDecorSpot | "auto" | null, at?: NekoPlacement, screen?: string) => void;
  remove: (id: string) => void;
  /** 네코가 갖고 놀았다(엔진 decorPlayed) */
  played: (id: string, at: number) => void;
}

function persist(gifts: NekoGift[]) {
  void settingsApi.set(KEY, JSON.stringify(gifts)).catch(() => {});
}

export const useNekoGifts = create<GiftStore>((set, get) => ({
  gifts: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    const raw = await settingsApi.get(KEY).catch(() => null);
    let list: NekoGift[] = [];
    try {
      const parsed = raw ? (JSON.parse(raw) as NekoGift[]) : [];
      // 저장된 모양도 한 번 더 검사한다 — 손으로 고친 DB 나 예전 꼴이 엔진까지 가지 않게
      list = Array.isArray(parsed)
        ? parsed.filter((g) => g && g.id).map((g) => ({
          ...g,
          shape: validateShape(g.shape),
          // 장소가 생기기 전에 놓인 것(장소가 없거나 모르는 장소)은 그 크기가 들어가는 가장 작은 장소로
          ...(g.placed && !Object.prototype.hasOwnProperty.call(PLACE_NAME, g.placed.at) ? { placed: { ...g.placed, at: smallestPlace(g.size) } } : {}),
        }))
        : [];
    } catch {
      list = [];
    }
    // 불러오는 사이 들어온 선물(산책에서 막 돌아옴)은 뒤에 붙인다
    set((s) => ({ gifts: capGifts([...list, ...s.gifts.filter((g) => !list.some((o) => o.id === g.id))]), loaded: true }));
  },
  add(g) {
    const play = PLAYS.includes(g.play as NekoGiftPlay) ? (g.play as NekoGiftPlay) : undefined;
    const size = GIFT_SIZES.includes(g.size as NekoGiftSize) ? (g.size as NekoGiftSize) : undefined;
    const gift: NekoGift = {
      id: g.id ?? crypto.randomUUID(), at: g.at ?? new Date().toISOString(), title: g.title, body: g.body, shape: validateShape(g.shape),
      ...(play ? { play } : {}), ...(size ? { size } : {}), ...(g.placed ? { placed: g.placed } : {}), ...(g.frame ? { frame: true as const } : {}),
    };
    const gifts = capGifts([...get().gifts, gift]);
    set({ gifts });
    persist(gifts);
  },
  place(id, spot, at, screen) {
    const gift = get().gifts.find((g) => g.id === id);
    if (!gift) return;
    let placed: GiftPlacement | null = null;
    if (spot !== null) {
      const where = at ?? gift.placed?.at;
      if (!where || !fits(gift.size, where)) return;
      // 마당의 모니터: 준 것, 아니면 같은 마당에 있던 모니터(없으면 주 모니터)
      const scr = where !== "screen" ? undefined : screen ?? (gift.placed?.at === "screen" ? gift.placed.screen : undefined);
      // 빈 자리는 같은 장소(마당은 같은 모니터) 같은 면(액자는 벽, 나머지는 바닥)끼리 센다
      const face = gift.frame ? "wall" : "floor";
      const us = get().gifts.filter((g) => g.id !== id && g.placed?.at === where && g.placed.surface === face && g.placed.screen === scr).map((g) => g.placed!.u);
      const s: NekoDecorSpot = spot !== "auto" ? spot : gift.frame ? { surface: "wall", u: freeSpot(us), v: FRAME_V[where] } : { surface: "floor", u: freeSpot(us) };
      placed = s.surface === "wall" ? { surface: "wall", u: s.u, v: s.v, at: where } : { surface: "floor", u: s.u, at: where };
      if (scr) placed.screen = scr;
    }
    const gifts = get().gifts.map((g) => {
      if (g.id !== id) return g;
      if (!placed) { const { placed: _drop, ...rest } = g; return rest; }
      return { ...g, placed };
    });
    set({ gifts });
    persist(gifts);
  },
  remove(id) {
    const gifts = get().gifts.filter((g) => g.id !== id);
    set({ gifts });
    persist(gifts);
  },
  played(id, at) {
    if (!get().gifts.some((g) => g.id === id)) return;
    const gifts = get().gifts.map((g) => (g.id === id ? { ...g, lastPlayed: at } : g));
    set({ gifts });
    persist(gifts);
  },
}));
