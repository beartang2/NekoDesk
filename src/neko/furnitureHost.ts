import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import type { NekoController } from "./engine/neko-engine";
import { placedAt, useNekoFurniture, type FurnitureKind } from "./furniture";
import { useNekoStore } from "./nekoStore";

/**
 * 가구의 호스트 쪽(docs/neko-furniture.md §8·§10·§12): 엔진에 놓인 가구를 넘기고(setFurniture — 칸 번호, 엔진이 resize 때 다시 잰다),
 * 엔진이 알려 주는 조명 켜짐(lamp)을 이 기기에 기억하고(동기화 안 함), 활동 중 엔진이 직접 그리는 가구(furnitureHeld)를
 * 정지 그림 층(FurnitureLayer)이 빼고 그리게 한다. 엔진에 API 가 아직 없으면(옛 엔진) 건너뛴다.
 */

type FurnitureEvents = {
  lamp: { id: string; on: boolean };
  furnitureHeld: string[];
  furnitureMenu: { id: string; x: number; y: number };
};
/** 가구 API 가 있는 엔진(없으면 undefined) */
export type FurnitureCtrl = NekoController & {
  setFurniture?: (items: { id: string; kind: FurnitureKind; at: "sidebar" | "dock"; slot: number; on: boolean }[]) => void;
  on<K extends keyof FurnitureEvents>(ev: K, fn: (p: FurnitureEvents[K]) => void): () => void;
};

/** 포인트 색(--accent)을 #rrggbb 로 — 캣타워 방석. 캔버스가 아무 CSS 색이나 그 꼴로 바꿔 준다 */
export function accentHex(): string {
  const c = document.createElement("canvas").getContext("2d");
  const v = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  if (!c || !v) return "";
  c.fillStyle = v;
  return /^#[0-9a-f]{6}$/i.test(c.fillStyle) ? c.fillStyle : "";
}

// ── 조명 켜짐: 이 기기에만(localStorage). 엔진이 바꾸고 lamp 로 알린다 ──
const LAMP_KEY = "nekodesk_furniture_lamp";
let lamps: Record<string, boolean> = (() => { try { return JSON.parse(localStorage.getItem(LAMP_KEY) || "{}") as Record<string, boolean>; } catch { return {}; } })();
const lampSubs = new Set<() => void>();
export const lampOn = (id: string) => lamps[id] === true;
export function setLampOn(id: string, on: boolean) {
  if (lampOn(id) === on) return;
  lamps = { ...lamps, [id]: on };
  try { localStorage.setItem(LAMP_KEY, JSON.stringify(lamps)); } catch { /* 저장 못 해도 이번엔 켜진다 */ }
  lampSubs.forEach((f) => f());
}
export const useLamps = () => useSyncExternalStore((f) => { lampSubs.add(f); return () => { lampSubs.delete(f); }; }, () => lamps);

// ── 활동 중 엔진이 직접 그리는 가구 ──
let held: ReadonlySet<string> = new Set();
const heldSubs = new Set<() => void>();
export const useFurnitureHeld = () => useSyncExternalStore((f) => { heldSubs.add(f); return () => { heldSubs.delete(f); }; }, () => held);

/** 엔진을 만든 뒤 한 번(nekoHost) */
export function startFurnitureHost(ctrl: NekoController) {
  const fc = ctrl as FurnitureCtrl;
  const send = () => {
    const at = useNekoStore.getState().stage.placement;
    if (at !== "sidebar" && at !== "dock") { fc.setFurniture?.([]); return; }
    fc.setFurniture?.(placedAt(useNekoFurniture.getState().items, at).map((f) => ({ id: f.id, kind: f.kind, at, slot: f.place!.slot, on: lampOn(f.id) })));
  };
  useNekoFurniture.subscribe((s, prev) => { if (s.items !== prev.items) send(); });
  useNekoStore.subscribe((s, prev) => { if (s.stage.placement !== prev.stage.placement) send(); });
  lampSubs.add(send);
  void useNekoFurniture.getState().load().then(send);
  // 맥 선물함은 따로 뜬 창이라 거기서 놓고 치우면 이 창 스토어가 모른다 — 알려 오면 다시 읽는다(FurnitureTab)
  void listen("neko-furniture-changed", () => void useNekoFurniture.getState().reload()).catch(() => {});
  if (!fc.setFurniture) return; // 옛 엔진: 사건도 없다
  fc.on("lamp", ({ id, on }) => setLampOn(id, on));
  fc.on("furnitureHeld", (ids) => { held = new Set(ids); heldSubs.forEach((f) => f()); });
}
