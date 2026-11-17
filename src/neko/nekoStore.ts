import { create } from "zustand";
import { settingsApi } from "../api/tauri";
import type { NekoAppearance, NekoPattern } from "./engine/neko-engine";

/**
 * 네코 외형·자리 스토어. 예전 catStore(스프라이트 variantId 하나)를 대신한다.
 *
 * - 외형: 털 색·무늬(+씨앗)·눈·털 길이·귀·꼬리·체형·다리·말랑함
 * - 자리: 사이드바 패널(기본) / 채팅 바 아래 띠, 각 자리의 높이
 *
 * 저장은 RPG 처럼 Tauri settings DB(`neko_appearance`, `neko_stage`). 브라우저 개발 모드처럼
 * invoke 가 없으면 localStorage 만 쓴다. 첫 화면이 깜빡이지 않게 localStorage 를 먼저 읽고,
 * DB 값이 오면 덮는다. 예전 `nekodesk_cat_variant` 는 처음 한 번 옮겨 온다(설계 §8).
 */

export type NekoPlacement = "sidebar" | "dock";
export interface NekoStageSettings {
  placement: NekoPlacement;
  /** 사이드바 패널 무대 높이(px) */
  sidebarH: number;
  /** 채팅 바 아래 띠 높이(px) */
  dockH: number;
}

export const SIDEBAR_H = { min: 150, max: 320, def: 200 } as const;
export const DOCK_H = { min: 120, max: 240, def: 170 } as const;

export const DEFAULT_APPEARANCE: NekoAppearance = {
  coat: "cream",
  color: "#c8a27a",
  patterns: [],
  seed: 7,
  eye: "yellow",
  fur: "short",
  ear: "pointy",
  tail: "long",
  build: "normal",
  legs: "normal",
  soft: 0.6,
};
const DEFAULT_STAGE: NekoStageSettings = { placement: "sidebar", sidebarH: SIDEBAR_H.def, dockH: DOCK_H.def };

const APPEARANCE_KEY = "neko_appearance";
const STAGE_KEY = "neko_stage";
const LEGACY_VARIANT_KEY = "nekodesk_cat_variant";

/** 예전 스프라이트 색 → v26 외형. 브라운은 치즈 + 줄무늬(브라운 태비), 화이트는 '하양' 털 색. */
export function migrateVariant(id: string | null): Partial<NekoAppearance> | null {
  const map: Record<string, Partial<NekoAppearance>> = {
    // 지금 스프라이트 털색(spriteData CAT_VARIANTS)
    cheese: { coat: "cheese", patterns: ["tabby", "white"] },
    tabby: { coat: "gray", patterns: ["tabby", "white"] },
    tuxedo: { coat: "black", patterns: ["white"], eye: "yellow" },
    calico: { coat: "cheese", patterns: ["calico"] },
    siamese: { coat: "cream", patterns: ["point"], eye: "blue" },
    russianblue: { coat: "gray", eye: "green" },
    // 그 전 스프라이트 색
    cream: { coat: "cream" },
    orange: { coat: "cheese" },
    gray: { coat: "gray" },
    white: { coat: "white" },
    brown: { coat: "cheese", patterns: ["tabby"] },
  };
  const m = id ? map[id] : undefined;
  return m ? { patterns: [], ...m } : null;
}

/**
 * 외형 → 가장 가까운 스프라이트 털색(migrateVariant 의 거꾸로). 부팅 화면·빈 대화·빠른 질문·산책 지도는
 * 아직 스프라이트(catStore)로 그린다 — 털색 고르기가 꾸미기로 바뀌어서 catStore 가 이걸로 따라온다.
 */
export function spriteVariantOf(a: NekoAppearance): string {
  if (a.patterns.includes("point")) return "siamese";
  if (a.patterns.includes("calico")) return "calico";
  if (a.coat === "black") return "tuxedo";
  if (a.coat === "gray") return a.patterns.includes("tabby") ? "tabby" : "russianblue";
  return "cheese";
}

const clampH = (v: number, r: { min: number; max: number }) => Math.round(Math.min(r.max, Math.max(r.min, v)));

/** 저장된 값을 믿지 않고 모양을 맞춘다(알 수 없는 값은 기본값). */
export function normalizeAppearance(raw: unknown): NekoAppearance {
  const a = (raw && typeof raw === "object" ? raw : {}) as Partial<NekoAppearance>;
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  const d = DEFAULT_APPEARANCE;
  return {
    coat: pick(a.coat, ["black", "cheese", "gray", "cream", "white", "custom"] as const, d.coat),
    color: typeof a.color === "string" && /^#[0-9a-f]{6}$/i.test(a.color) ? a.color.toLowerCase() : d.color,
    patterns: Array.isArray(a.patterns)
      ? [...new Set(a.patterns.filter((p): p is NekoPattern => ["white", "calico", "tabby", "point"].includes(p as string)))]
      : [],
    seed: Number.isFinite(a.seed) ? (a.seed as number) >>> 0 : d.seed,
    eye: pick(a.eye, ["yellow", "white", "green", "blue"] as const, d.eye),
    fur: pick(a.fur, ["short", "medium", "long"] as const, d.fur),
    ear: pick(a.ear, ["pointy", "round", "fold"] as const, d.ear),
    tail: pick(a.tail, ["long", "fluffy", "bob"] as const, d.tail),
    build: pick(a.build, ["slim", "normal", "chubby"] as const, d.build),
    legs: pick(a.legs, ["short", "normal", "long"] as const, d.legs),
    soft: Number.isFinite(a.soft) ? Math.min(1, Math.max(0, a.soft as number)) : d.soft,
  };
}

export function normalizeStage(raw: unknown): NekoStageSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<NekoStageSettings>;
  return {
    placement: s.placement === "dock" ? "dock" : "sidebar",
    sidebarH: clampH(Number.isFinite(s.sidebarH) ? (s.sidebarH as number) : SIDEBAR_H.def, SIDEBAR_H),
    dockH: clampH(Number.isFinite(s.dockH) ? (s.dockH as number) : DOCK_H.def, DOCK_H),
  };
}

function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

// 색 고르기 창을 끌 때처럼 값이 연달아 바뀌면 마지막 값만 0.25초 뒤에 한 번 저장한다
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function save(key: string, value: unknown) {
  const prev = saveTimers.get(key);
  if (prev) clearTimeout(prev);
  saveTimers.set(key, setTimeout(() => {
    saveTimers.delete(key);
    const raw = JSON.stringify(value);
    try { localStorage.setItem(key, raw); } catch { /* 저장 공간 없음 등 — 무시 */ }
    settingsApi.set(key, raw).catch(() => {}); // 브라우저 개발 모드엔 Tauri 가 없다
  }, 250));
}

function initialAppearance(): NekoAppearance {
  const local = readLocal<NekoAppearance>(APPEARANCE_KEY);
  if (local) return normalizeAppearance(local);
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(LEGACY_VARIANT_KEY); } catch { /* 무시 */ }
  return normalizeAppearance({ ...DEFAULT_APPEARANCE, ...(migrateVariant(legacy) ?? {}) });
}

interface NekoStore {
  appearance: NekoAppearance;
  stage: NekoStageSettings;
  setAppearance: (patch: Partial<NekoAppearance>) => void;
  /** 무늬를 새로 뽑는다(씨앗만 바뀜) */
  reroll: () => void;
  setPlacement: (p: NekoPlacement) => void;
  /** 높이를 바꾼다. persist=false 면 끌고 있는 중(손을 뗄 때 저장) */
  setStageHeight: (which: NekoPlacement, h: number, persist?: boolean) => void;
  /** DB 값으로 덮기(앱 시작 때 한 번) */
  load: () => Promise<void>;
}

export const useNekoStore = create<NekoStore>((set, get) => ({
  appearance: initialAppearance(),
  stage: normalizeStage(readLocal(STAGE_KEY)),
  setAppearance: (patch) => {
    const appearance = normalizeAppearance({ ...get().appearance, ...patch });
    set({ appearance });
    save(APPEARANCE_KEY, appearance);
  },
  reroll: () => get().setAppearance({ seed: (Math.random() * 4294967296) >>> 0 }),
  setPlacement: (placement) => {
    const stage = { ...get().stage, placement };
    set({ stage });
    save(STAGE_KEY, stage);
  },
  setStageHeight: (which, h, persist = true) => {
    const cur = get().stage;
    const stage = which === "sidebar" ? { ...cur, sidebarH: clampH(h, SIDEBAR_H) } : { ...cur, dockH: clampH(h, DOCK_H) };
    set({ stage });
    if (persist) save(STAGE_KEY, stage);
  },
  load: async () => {
    const [a, s] = await Promise.all([
      settingsApi.get(APPEARANCE_KEY).catch(() => null),
      settingsApi.get(STAGE_KEY).catch(() => null),
    ]);
    try {
      if (a) set({ appearance: normalizeAppearance(JSON.parse(a)) });
      else save(APPEARANCE_KEY, get().appearance); // 처음: 옮겨 온(또는 기본) 외형을 DB 에도 남긴다
      if (s) set({ stage: normalizeStage(JSON.parse(s)) });
    } catch {
      /* 깨진 값 — 지금 값을 유지 */
    }
  },
}));
