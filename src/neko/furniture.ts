import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { settingsApi } from "../api/tauri";
import { validateShape, type GiftShape } from "./engine/gift-shape";
import { FURNITURE_SLOTS, furnitureSlots, type DecorTop } from "./engine/decor-draw";
import { furnitureSurfaces } from "./engine/furniture-art";
import { cleanShownText } from "../lib/replyTags";
import { checkFurniture, type FurnUse } from "./furnitureUses";

/**
 * 네코의 가구(docs/neko-furniture.md §4): 기본 다섯 개(코드 상수)와 산책에서 물어온 가구. 가구는 칸에 고정된다 —
 * 방(sidebar) 2칸·거실(dock) 4칸, 마당엔 없다. 놓기는 빈 칸이 있을 때만, 옮기기는 없고 치우면 다시 놓을 수 있다.
 *
 * 저장은 동기화 설정 키 neko_furniture 한 값(맥·폰 같이, 마이그레이션 12 — 옛 버전은 모르는 키라 버린다). 쓰기 전에 저장된 값을
 * 읽어 이번 바꿈만 얹고, 바꾼 가구엔 바꾼 때(at), 버린 가구는 버린 때(gone)를 적는다(v 2). 두 기기가 따로 바꾼 값은 받는 쪽
 * 동기화가 가구 하나씩 합친다(src-tauri/src/sync/furniture.rs) — 통째로 덮어쓰면 한쪽 바꿈이 사라지고 기기마다 다른 값으로 남았다.
 * 선물함(neko_gifts)엔 넣지 않는다 — 옛 버전이 선물로 그려 끌고 다닌다.
 */
export const FURNITURE_KEY = "neko_furniture";
export const FURNITURE_KINDS = ["lamp", "cattower", "wheel", "sofa", "box", "table"] as const;
export type FurnitureKind = (typeof FURNITURE_KINDS)[number];
export type FurniturePlace = { at: "sidebar" | "dock"; slot: number };
/**
 * 가구 종류: 기본 kind, 또는 자유 가구 "free"(0.1.28, docs/neko-furniture-free.md — 모델이 자유롭게 그리고 쓰임새를 고른 것). 옛 버전은
 * "free" 를 모르는 kind 라 통째로 빼고 읽어(readFurniture) 건드리지 않는다 — 다섯 kind 로 두면 모르는 칸(uses)을 떼고 다시 쓴다
 */
export type FurnitureItemKind = FurnitureKind | "free";
export interface FurnitureItem {
  id: string;
  kind: FurnitureItemKind;
  /** 산책에서 물어온 가구만: 이름·설명·모양·찾은 날. 모양은 옛 물어온 가구(kind 다섯)면 32 칸에 꽉 찬 그림, 자유 가구면 고양이 키 12칸 축척 */
  title?: string;
  body?: string;
  shape?: GiftShape;
  /** 자유 가구만: 검사를 거친 쓰임새(neko/furnitureUses) */
  uses?: FurnUse[];
  found?: string;
  place: FurniturePlace | null;
  /** 마지막으로 놓거나 치운(물어온) 때(ms). 기기끼리 합칠 때 나중 것이 이긴다. 안 건드린 기본 가구·옛 값엔 없다 */
  at?: number;
}

/** 기본 가구 여섯(0.1.28 탁자 더함): 처음부터 가구 탭에 있다. 이름은 화면이 쓴다. 옛 버전은 모르는 kind(탁자)를 읽을 때 뺀다 */
export const BASE_FURNITURE: FurnitureItem[] = FURNITURE_KINDS.map((kind) => ({ id: `base:${kind}`, kind, place: null }));
export const FURNITURE_NAME: Record<FurnitureItemKind, string> = { lamp: "조명", cattower: "캣타워", wheel: "캣휠", sofa: "소파", box: "상자", table: "탁자", free: "물어온 가구" };
const KINDS = new Set<string>(FURNITURE_KINDS);
const isBase = (id: string) => id.startsWith("base:");

type Gone = Record<string, number>;

/** 자유 가구 검사는 격자 판정이라 읽을 때마다 하지 않는다 — 같은 값이면 지난 결과(값 글이 열쇠) */
const checkMemo = new Map<string, ReturnType<typeof checkFurniture>>();
function checked(shape: unknown, uses: unknown): ReturnType<typeof checkFurniture> {
  const k = JSON.stringify([shape, uses]);
  if (!checkMemo.has(k)) {
    if (checkMemo.size > 64) checkMemo.clear();
    checkMemo.set(k, checkFurniture(shape, uses));
  }
  return checkMemo.get(k)!;
}

/** 저장된 값 → 목록과 버린 때. 모르는 칸·망가진 줄은 버리고, 기본 다섯은 늘 있다 */
function readFurniture(raw: string | null): { items: FurnitureItem[]; gone: Gone; v2: boolean } {
  let p: unknown;
  try { p = raw ? JSON.parse(raw) : null; } catch { p = null; }
  const list = (p && typeof p === "object" && Array.isArray((p as { items?: unknown }).items) ? (p as { items: unknown[] }).items : []);
  const g = (p as { gone?: unknown } | null)?.gone;
  const gone: Gone = {};
  if (g && typeof g === "object") for (const [k, t] of Object.entries(g)) if (Number.isSafeInteger(t)) gone[k] = t as number;
  const stored = list.flatMap((x): FurnitureItem[] => {
    const r = (x ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || !(KINDS.has(r.kind as string) || (r.kind === "free" && !isBase(r.id)))) return [];
    const pl = (r.place ?? null) as { at?: unknown; slot?: unknown } | null;
    const at: FurniturePlace["at"] | null = pl?.at === "sidebar" ? "sidebar" : pl?.at === "dock" ? "dock" : null;
    const slot = Number(pl?.slot);
    const place: FurniturePlace | null = at && Number.isInteger(slot) && slot >= 0 && slot < FURNITURE_SLOTS[at] ? { at, slot } : null;
    const stamp = Number.isSafeInteger(r.at) ? { at: r.at as number } : {};
    if (!isBase(r.id) && r.id in gone && gone[r.id] >= ((r.at as number) || 0)) return [];
    if (isBase(r.id)) return r.id === `base:${r.kind}` ? [{ id: r.id, kind: r.kind as FurnitureKind, place, ...stamp }] : [];
    // 모델이 쓴 이름·설명: 감정·생각 태그를 뗀다(lib/replyTags, 선물과 같은 길목) — 다음에 쓸 때 깨끗한 값이 저장된다
    const str = (v: unknown, max: number) => (typeof v === "string" ? cleanShownText(v).slice(0, max) : "");
    // 자유 가구: 모양·쓰임새를 읽을 때도 다시 검사한다(다른 기기·손댄 값). 가구가 아니면 뺀다
    const free = r.kind === "free" ? checked(r.shape, r.uses) : null;
    if (r.kind === "free" && !free) return [];
    return [{
      id: r.id, kind: r.kind as FurnitureItemKind, place,
      ...(str(r.title, 40) ? { title: str(r.title, 40) } : {}), ...(str(r.body, 200) ? { body: str(r.body, 200) } : {}),
      ...(free ? { shape: free.shape, uses: free.uses } : r.shape ? { shape: validateShape(r.shape) } : {}),
      ...(str(r.found, 10) ? { found: str(r.found, 10) } : {}), ...stamp,
    }];
  });
  const byId = new Map(stored.map((f) => [f.id, f]));
  // 물어온 가구는 찾은 날 순(합친 값은 번호 순으로 온다)
  const found = stored.filter((f) => !isBase(f.id)).sort((a, b) => (a.found ?? "").localeCompare(b.found ?? "") || a.id.localeCompare(b.id));
  const all = [...BASE_FURNITURE.map((b) => byId.get(b.id) ?? b), ...found];
  // 한 칸엔 하나만(두 기기가 같은 칸에 따로 놓음·옛 값): 먼저 놓인 것이 칸을 갖는다 — 어느 기기에서 읽어도 같게
  const owner = new Map<string, FurnitureItem>();
  for (const f of [...all].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) { // 같은 때면 all 순서(기본 다섯 순, 찾은 날 순)
    const k = f.place && `${f.place.at}:${f.place.slot}`;
    if (k && !owner.has(k)) owner.set(k, f);
  }
  const v2 = (p as { v?: unknown } | null)?.v === 2;
  return { items: all.map((f) => (f.place && owner.get(`${f.place.at}:${f.place.slot}`) !== f ? { ...f, place: null } : f)), gone, v2 };
}
export const parseFurniture = (raw: string | null): FurnitureItem[] => readFurniture(raw).items;
/** 목록 → 저장 값: 건드린 기본 가구(치운 것도 — 다른 기기의 옛 놓기를 이긴다)와 물어온 가구, 버린 때 */
const serialize = (items: FurnitureItem[], gone: Gone) =>
  JSON.stringify({ v: 2, items: items.filter((f) => !isBase(f.id) || f.place || f.at), gone });

/** 그 장소의 빈 칸(가장 앞). 없으면 null */
export function freeSlot(items: FurnitureItem[], at: "sidebar" | "dock", but?: string): number | null {
  const used = new Set(items.filter((f) => f.id !== but && f.place?.at === at).map((f) => f.place!.slot));
  for (let i = 0; i < FURNITURE_SLOTS[at]; i++) if (!used.has(i)) return i;
  return null;
}

interface FurnitureStore {
  items: FurnitureItem[];
  loaded: boolean;
  load: () => Promise<void>;
  reload: () => Promise<void>;
  /** 그 장소의 빈 칸에 놓는다(다른 장소에 놓였으면 옮긴다). slot 을 주면 그 칸(선물함에서 고른 칸). 빈 칸이 없거나 그 칸이 찼거나 마당이면 false */
  place: (id: string, at: string, slot?: number) => Promise<boolean>;
  /** 치운다(가구 탭에 남는다) */
  unplace: (id: string) => Promise<void>;
  /** 물어온 가구를 버린다(기본 가구는 못 버린다) */
  remove: (id: string) => Promise<void>;
  /** 산책에서 물어왔다 */
  add: (f: Omit<FurnitureItem, "id" | "place"> & { id?: string }) => Promise<void>;
}

const samePlace = (a: FurniturePlace | null, b: FurniturePlace | null) => a?.at === b?.at && a?.slot === b?.slot;

/**
 * 저장된 값을 읽어 이번 바꿈만 얹고 쓴다(다른 기기가 막 쓴 것을 덮지 않게). 자리가 바뀐 가구·새 가구엔 지금(이 기기가 본 것보다
 * 늦게)을, 빠진 물어온 가구는 버린 때를 적는다. 다른 창(맥 선물함·메인)도 다시 읽게 알린다
 */
async function update(fn: (items: FurnitureItem[]) => FurnitureItem[] | null): Promise<FurnitureItem[] | null> {
  const cur = readFurniture(await settingsApi.get(FURNITURE_KEY).catch(() => null));
  const next = fn(cur.items);
  if (!next) return null;
  const now = Date.now(), before = new Map(cur.items.map((f) => [f.id, f])), left = new Set(next.map((f) => f.id));
  const gone = { ...cur.gone };
  for (const f of cur.items) if (!isBase(f.id) && !left.has(f.id)) gone[f.id] = Math.max(now, (f.at ?? 0) + 1);
  const stamped = next.map((f) => {
    const b = before.get(f.id);
    if (!b || !samePlace(b.place, f.place)) return { ...f, at: Math.max(now, (b?.at ?? 0) + 1) };
    // 옛 값(at 없음)에서 온 가구는 아주 오래된 것으로 — 어느 기기의 새 바꿈에도 진다
    return !f.at && (f.place || !isBase(f.id)) ? { ...f, at: 1 } : f;
  });
  const raw = serialize(stamped, gone);
  await settingsApi.set(FURNITURE_KEY, raw).catch(() => {});
  void emit("neko-furniture-changed").catch(() => {});
  return parseFurniture(raw);
}

let listening = false;

export const useNekoFurniture = create<FurnitureStore>((set, get) => ({
  items: BASE_FURNITURE,
  loaded: false,
  async load() {
    if (get().loaded) return;
    await get().reload();
    // 옛 값(0.1.25 까지, v 1)이면 한 번 v 2 로 다시 적는다 — 올라가서 다른 기기와 가구 하나씩 합쳐진다(기기마다 다른 값으로 남았던 것)
    const raw = await settingsApi.get(FURNITURE_KEY).catch(() => null);
    if (raw && !readFurniture(raw).v2) await update((items) => items);
    // 창마다(메인·맥 선물함·마당) 따로 듣는다: 다른 기기에서 온 값(lib/sync 의 SYNC_CHANGED), 다른 창이 쓴 값
    if (listening) return;
    listening = true;
    void listen<{ colls: string[] }>("sync-changed", ({ payload }) => { if (payload.colls.includes("setting")) void get().reload(); }).catch(() => {});
    void listen("neko-furniture-changed", () => void get().reload()).catch(() => {});
  },
  async reload() {
    const raw = await settingsApi.get(FURNITURE_KEY).catch(() => undefined);
    if (raw === undefined) return;
    set({ items: parseFurniture(raw), loaded: true });
  },
  async place(id, at, want) {
    if (at !== "sidebar" && at !== "dock") return false;
    const next = await update((items) => {
      const f = items.find((x) => x.id === id);
      const taken = (i: number) => items.some((x) => x.id !== id && x.place?.at === at && x.place.slot === i);
      const slot = !f ? null : want === undefined ? freeSlot(items, at, id)
        : Number.isInteger(want) && want >= 0 && want < FURNITURE_SLOTS[at] && !taken(want) ? want : null;
      if (!f || slot === null) return null;
      return items.map((x) => (x.id === id ? { ...x, place: { at, slot } } : x));
    });
    if (next) set({ items: next });
    return !!next;
  },
  async unplace(id) {
    const next = await update((items) => items.map((x) => (x.id === id ? { ...x, place: null } : x)));
    if (next) set({ items: next });
  },
  async remove(id) {
    if (isBase(id)) return;
    const next = await update((items) => items.filter((x) => x.id !== id));
    if (next) set({ items: next });
  },
  async add(f) {
    const clean = (v?: string) => (v ? cleanShownText(v) : v); // 감정·생각 태그는 저장 전에 뗀다(선물과 같다)
    const item: FurnitureItem = { ...f, title: clean(f.title), body: clean(f.body), id: f.id ?? `walk:${crypto.randomUUID().slice(0, 8)}`, place: null };
    const next = await update((items) => (items.some((x) => x.id === item.id) ? items : [...items, item]));
    if (next) set({ items: next });
  },
}));

/**
 * 기본 kind 가구(그림·면을 furniture-art 표로 그리는 것). 자유 가구("free")는 표에 없어 엔진·정지 그림 층·칸 고르기가 따로 그린다
 * (docs/neko-furniture-free.md §13 몫 3, 디자이너). 그때까지 그 자리들은 자유 가구를 건너뛴다
 */
export const isArtKind = (f: FurnitureItem): f is FurnitureItem & { kind: FurnitureKind } => f.kind !== "free";
/** 그 장소에 놓인 가구(엔진 setFurniture 용) */
export const placedAt = (items: FurnitureItem[], at: string) => items.filter((f) => f.place?.at === at);
/**
 * 가구 윗면(탁자) 위 선물 중 그 가구가 그 장소에 없는 것(치움·버림·다른 기기에서 치운 값·그 면이 없는 가구): [선물 id, 바닥 u].
 * 호스트가 바닥으로 적는다(furnitureHost)
 */
export function orphansOnFurniture(gifts: { id: string; placed?: { surface: string; at: string; u: number; fid?: string; i?: number } }[], items: FurnitureItem[]): [string, number][] {
  return gifts.flatMap((g): [string, number][] => {
    const p = g.placed;
    if (p?.surface !== "furniture") return [];
    const f = items.find((x) => x.id === p.fid);
    return f && isArtKind(f) && f.place?.at === p.at && furnitureSurfaces(f.kind, 1)[p.i ?? -1]?.hold ? [] : [[g.id, p.u]];
  });
}
/**
 * 그 장소(방·거실)에 놓인 가구의 물건 얹는 윗면(hold, 탁자) — 무대 px(폭 W·바닥 floorY·배율 S). 엔진(layoutFurniture)과 같은 칸·면·번호라
 * 빈 방 그림(RoomGifts)·선물함 끌어 놓기(giftDrop)가 엔진과 같은 자리(surface "furniture")를 쓴다
 */
export function holdTops(items: FurnitureItem[], at: "sidebar" | "dock", W: number, floorY: number, S: number): DecorTop[] {
  const slots = furnitureSlots(at, W);
  return placedAt(items, at).filter(isArtKind).flatMap((f) => {
    const slot = slots[f.place!.slot];
    if (!slot) return [];
    return furnitureSurfaces(f.kind, S, slot.w).flatMap((sf, i) => (sf.hold ? [{ fid: f.id, i, x0: slot.x + sf.x0, x1: slot.x + sf.x1, y: floorY - sf.y }] : []));
  });
}
