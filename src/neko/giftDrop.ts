import { listen } from "@tauri-apps/api/event";
import { stageS } from "./engine/stage-scale";
import { dropSpot, useNekoGifts } from "./gifts";
import { placeInYard } from "./remoteNeko";
import { holdTops, useNekoFurniture } from "./furniture";
import type { NekoPlacement } from "./nekoStore";

/**
 * 선물함 창에서 끈 선물을 놓은 자리에 둔다(맥, 메인 창에서 한 번). 끌기는 Rust 가 연다(neko_screen gift_drag) — 커서 자리로
 * 메인 창 위인지, 앱 창 밖(= 마당, 그 모니터)인지 정해 보낸다. 메인 창 위면 그 점의 무대가 방(사이드바, 늘 보임)인지
 * 거실(채팅 바 아래, 네코가 거실에 있을 때만 있음)인지 여기서 고르고, 무대가 아니면(채팅 등) 취소다. 네코가 어디 있든 같다.
 * 끄는 동안 놓을 수 있는 무대에 테두리, 커서 밑 무대는 진하게(NekoSlot.css).
 */
type Drop = { to: "main"; x: number; y: number } | { to: "yard"; screen: string; x: number; y: number; w: number; ground: number };

/** 메인 창 그 점(css px)의 무대. 방·거실 자리 요소(.neko-slot--sidebar·--dock)만 */
function stageAt(x: number, y: number): { at: NekoPlacement; el: HTMLElement } | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".neko-slot");
  const at = el?.classList.contains("neko-slot--sidebar") ? "sidebar" : el?.classList.contains("neko-slot--dock") ? "dock" : null;
  return el && at ? { at, el } : null;
}

function drop(id: string, d: Drop): void {
  const g = useNekoGifts.getState().gifts.find((o) => o.id === id);
  if (!g) return;
  if (d.to === "yard") { // 액자 아닌 걸 공중에 놓으면 그 모니터 바닥으로 떨어진다(placeInYard)
    placeInYard(id, d.screen, d.x, d.y, d.w, d.ground);
    return;
  }
  const s = stageAt(d.x, d.y);
  if (!s) return;
  // 무대 = 고양이 캔버스(빈 방은 선물 그림 캔버스). 산책 중이라 없으면 자리 전체. 바닥은 아래에서 6px(엔진 resize 와 같다)
  const r = (s.el.querySelector("canvas.neko-canvas, canvas.neko-room__gifts") ?? s.el).getBoundingClientRect();
  const floorY = r.height - 6;
  const S = stageS(r.width, floorY, s.at), tops = s.at === "sidebar" || s.at === "dock" ? holdTops(useNekoFurniture.getState().items, s.at, r.width, floorY, S) : [];
  useNekoGifts.getState().place(id, dropSpot(g, s.at, d.x - r.left, d.y - r.top, { W: r.width, floorY, S, tops }), s.at); // 탁자 윗면 근처면 그 위에
}

let over: HTMLElement | null = null;
const hover = (el: HTMLElement | null) => {
  if (el === over) return;
  over?.classList.remove("gift-over");
  el?.classList.add("gift-over");
  over = el;
};

let started = false;
export function listenGiftDrop(): void {
  if (started) return;
  started = true;
  void listen<boolean>("neko-gift-drag", ({ payload }) => {
    document.documentElement.classList.toggle("gift-drag", payload);
    if (!payload) hover(null);
  }).catch(() => {});
  void listen<Drop | null>("neko-gift-hover", ({ payload }) => hover(payload?.to === "main" ? stageAt(payload.x, payload.y)?.el ?? null : null)).catch(() => {});
  void listen<{ id: string } & Drop>("neko-gift-drop", ({ payload: { id, ...d } }) => drop(id, d as Drop)).catch(() => {});
}
