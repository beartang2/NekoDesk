import { useEffect, useRef, useState } from "react";
import { drawFurniture, furnitureBox } from "./engine/furniture-art";
import { furnitureSlots, hitDecorAt } from "./engine/decor-draw";
import { stageS } from "./engine/stage-scale";
import { placedAt, useNekoFurniture } from "./furniture";
import { decorItems, useNekoGifts } from "./gifts";
import { useAccent, useFurnitureHeld, useLamps } from "./furnitureHost";
import { useSkyLight } from "./Wallpaper";
import { useShown } from "../lib/useShown";

/** 꾹 누르기('치우기' 메뉴): 이만큼(ms) 이 거리(px) 안에서 누르고 있으면. 선물 '정리'와 같다 */
const HOLD_MS = 500, HOLD_SLOP = 8;

/**
 * 방·거실에 놓인 가구의 정지 그림 층(docs/neko-furniture.md §12): 고양이 무대 밑, 벽·창문 위. 놓거나 치울 때·조명이 바뀔 때·
 * 창밖 빛이 바뀔 때(1분)만 다시 그린다 — 가만히 있을 땐 프레임 비용이 없다. 활동 중 엔진이 직접 그리는 가구(도는 캣휠 등)는 뺀다.
 * 켜진 조명은 둘레에 따뜻한 빛 웅덩이(밤일수록 진하게, §8).
 * 상자·캣휠도 두 겹 다 그린다(고양이 뒤) — 고양이가 들어가 있을 때만 엔진이 앞 겹을 고양이 위에 한 번 더 그린다.
 * still(고양이가 이 자리에 없는 빈 방): 가구를 꾹 누르거나 우클릭하면 onMenu(그 가구 오른쪽 위) —
 * 고양이가 있으면 엔진이 furnitureMenu 로 알린다. 선물 위면 선물 몫이다
 */
export function FurnitureLayer({ place, still = false, onMenu }: {
  place: "sidebar" | "dock";
  still?: boolean;
  onMenu?: (m: { id: string; x: number; y: number }) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const items = useNekoFurniture((s) => s.items);
  const held = useFurnitureHeld(), lamps = useLamps(), sky = useSkyLight(), accent = useAccent();
  useShown(); // 다시 보이면 다시 그린다(아래 그리기는 그릴 때마다 돈다) — iOS 가 뒤에 있는 동안 캔버스를 비울 수 있다
  useEffect(() => { void useNekoFurniture.getState().load(); }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 그린 자리(칸 가운데·바닥, 칸 맞춤 크기). 누르기 판정과 '치우기' 버튼 자리에도 쓴다
  const { w, h } = size, floorY = h - 6, S = w && h ? stageS(w, floorY, place) : 1;
  const slots = furnitureSlots(place, w);
  const placed = placedAt(items, place).flatMap((f) => {
    const slot = slots[f.place!.slot];
    if (!slot) return [];
    const b = furnitureBox(f.kind, S, slot.w);
    return [{ f, x: slot.x, slotW: slot.w, box: { x: slot.x - b.w / 2, y: floorY - b.h, w: b.w, h: b.h } }];
  });

  useEffect(() => {
    const cv = ref.current, g = cv?.getContext("2d");
    if (!cv || !g || !w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const dark = !document.documentElement.classList.contains("light");
    // 켜진 조명의 빛 웅덩이: 낮엔 거의 안 보이고 밤일수록 진하게(밤 0.32·노을 0.2·낮 0.06)
    for (const p of placed) {
      if (p.f.kind !== "lamp" || !lamps[p.f.id] || held.has(p.f.id)) continue;
      const a = Math.min(0.32, 0.06 + (1 - sky.light) * 0.26 + sky.glow * 0.14), r = 160 * S, cy = floorY - 140 * S;
      const gr = g.createRadialGradient(p.x, cy, 0, p.x, cy, r);
      gr.addColorStop(0, `rgba(255,217,143,${a})`); gr.addColorStop(1, "rgba(255,217,143,0)");
      g.fillStyle = gr; g.fillRect(p.x - r, cy - r, r * 2, r * 2);
    }
    for (const p of placed) {
      if (held.has(p.f.id)) continue;
      drawFurniture(g, p.f.kind, p.x, floorY, S, {
        slotW: p.slotW, on: !!lamps[p.f.id], accent, edge: 4 * dpr,
        layer: "all", shadow: dark ? "rgba(0, 0, 0, 0.32)" : "rgba(20, 14, 24, 0.18)",
      });
    }
  });

  // 빈 방: 가구를 꾹 누르거나 우클릭하면 '치우기'. 선물 그림(RoomGifts)이 위에 있어 화면 전체의 눌림에서 고른다(선물 위면 건너뛴다)
  const live = useRef({ placed, onMenu, w, floorY, S });
  live.current = { placed, onMenu, w, floorY, S };
  useEffect(() => {
    if (!still) return;
    let hold: { t: number; x: number; y: number; id: string } | null = null;
    const at = (e: MouseEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (!r?.width) return null;
      const x = e.clientX - r.left, y = e.clientY - r.top, L = live.current;
      const p = [...L.placed].reverse().find((q) => x >= q.box.x && x <= q.box.x + q.box.w && y >= q.box.y && y <= q.box.y + q.box.h);
      if (!p) return null;
      if (hitDecorAt(decorItems(useNekoGifts.getState().gifts, place), { W: L.w, floorY: L.floorY, scale: L.S }, x, y) !== null) return null;
      return { p, x, y };
    };
    const open = (id: string) => {
      const p = live.current.placed.find((q) => q.f.id === id);
      if (p) live.current.onMenu?.({ id, x: p.box.x + p.box.w, y: p.box.y });
    };
    const onContext = (e: MouseEvent) => { const hit = at(e); if (hit) { e.preventDefault(); open(hit.p.f.id); } };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return; // 마우스는 우클릭만
      const hit = at(e);
      if (!hit) return;
      hold = { t: window.setTimeout(() => { if (hold) { open(hold.id); hold = null; } }, HOLD_MS), x: e.clientX, y: e.clientY, id: hit.p.f.id };
    };
    const cancel = () => { if (hold) { clearTimeout(hold.t); hold = null; } };
    const onMove = (e: PointerEvent) => { if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > HOLD_SLOP) cancel(); };
    window.addEventListener("contextmenu", onContext, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", cancel, true);
    window.addEventListener("pointercancel", cancel, true);
    return () => {
      cancel();
      window.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", cancel, true);
      window.removeEventListener("pointercancel", cancel, true);
    };
  }, [still, place]);

  return <canvas ref={ref} className="neko-furniture" aria-hidden="true" />;
}
