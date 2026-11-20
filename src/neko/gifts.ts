import { create } from "zustand";
import { giftsApi, settingsApi } from "../api/tauri";
import { validateShape, type GiftShape } from "./engine/gift-shape";
import type { NekoDecorSpot, NekoGiftPlay, NekoGiftSize } from "./engine/neko-engine";
import { clampScale, decorK } from "./engine/decor-draw";
import { stageS } from "./engine/stage-scale";
import { useNekoStore, type NekoPlacement } from "./nekoStore";

/**
 * 선물함: 네코가 산책에서 주워 온 물건(설계 docs/neko-gifts.md §3·§4).
 *
 * settings DB 키 하나에 JSON 배열로 둔다 — 많아야 100개라 테이블을 따로 만들 일이 아니다. 저장은 선물 하나씩
 * (giftsApi)이고 백엔드가 배열에 합친다 — 다른 기기에서 막 온 선물을 이 창이 못 본 채 덮지 않게(docs/neko-sync.md). 놓인 자리는 장소
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
/** 크기로 자리를 막지 않는다(사용자 확정, 0.1.16) — 어디든 놓고, 너무 크면 그 자리 상한(decor-draw capPx)으로 그린다 */
/** 장소가 생기기 전에 놓인 것(예전 데이터): 그때 규칙대로 그 크기가 들어가던 가장 작은 장소로 */
const legacyPlace = (size?: NekoGiftSize): NekoPlacement => (size === "small" ? "sidebar" : size === "large" ? "screen" : "dock");

/**
 * 사용자 배율이 이 장소에서 상한에 걸리나(선물함 안내 '이 자리에선 최대 크기로 보여요'). 상한은 실제 무대 크기에 달려 있어
 * 무대 설정(높이·마당 고양이 크기)으로 어림한다 — 엔진과 몇 % 다를 수 있다
 */
export function scaleCapped(g: NekoGift, at: NekoPlacement): boolean {
  const st = useNekoStore.getState().stage;
  const floorY = (at === "sidebar" ? st.sidebarH : at === "dock" ? st.dockH : 1000) - 6;
  const S = at === "screen" ? st.screenScale : stageS(Infinity, floorY); // 폭은 모른다 — 높이로만(폰은 70%)
  return decorK(validateShape(g.shape), g.size, g.scale, at, { floorY, S }).capped;
}

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
  /** 사용자가 고른 배율(0.5~3, 없으면 1 = 기본 크기). 크기(소·중·대) 위에 곱한다. 자리 상한은 그릴 때 건다(옮기면 다시 커지게) */
  scale?: number;
}

/** 그 장소에 놓인 것을 엔진 setDecor 모양으로. 마당은 screen 을 주면 그 모니터에 보이는 것만(없으면 모니터를 안 가린다) */
export function decorItems(gifts: NekoGift[], at: NekoPlacement, screen?: ScreenPick) {
  return gifts.flatMap((g) => {
    if (g.placed?.at !== at) return [];
    if (at === "screen" && screen && shownScreen(g.placed, screen) !== screen.id) return [];
    const { at: _at, screen: _scr, ...spot } = g.placed;
    return [{ id: g.id, shape: g.shape, play: g.play, size: g.size, lastPlayed: g.lastPlayed, scale: g.scale, at, ...(g.frame ? { frame: true } : {}), ...spot }];
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
  /** DB 를 다시 읽어 그대로 바꾼다(다른 기기에서 선물이 오거나 빠졌을 때, sync-changed) */
  reload: () => Promise<void>;
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
  /**
   * 배율을 바꾼다(0.5~3 으로 묶고 1 이면 칸을 뺀다). save=false 면 메모리만(선물함 슬라이더를 끄는 동안 — 창 동기화로 무대가
   * 바로 바뀐다), true 면 저장(놓을 때 한 번)
   */
  resize: (id: string, scale: number, save: boolean) => void;
}

/** 저장된 JSON 을 선물 목록으로. 모양도 한 번 더 검사한다 — 손으로 고친 DB, 예전 꼴, 다른 기기에서 온 것이 엔진까지 가지 않게 */
/**
 * 액자만 벽에 건다(사용자, 0.1.24). 방·거실 벽에 걸려 있던 다른 물건은 같은 가로 자리의 바닥으로 내린다 — 업데이트 뒤 한 번,
 * 그리고 옛 버전이 벽 자리를 다시 보내와도 받을 때마다. 바닥 자리는 옛 버전도 그대로 읽는다. 마당(screen)은 화면 창 몫이라 둔다
 */
export function hangOnlyFrames(gifts: NekoGift[]): { gifts: NekoGift[]; moved: NekoGift[] } {
  const moved: NekoGift[] = [];
  const out = gifts.map((g) => {
    const p = g.placed;
    if (!p || g.frame || p.surface !== "wall" || p.at === "screen") return g;
    const placed: GiftPlacement = { surface: "floor", u: p.u, at: p.at, ...(p.screen ? { screen: p.screen } : {}) };
    const next = { ...g, placed };
    moved.push(next);
    return next;
  });
  return { gifts: out, moved };
}
/** 고친 자리를 저장한다(동기화로 다른 기기도 바닥 자리를 받는다) */
function saveMoved(moved: NekoGift[]) {
  for (const g of moved) quiet(giftsApi.patch(g.id, { placed: g.placed }));
}

function parseGifts(raw: string | null): NekoGift[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as NekoGift[]) : [];
    return Array.isArray(parsed)
      ? parsed.filter((g) => g && g.id).map((g) => ({
        ...g,
        shape: validateShape(g.shape),
        ...(g.scale != null ? { scale: clampScale(g.scale) } : {}),
        // 장소가 생기기 전에 놓인 것(장소가 없거나 모르는 장소)은 그 크기가 들어가는 가장 작은 장소로
        ...(g.placed && !Object.prototype.hasOwnProperty.call(PLACE_NAME, g.placed.at) ? { placed: { ...g.placed, at: legacyPlace(g.size) } } : {}),
      }))
      : [];
  } catch {
    return [];
  }
}

const quiet = (p: Promise<unknown>) => void p.catch(() => {});

export const useNekoGifts = create<GiftStore>((set, get) => ({
  gifts: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    const { gifts: list, moved } = hangOnlyFrames(parseGifts(await settingsApi.get(KEY).catch(() => null)));
    saveMoved(moved);
    // 불러오는 사이 들어온 선물(산책에서 막 돌아옴)은 뒤에 붙인다
    set((s) => ({ gifts: capGifts([...list, ...s.gifts.filter((g) => !list.some((o) => o.id === g.id))]), loaded: true }));
  },
  async reload() {
    const raw = await settingsApi.get(KEY).catch(() => undefined);
    if (raw === undefined) return;
    const { gifts, moved } = hangOnlyFrames(parseGifts(raw));
    saveMoved(moved);
    set({ gifts: capGifts(gifts), loaded: true });
  },
  add(g) {
    const play = PLAYS.includes(g.play as NekoGiftPlay) ? (g.play as NekoGiftPlay) : undefined;
    const size = GIFT_SIZES.includes(g.size as NekoGiftSize) ? (g.size as NekoGiftSize) : undefined;
    const gift: NekoGift = {
      id: g.id ?? crypto.randomUUID(), at: g.at ?? new Date().toISOString(), title: g.title, body: g.body, shape: validateShape(g.shape),
      ...(play ? { play } : {}), ...(size ? { size } : {}), ...(g.placed ? { placed: g.placed } : {}), ...(g.frame ? { frame: true as const } : {}),
    };
    const all = [...get().gifts, gift];
    const gifts = capGifts(all);
    set({ gifts });
    quiet(giftsApi.add(gift));
    // 넘쳐서 빠진 것(놓이지 않은 오래된 것)
    const dropped = all.filter((g) => !gifts.includes(g)).map((g) => g.id);
    if (dropped.length) quiet(giftsApi.remove(dropped));
  },
  place(id, spot, at, screen) {
    const gift = get().gifts.find((g) => g.id === id);
    if (!gift) return;
    let placed: GiftPlacement | null = null;
    if (spot !== null) {
      const where = at ?? gift.placed?.at;
      if (!where) return;
      // 마당의 모니터: 준 것, 아니면 같은 마당에 있던 모니터(없으면 주 모니터)
      const scr = where !== "screen" ? undefined : screen ?? (gift.placed?.at === "screen" ? gift.placed.screen : undefined);
      // 빈 자리는 같은 장소(마당은 같은 모니터) 같은 면(액자는 벽, 나머지는 바닥)끼리 센다
      const face = gift.frame ? "wall" : "floor";
      const us = get().gifts.filter((g) => g.id !== id && g.placed?.at === where && g.placed.surface === face && g.placed.screen === scr).map((g) => g.placed!.u);
      const s: NekoDecorSpot = spot !== "auto" ? spot : gift.frame ? { surface: "wall", u: freeSpot(us), v: FRAME_V[where] } : { surface: "floor", u: freeSpot(us) };
      // 액자만 벽에(마당 빼고). 벽 자리가 와도 액자가 아니면 같은 가로 자리의 바닥으로
      const hang = s.surface === "wall" && (gift.frame || where === "screen");
      placed = hang && s.surface === "wall" ? { surface: "wall", u: s.u, v: s.v, at: where } : { surface: "floor", u: s.u, at: where };
      if (scr) placed.screen = scr;
    }
    const gifts = get().gifts.map((g) => {
      if (g.id !== id) return g;
      if (!placed) { const { placed: _drop, ...rest } = g; return rest; }
      return { ...g, placed };
    });
    set({ gifts });
    quiet(giftsApi.patch(id, { placed }));
  },
  remove(id) {
    const gifts = get().gifts.filter((g) => g.id !== id);
    set({ gifts });
    quiet(giftsApi.remove([id]));
  },
  resize(id, scale, save) {
    const k = clampScale(scale);
    if (!get().gifts.some((g) => g.id === id)) return;
    const gifts = get().gifts.map((g) => {
      if (g.id !== id) return g;
      if (k === 1) { const { scale: _drop, ...rest } = g; return rest; }
      return { ...g, scale: k };
    });
    set({ gifts });
    // 놓을 때 한 번만 올린다(끄는 동안 기록이 쏟아지지 않게). 1 배면 칸을 뺀다
    if (save) quiet(giftsApi.patch(id, { scale: k === 1 ? null : k }));
  },
  played(id, at) {
    if (!get().gifts.some((g) => g.id === id)) return;
    const gifts = get().gifts.map((g) => (g.id === id ? { ...g, lastPlayed: at } : g));
    set({ gifts });
    quiet(giftsApi.patch(id, { lastPlayed: at }));
  },
}));
