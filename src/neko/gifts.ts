import { create } from "zustand";
import { settingsApi } from "../api/tauri";
import { validateShape, type GiftShape } from "./engine/gift-shape";
import type { NekoDecorSpot, NekoGiftPlay, NekoGiftSize } from "./engine/neko-engine";

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
export const GIFT_SIZES: NekoGiftSize[] = ["small", "medium", "large"];

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
  /** 실제 물건 크기(무대·입에서 그리는 크기). 없으면 medium. 선물함 칸에선 칸에 맞춘다 */
  size?: NekoGiftSize;
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
  add: (g: Omit<NekoGift, "id" | "at" | "shape" | "play" | "size"> & Partial<Pick<NekoGift, "id" | "at">> & { shape: unknown; play?: unknown; size?: unknown }) => void;
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
    const size = GIFT_SIZES.includes(g.size as NekoGiftSize) ? (g.size as NekoGiftSize) : undefined;
    const gift: NekoGift = {
      id: g.id ?? crypto.randomUUID(), at: g.at ?? new Date().toISOString(), title: g.title, body: g.body, shape: validateShape(g.shape),
      ...(play ? { play } : {}), ...(size ? { size } : {}), ...(g.placed ? { placed: g.placed } : {}),
    };
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
  // 산책 머리에게 바라는 수준의 견본: 정확한 실루엣 + 특징을 긋는 선 + 같은 색 그늘·밝은 쪽
  const SAMPLES: { title: string; play: NekoGiftPlay; size: NekoGiftSize; shape: unknown }[] = [
    { title: "반짝이는 병뚜껑", play: "roll", size: "small", shape: { parts: [
      { t: "poly", round: 0.5, c: "red", pts: Array.from({ length: 20 }, (_, i) => { const a = (i / 20) * Math.PI * 2, r = i % 2 ? 8.6 : 10; return [Math.cos(a) * r, -10 + Math.sin(a) * r]; }) },
      { t: "circle", x: 0, y: -10, r: 7.4, c: "red.dark" },
      { t: "circle", x: 0, y: -10, r: 6.6, c: "red" },
      { t: "line", w: 1.1, c: "red.light", pts: [[-4.5, -13.5], [-5.6, -10.5], [-4.6, -7.4]] },
      { t: "dot", x: 3, y: -14.5, c: "white" },
    ] } },
    { title: "단풍잎", play: "carry", size: "medium", shape: { parts: [
      { t: "line", w: 1, c: "brown.dark", pts: [[0, -6], [0.6, -2], [2, 0]] },
      { t: "poly", round: 0, c: "red", pts: [[0, -29], [2.5, -23.5], [6, -25.5], [5, -20], [11, -22], [9, -17], [14.5, -15], [8.5, -12], [10.5, -7.5], [4.5, -9], [0.8, -5.5], [-0.8, -5.5], [-4.5, -9], [-10.5, -7.5], [-8.5, -12], [-14.5, -15], [-9, -17], [-11, -22], [-5, -20], [-6, -25.5], [-2.5, -23.5]] },
      { t: "line", w: 0.6, c: "red.dark", pts: [[0, -6], [0, -26]] },
      { t: "line", w: 0.55, c: "red.dark", pts: [[0, -12], [6, -16], [12, -16.5]] },
      { t: "line", w: 0.55, c: "red.dark", pts: [[0, -12], [-6, -16], [-12, -16.5]] },
      { t: "line", w: 0.5, c: "red.dark", pts: [[0, -8.5], [5, -8.5], [9, -8]] },
      { t: "line", w: 0.5, c: "red.dark", pts: [[0, -8.5], [-5, -8.5], [-9, -8]] },
    ] } },
    { title: "각설탕", play: "bat", size: "small", shape: { parts: [
      { t: "poly", round: 0.6, c: "white.dark", pts: [[-9, -17.5], [0, -13], [0, 0], [-9, -4.5]] },
      { t: "poly", round: 0.6, c: "gray.light", pts: [[0, -13], [9, -17.5], [9, -4.5], [0, 0]] },
      { t: "poly", round: 0.6, c: "white", pts: [[0, -22], [9, -17.5], [0, -13], [-9, -17.5]] },
      // 설탕 알갱이: 아주 작은 점을 흩뿌린다(크면 주사위 눈처럼 보인다)
      ...[[-4, -9], [-6.5, -5.5], [-2.5, -4], [-6, -11.5], [4.5, -8], [6.5, -12], [2.5, -4.5], [2, -17.5], [-3, -18.2], [4.5, -18.6], [-1, -15.5]]
        .map(([x, y], i) => ({ t: "dot", x, y, r: 0.45, c: i % 3 ? "white.light" : "gray.light" })),
    ] } },
    { title: "납작한 조약돌", play: "sit_on", size: "large", shape: { parts: [
      { t: "ellipse", x: 0, y: -4.2, rx: 13, ry: 4.2, rot: 0, c: "gray" },
      { t: "ellipse", x: 4, y: -3.4, rx: 2.4, ry: 1, rot: 0.2, c: "gray.dark" },
      { t: "ellipse", x: -6, y: -2.8, rx: 1.4, ry: 0.7, rot: -0.2, c: "gray.dark" },
      { t: "line", w: 1, c: "gray.light", pts: [[-8, -6.6], [-3, -7.8], [3, -7.5]] },
      { t: "dot", x: 7.5, y: -6, c: "gray.light" },
    ] } },
    { title: "도토리", play: "sniff", size: "small", shape: { parts: [
      { t: "poly", round: 2.6, c: "brown", pts: [[-6.2, -13], [6.2, -13], [6.6, -7.5], [3.6, -2.6], [0, 0], [-3.6, -2.6], [-6.6, -7.5]] },
      { t: "line", w: 1.2, c: "brown.light", pts: [[-3.6, -10.5], [-4.2, -7.5], [-3, -4.5]] },
      { t: "line", w: 1.4, c: "brown.dark", pts: [[0, -17], [0.6, -19.6], [2.2, -21]] },
      { t: "rrect", x: 0, y: -14.4, w: 15.5, h: 6, rad: 3, rot: 0, c: "brown.dark" },
      { t: "line", w: 0.45, c: "brown", pts: [[-5.5, -12.2], [-2.5, -16.6]] },
      { t: "line", w: 0.45, c: "brown", pts: [[-1.5, -12], [1.5, -16.8]] },
      { t: "line", w: 0.45, c: "brown", pts: [[2.5, -12], [5.5, -16.4]] },
      { t: "line", w: 0.45, c: "brown", pts: [[-5.5, -16.4], [-2.5, -12]] },
      { t: "line", w: 0.45, c: "brown", pts: [[-1.5, -16.8], [1.5, -12]] },
      { t: "line", w: 0.45, c: "brown", pts: [[2.5, -16.6], [5.5, -12.2]] },
    ] } },
  ];
  (window as unknown as { nekoGift: (i?: number) => string }).nekoGift = (i) => {
    const s = SAMPLES[i ?? Math.floor(Math.random() * SAMPLES.length)], id = crypto.randomUUID();
    useNekoGifts.getState().add({ id, title: s.title, body: "개발용 견본", shape: s.shape, play: s.play, size: s.size });
    useNekoGifts.getState().place(id, "auto");
    return `${s.title}(${s.play})`;
  };
}
