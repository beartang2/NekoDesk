import { create } from "zustand";
import { settingsApi } from "../api/tauri";
import { appEvents } from "../lib/events";
import { validateShape, type GiftShape } from "./engine/gift-shape";
import { FURNITURE_SLOTS } from "./engine/decor-draw";
import { cleanShownText } from "../lib/replyTags";

/**
 * 네코의 가구(docs/neko-furniture.md §4): 기본 다섯 개(코드 상수)와 산책에서 물어온 가구. 가구는 칸에 고정된다 —
 * 방(sidebar) 2칸·거실(dock) 4칸, 마당엔 없다. 놓기는 빈 칸이 있을 때만, 옮기기는 없고 치우면 다시 놓을 수 있다.
 *
 * 저장은 동기화 설정 키 neko_furniture 한 값(맥·폰 같이, 마이그레이션 12 — 옛 버전은 모르는 키라 버린다). 놓기·치우기·물어오기는
 * 드물어 통째로 덮어쓰되, 쓰기 전에 저장된 값을 읽어 이번 바꿈만 얹는다(다른 기기에서 막 물어온 가구를 덮지 않게).
 * 선물함(neko_gifts)엔 넣지 않는다 — 옛 버전이 선물로 그려 끌고 다닌다.
 */
export const FURNITURE_KEY = "neko_furniture";
export const FURNITURE_KINDS = ["lamp", "cattower", "wheel", "sofa", "box"] as const;
export type FurnitureKind = (typeof FURNITURE_KINDS)[number];
export type FurniturePlace = { at: "sidebar" | "dock"; slot: number };
export interface FurnitureItem {
  id: string;
  kind: FurnitureKind;
  /** 산책에서 물어온 가구만: 이름·설명·모양(32 칸)·찾은 날 */
  title?: string;
  body?: string;
  shape?: GiftShape;
  found?: string;
  place: FurniturePlace | null;
}

/** 기본 가구 다섯: 처음부터 가구 탭에 있다. 이름은 화면이 쓴다 */
export const BASE_FURNITURE: FurnitureItem[] = FURNITURE_KINDS.map((kind) => ({ id: `base:${kind}`, kind, place: null }));
export const FURNITURE_NAME: Record<FurnitureKind, string> = { lamp: "조명", cattower: "캣타워", wheel: "캣휠", sofa: "소파", box: "상자" };
const KINDS = new Set<string>(FURNITURE_KINDS);
const isBase = (id: string) => id.startsWith("base:");

/** 저장된 값 → 목록. 모르는 칸·망가진 줄은 버리고, 기본 다섯은 늘 있다(저장엔 놓였거나 물어온 것만) */
export function parseFurniture(raw: string | null): FurnitureItem[] {
  let p: unknown;
  try { p = raw ? JSON.parse(raw) : null; } catch { p = null; }
  const list = (p && typeof p === "object" && Array.isArray((p as { items?: unknown }).items) ? (p as { items: unknown[] }).items : []);
  const stored = list.flatMap((x): FurnitureItem[] => {
    const r = (x ?? {}) as Record<string, unknown>;
    if (typeof r.id !== "string" || !KINDS.has(r.kind as string)) return [];
    const pl = (r.place ?? null) as { at?: unknown; slot?: unknown } | null;
    const at: FurniturePlace["at"] | null = pl?.at === "sidebar" ? "sidebar" : pl?.at === "dock" ? "dock" : null;
    const slot = Number(pl?.slot);
    const place: FurniturePlace | null = at && Number.isInteger(slot) && slot >= 0 && slot < FURNITURE_SLOTS[at] ? { at, slot } : null;
    if (isBase(r.id)) return r.id === `base:${r.kind}` ? [{ id: r.id, kind: r.kind as FurnitureKind, place }] : [];
    // 모델이 쓴 이름·설명: 감정·생각 태그를 뗀다(lib/replyTags, 선물과 같은 길목) — 다음에 쓸 때 깨끗한 값이 저장된다
    const str = (v: unknown, max: number) => (typeof v === "string" ? cleanShownText(v).slice(0, max) : "");
    return [{
      id: r.id, kind: r.kind as FurnitureKind, place,
      ...(str(r.title, 40) ? { title: str(r.title, 40) } : {}), ...(str(r.body, 200) ? { body: str(r.body, 200) } : {}),
      ...(r.shape ? { shape: validateShape(r.shape) } : {}), ...(str(r.found, 10) ? { found: str(r.found, 10) } : {}),
    }];
  });
  const byId = new Map(stored.map((f) => [f.id, f]));
  // 한 칸엔 하나만(옛 값·두 기기가 같은 칸에 놓음): 먼저 적힌 것이 칸을 갖는다
  const taken = new Set<string>();
  const all = [...BASE_FURNITURE.map((b) => byId.get(b.id) ?? b), ...stored.filter((f) => !isBase(f.id))];
  return all.map((f) => {
    if (!f.place) return f;
    const k = `${f.place.at}:${f.place.slot}`;
    if (taken.has(k)) return { ...f, place: null };
    taken.add(k);
    return f;
  });
}
/** 목록 → 저장 값: 놓인 기본 가구와 물어온 가구만 */
const serialize = (items: FurnitureItem[]) => JSON.stringify({ v: 1, items: items.filter((f) => !isBase(f.id) || f.place) });

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
  /** 그 장소의 빈 칸에 놓는다(다른 장소에 놓였으면 옮긴다). 빈 칸이 없거나 마당이면 false */
  place: (id: string, at: string) => Promise<boolean>;
  /** 치운다(가구 탭에 남는다) */
  unplace: (id: string) => Promise<void>;
  /** 물어온 가구를 버린다(기본 가구는 못 버린다) */
  remove: (id: string) => Promise<void>;
  /** 산책에서 물어왔다 */
  add: (f: Omit<FurnitureItem, "id" | "place"> & { id?: string }) => Promise<void>;
}

/** 저장된 값을 읽어 이번 바꿈만 얹고 쓴다(다른 기기가 막 쓴 것을 덮지 않게) */
async function update(fn: (items: FurnitureItem[]) => FurnitureItem[] | null): Promise<FurnitureItem[] | null> {
  const cur = parseFurniture(await settingsApi.get(FURNITURE_KEY).catch(() => null));
  const next = fn(cur);
  if (!next) return null;
  await settingsApi.set(FURNITURE_KEY, serialize(next)).catch(() => {});
  return parseFurniture(serialize(next));
}

export const useNekoFurniture = create<FurnitureStore>((set, get) => ({
  items: BASE_FURNITURE,
  loaded: false,
  async load() {
    if (get().loaded) return;
    await get().reload();
    appEvents.on("syncChanged", ({ colls }) => { if (colls.includes("setting")) void get().reload(); });
  },
  async reload() {
    const raw = await settingsApi.get(FURNITURE_KEY).catch(() => undefined);
    if (raw === undefined) return;
    set({ items: parseFurniture(raw), loaded: true });
  },
  async place(id, at) {
    if (at !== "sidebar" && at !== "dock") return false;
    const next = await update((items) => {
      const f = items.find((x) => x.id === id);
      const slot = f ? freeSlot(items, at, id) : null;
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

/** 그 장소에 놓인 가구(엔진 setFurniture 용) */
export const placedAt = (items: FurnitureItem[], at: string) => items.filter((f) => f.place?.at === at);
