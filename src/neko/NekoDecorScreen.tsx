import { useEffect, useRef } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { drawDecor, type DecorItem } from "./engine/decor-draw";
import "./NekoScreen.css";

/**
 * 마당 선물 창(`neko-decor-N`, docs/neko-screen-mode.md §8-1): 고양이가 없는 모니터 하나를 덮고 그 모니터에 놓인
 * 선물만 그린다. 클릭은 늘 뒤로 흘린다(그림만 — 놀이·끌기는 고양이가 건너오면 엔진이 한다).
 *
 * 그림은 메인 창이 바뀔 때만 보낸다(`neko-decor-items`). 받을 때 한 번 그리고 끝 — 계속 도는 그리기는 없다.
 */
interface DecorFrame { items: DecorItem[]; W: number; H: number; floorY: number; scale: number; dark: boolean }

export function NekoDecorScreen() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let last: DecorFrame | null = null;
    const draw = () => { if (last && ref.current) drawDecor(ref.current, last.items, { ...last, dpr: window.devicePixelRatio || 1 }); };
    const off = listen<DecorFrame>("neko-decor-items", ({ payload }) => { last = payload; draw(); });
    // 다른 배율 모니터로 옮겨지면 선명하게 다시
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", draw);
    void off.then(() => emitTo("main", "neko-decor-ready")).catch(() => {});
    return () => { void off.then((f) => f()).catch(() => {}); mq.removeEventListener("change", draw); };
  }, []);
  return <canvas ref={ref} className="neko-decor-screen" aria-hidden="true" />;
}
