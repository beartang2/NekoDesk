import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { decorBoxes, dragDecor, drawDecor, hitDecorAt, type DecorItem } from "./engine/decor-draw";
import { onShapeImage } from "./engine/gift-shape";
import type { NekoDecorSpot } from "./engine/neko-engine";
import { useKeepInside } from "./keepInside";
import "./NekoScreen.css";

/**
 * 마당 선물 창(`neko-decor-<모니터 UUID>`, docs/neko-screen-mode.md §8-1): 모니터 하나를 덮고 그 모니터에 놓인 선물을
 * 그린다. 고양이가 어디 있든 같다 — 고양이 창은 한 층 위에 고양이만, 갖고 노는 동안 잡은 선물만 그린다.
 *
 * - 그림은 메인 창이 바뀔 때만 보낸다(`neko-decor-items`). 받을 때·끄는 동안만 그린다 — 계속 도는 그리기는 없다.
 * - 클릭: 그린 선물 칸을 Rust 에 알려 두면(`neko_decor_boxes`) 커서가 그 안일 때만 이 창이 받는다. 나머지는 뒤로 흘린다.
 * - 끌어 옮기기 → 메인 창 `neko-decor-move`. 끄는 중 커서가 다른 모니터면(Rust `neko-screen-elsewhere`) 놓을 때
 *   `neko-screen-put-on` 으로 그 모니터로. 우클릭 '정리' → `neko-screen-put`(선물함으로).
 */
interface DecorFrame { items: DecorItem[]; W: number; H: number; floorY: number; scale: number; dark: boolean; screen: string }
interface Elsewhere { screen: string; x: number; y: number }
type Box = [number, number, number, number];

/** '정리' 버튼이 저절로 닫히는 때(화면 창과 같다) */
const MENU_MS = 6000;
/** 선물 칸 둘레 여유(누르기 판정, hitDecorAt 과 비슷하게) */
const PAD = 4;

export function NekoDecorScreen() {
  const ref = useRef<HTMLCanvasElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useKeepInside(menuRef, menu); // 화면 가장자리에서 열어도 창 안에 다 보이게
  // 메뉴 버튼 칸도 Rust 에 알려야 누를 수 있다(렌더 뒤에 잰다)
  const menuBox = useRef<Box | null>(null);
  const sendBoxes = useRef<() => void>(() => {});
  const putAway = useRef<(id: string) => void>(() => {});

  useEffect(() => {
    const r = menuRef.current?.getBoundingClientRect();
    menuBox.current = r ? [r.left, r.top, r.width, r.height] : null;
    sendBoxes.current();
    if (!menu) return;
    const t = setTimeout(() => setMenu(null), MENU_MS);
    return () => clearTimeout(t);
  }, [menu]);

  useEffect(() => {
    let f: DecorFrame | null = null;
    // 끄는 중: 끄는 물건, 누른 자리와 물건 바닥 가운데의 차이, 지금 그릴 자리, 놓을 자리(움직였을 때만)
    let drag: { item: DecorItem; dx: number; dy: number; x: number; bottom: number; spot: NekoDecorSpot | null } | null = null;
    let elsewhere: Elsewhere | null = null;
    let sent = "";
    const geom = (fr: DecorFrame) => ({ W: fr.W, floorY: fr.floorY, scale: fr.scale });
    // 끄는 사이 고양이가 그 선물을 잡아(decorHeld) 목록에서 빠져도 놓을 때까지 손에 둔다
    const shown = (fr: DecorFrame) => (drag && !fr.items.some((d) => d.id === drag?.item.id) ? [...fr.items, drag.item] : fr.items);

    const send = () => {
      if (!f || drag) return; // 끄는 동안은 Rust 가 놓을 때까지 받는다
      const boxes: Box[] = decorBoxes(f.items, geom(f)).map((b) => [b.x - PAD, b.y - PAD, b.w + 2 * PAD, b.h + 2 * PAD]);
      if (menuBox.current) boxes.push(menuBox.current);
      const key = JSON.stringify(boxes);
      if (key === sent) return;
      sent = key;
      void invoke("neko_decor_boxes", { boxes }).catch(() => {});
    };
    sendBoxes.current = send;
    const draw = () => {
      if (!f || !ref.current) return;
      const lift = drag ? { id: drag.item.id, x: drag.x, bottom: drag.bottom } : undefined;
      drawDecor(ref.current, shown(f), { ...f, dpr: window.devicePixelRatio || 1, drag: lift });
      send();
    };
    /** 메인 창이 다시 보내기 전에 바로 그려 둔다(놓은 자리로·치운 건 빼고) */
    const edit = (id: string, spot: NekoDecorSpot | null) => {
      if (!f) return;
      f = { ...f, items: spot ? f.items.map((d) => (d.id === id ? { ...d, ...spot } : d)) : f.items.filter((d) => d.id !== id) };
    };
    putAway.current = (id) => {
      void emitTo("main", "neko-screen-put", id).catch(() => {});
      edit(id, null);
      draw();
    };

    const isRight = (e: MouseEvent) => e.button === 2 || (e.button === 0 && e.ctrlKey);
    const onDown = (e: PointerEvent) => {
      elsewhere = null;
      if (!f || isRight(e) || e.button !== 0 || (e.target as Element | null)?.closest?.("button")) return;
      const id = hitDecorAt(f.items, geom(f), e.clientX, e.clientY);
      const b = id === null ? undefined : decorBoxes(f.items, geom(f)).find((o) => o.id === id);
      const item = f.items.find((d) => d.id === id);
      if (!b || !item) return;
      const x = b.x + b.w / 2, bottom = b.y + b.h;
      drag = { item, dx: e.clientX - x, dy: e.clientY - bottom, x, bottom, spot: null };
      setMenu(null);
      try { ref.current?.setPointerCapture(e.pointerId); } catch { /* 없어도 Rust 가 놓을 때까지 받는다 */ }
      draw();
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || !f) return;
      const r = dragDecor(shown(f), geom(f), drag.item.id, e.clientX - drag.dx, e.clientY - drag.dy);
      if (r) drag = { ...drag, x: r.x, bottom: r.bottom, spot: r.spot };
      draw();
    };
    const onUp = () => {
      if (!drag) return;
      const { item: { id }, spot } = drag;
      drag = null;
      if (elsewhere) {
        void emitTo("main", "neko-screen-put-on", { id, ...elsewhere }).catch(() => {});
        edit(id, null);
      } else if (spot && f) {
        void emitTo("main", "neko-decor-move", { id, screen: f.screen, ...spot }).catch(() => {});
        edit(id, spot);
      }
      elsewhere = null;
      draw();
    };
    const onContext = (e: MouseEvent) => {
      e.preventDefault(); // 이 창은 선물 위에서만 클릭을 받는다 — 웹뷰 기본 메뉴는 늘 막는다
      if (!f || drag) return;
      const id = hitDecorAt(f.items, geom(f), e.clientX, e.clientY);
      const b = id === null ? undefined : decorBoxes(f.items, geom(f)).find((o) => o.id === id);
      if (b) setMenu({ id: b.id, x: b.x + b.w, y: b.y });
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("contextmenu", onContext);

    // 이 창 앞으로 온 것만 듣는다. 그냥 listen 은 대상이 Any 라 다른 창(다른 모니터 선물 창) 앞 이벤트까지 받는다
    const me = getCurrentWindow();
    const offs = [
      me.listen<DecorFrame>("neko-decor-items", ({ payload }) => {
        f = payload;
        setMenu((m) => (m && f?.items.some((d) => d.id === m.id) ? m : null));
        draw();
      }),
      me.listen("neko-screen-press-out", () => setMenu(null)), // 다른 데를 눌렀다
      me.listen<Elsewhere | null>("neko-screen-elsewhere", ({ payload }) => { elsewhere = payload; }),
    ];
    // 다른 배율 모니터로 옮겨지면 선명하게 다시
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", draw);
    // 그림 칸(shape.img, 채팅 낙서)은 처음 볼 때 읽는다 — 다 읽으면 다시 그린다(그 전엔 매트만)
    const offImg = onShapeImage(draw);
    void Promise.all(offs).then(() => emitTo("main", "neko-decor-ready")).catch(() => {});
    // 첫 화면을 그렸다 — 투명도 0 으로 만든 창을 보인다(그리기 전 한 프레임이 모니터를 덮지 않게, 안 부르면 Rust 가 조금 뒤 보인다)
    requestAnimationFrame(() => requestAnimationFrame(() => void invoke("neko_screen_reveal").catch(() => {})));
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("contextmenu", onContext);
      offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
      mq.removeEventListener("change", draw);
      offImg();
    };
  }, []);

  return (
    <>
      <canvas ref={ref} className="neko-decor-screen" aria-hidden="true" />
      {menu && (
        <button
          ref={menuRef}
          type="button"
          className="neko-screen__tidy"
          style={{ left: menu.x + 2, top: Math.max(2, menu.y - 4) }}
          onClick={() => { putAway.current(menu.id); setMenu(null); }}
        >
          정리
        </button>
      )}
    </>
  );
}
