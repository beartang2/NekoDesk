import { create } from "zustand";
import { settingsApi } from "../api/tauri";
import { validateShape, type GiftShape } from "./engine/gift-shape";
import type { NekoDecorSpot, NekoGiftPlay } from "./engine/neko-engine";

/**
 * 선물함: 네코가 산책에서 주워 온 물건(설계 docs/neko-gifts.md §3·§4).
 *
 * settings DB 키 하나에 JSON 배열로 둔다 — 많아야 100개라 테이블을 따로 만들 일이 아니다. 무대에 놓인 자리는
 * px 가 아니라 면 + 비율(u: 무대 폭 비율)이라 사이드바·아래 띠·화면 띠 어디서나 같은 자리에 보인다.
 */

const KEY = "neko_gifts";
/** 선물함 칸을 무대로 끌 때의 데이터 종류(HTML 끌어 놓기) */
export const GIFT_DND = "application/x-neko-gift";
export const MAX_GIFTS = 100;
export const PLAYS: NekoGiftPlay[] = ["roll", "bat", "sniff", "sit_on", "carry"];

/** 바닥: u = 무대 폭(양끝 여백 제외) 비율. 벽: u 와 v = 바닥 위 쓸 수 있는 높이 비율. 모두 0~1 */
export type GiftPlacement = NekoDecorSpot;

export interface NekoGift {
  id: string;
  /** ISO 시각 */
  at: string;
  title: string;
  body: string;
  shape: GiftShape;
  /** 네코가 이걸로 노는 방식(산책 머리가 고름). 없으면 엔진이 모양으로 짐작 */
  play?: NekoGiftPlay;
  placed?: GiftPlacement;
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
  add: (g: Omit<NekoGift, "id" | "at" | "shape" | "play"> & Partial<Pick<NekoGift, "id" | "at">> & { shape: unknown; play?: unknown }) => void;
  /** 바닥에 놓는다(자리를 안 주면 빈 곳). null 이면 치운다(선물함으로) */
  place: (id: string, spot: GiftPlacement | "auto" | null) => void;
  remove: (id: string) => void;
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
      list = Array.isArray(parsed) ? parsed.filter((g) => g && g.id).map((g) => ({ ...g, shape: validateShape(g.shape) })) : [];
    } catch {
      list = [];
    }
    // 불러오는 사이 들어온 선물(산책에서 막 돌아옴)은 뒤에 붙인다
    set((s) => ({ gifts: capGifts([...list, ...s.gifts.filter((g) => !list.some((o) => o.id === g.id))]), loaded: true }));
  },
  add(g) {
    const play = PLAYS.includes(g.play as NekoGiftPlay) ? (g.play as NekoGiftPlay) : undefined;
    const gift: NekoGift = { id: g.id ?? crypto.randomUUID(), at: g.at ?? new Date().toISOString(), title: g.title, body: g.body, shape: validateShape(g.shape), ...(play ? { play } : {}), ...(g.placed ? { placed: g.placed } : {}) };
    const gifts = capGifts([...get().gifts, gift]);
    set({ gifts });
    persist(gifts);
  },
  place(id, spot) {
    const placedUs = get().gifts.filter((g) => g.placed?.surface === "floor" && g.id !== id).map((g) => g.placed!.u);
    const gifts = get().gifts.map((g) => {
      if (g.id !== id) return g;
      if (spot === null) { const { placed: _drop, ...rest } = g; return rest; }
      return { ...g, placed: spot === "auto" ? { surface: "floor" as const, u: freeSpot(placedUs) } : spot };
    });
    set({ gifts });
    persist(gifts);
  },
  remove(id) {
    const gifts = get().gifts.filter((g) => g.id !== id);
    set({ gifts });
    persist(gifts);
  },
}));

// 개발 빌드에서만: 산책을 안 다녀와도 시험할 수 있게 견본 선물을 넣는다. 콘솔에서 nekoGift() — 넣고 바닥에 놓는다
if (import.meta.env.DEV) {
  const SAMPLES: { title: string; play: NekoGiftPlay; shape: unknown }[] = [
    { title: "반짝이는 병뚜껑", play: "roll", shape: { parts: [{ t: "circle", x: 0, y: -7, r: 7, c: "silver" }, { t: "circle", x: 0, y: -7, r: 5, c: "red" }, { t: "dot", x: -2, y: -9, c: "white" }] } },
    { title: "단풍잎", play: "carry", shape: { parts: [{ t: "poly", pts: [[-10, -2], [-2, -12], [10, -14], [6, -4], [-4, 0]], c: "orange" }, { t: "rrect", x: -9, y: -2, w: 6, h: 1.4, rad: 0.7, rot: 0.5, c: "brown" }] } },
    { title: "각설탕", play: "bat", shape: { parts: [{ t: "rrect", x: 0, y: -6, w: 12, h: 12, rad: 2, rot: 0, c: "white" }, { t: "dot", x: -2, y: -9, c: "silver" }] } },
    { title: "납작한 조약돌", play: "sit_on", shape: { parts: [{ t: "ellipse", x: 0, y: -3.5, rx: 13, ry: 3.5, rot: 0, c: "gray" }, { t: "dot", x: -4, y: -5, c: "white" }] } },
    { title: "도토리", play: "sniff", shape: { parts: [{ t: "ellipse", x: 0, y: -6, rx: 5, ry: 6, rot: 0, c: "brown" }, { t: "rrect", x: 0, y: -12, w: 11, h: 4, rad: 2, rot: 0, c: "orange" }] } },
  ];
  (window as unknown as { nekoGift: (i?: number) => string }).nekoGift = (i) => {
    const s = SAMPLES[i ?? Math.floor(Math.random() * SAMPLES.length)], id = crypto.randomUUID();
    useNekoGifts.getState().add({ id, title: s.title, body: "개발용 견본", shape: s.shape, play: s.play });
    useNekoGifts.getState().place(id, "auto");
    return `${s.title}(${s.play})`;
  };
}
