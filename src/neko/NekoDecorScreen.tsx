import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { decorBoxes, dragDecor, drawDecor, fallStep, hitDecorAt, rollStep, spotOf, throwVel, THROW_MIN, THROW_STILL, type DecorItem } from "./engine/decor-draw";
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
 * - 액자만 건다(0.1.32, 사용자: 마당에선 물건이 다 액자처럼 공중에 걸렸다): 액자 아닌 걸 공중에 놓으면 방처럼 이 모니터 바닥(Dock 위)으로
 *   떨어지고(fallStep), 빨리 놓으면 날아가 구르다(rollStep, 모니터 양끝에서 튕김 — 모니터를 넘지 않는다) 선 자리·각도를 저장한다.
 *   서면 메인 창에 `neko-decor-thrown` — 고양이가 이 모니터 가까이 있으면 쫓아가 친다. 선물함·다른 모니터에서 공중에 놓은 것은 메인 창이
 *   바닥 자리로 저장하고 `neko-decor-fall`(놓은 점)을 보낸다 — 여기서 거기부터 떨어지는 모습만 보인다. 창 윗면엔 안 얹는다(창은 움직이고 닫힌다)
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
    let drag: { item: DecorItem; dx: number; dy: number; x: number; bottom: number; spot: NekoDecorSpot | null; vx: number; vy: number; mt: number } | null = null;
    // 떨어지거나 굴러가는 중인 것(이 창이 그린다): 지금 자리·각도, 다 서면 끝(done)
    let fly: { id: string; x: number; bottom: number; rot: number; done: () => void } | null = null, flyRaf = 0;
    // 메인 창이 알린 '여기서 떨어진다'(neko-decor-fall) — 그 선물이 이 창 목록에 오면 보인다
    let fallHint: { id: string; x: number; y: number; at: number } | null = null;
    let elsewhere: Elsewhere | null = null;
    let sent = "";
    const geom = (fr: DecorFrame) => ({ W: fr.W, floorY: fr.floorY, scale: fr.scale });
    const sOf = (fr: DecorFrame) => Math.min(1.4, Math.max(0.35, fr.scale)); // decor-draw geomOf 와 같은 묶음
    // 끄는 사이 고양이가 그 선물을 잡아(decorHeld) 목록에서 빠져도 놓을 때까지 손에 둔다
    const shown = (fr: DecorFrame) => (drag && !fr.items.some((d) => d.id === drag?.item.id) ? [...fr.items, drag.item] : fr.items);

    const send = () => {
      if (!f || drag) return; // 끄는 동안은 Rust 가 놓을 때까지 받는다
      const still = fly ? f.items.filter((d) => d.id !== fly?.id) : f.items; // 움직이는 건 칸이 없다(서면 다시 알린다)
      const boxes: Box[] = decorBoxes(still, geom(f)).map((b) => [b.x - PAD, b.y - PAD, b.w + 2 * PAD, b.h + 2 * PAD]);
      if (menuBox.current) boxes.push(menuBox.current);
      const key = JSON.stringify(boxes);
      if (key === sent) return;
      sent = key;
      void invoke("neko_decor_boxes", { boxes }).catch(() => {});
    };
    sendBoxes.current = send;
    const draw = () => {
      if (!f || !ref.current) return;
      const lift = drag ? { id: drag.item.id, x: drag.x, bottom: drag.bottom } : fly ? { id: fly.id, x: fly.x, bottom: fly.bottom, fly: true, rot: fly.rot } : undefined;
      drawDecor(ref.current, shown(f), { ...f, dpr: window.devicePixelRatio || 1, drag: lift });
      send();
    };
    /** 메인 창이 다시 보내기 전에 바로 그려 둔다(놓은 자리로·치운 건 빼고) */
    const edit = (id: string, spot: NekoDecorSpot | null) => {
      if (!f) return;
      f = { ...f, items: spot ? f.items.map((d) => (d.id === id ? { ...d, rot: 0, ...spot } : d)) : f.items.filter((d) => d.id !== id) }; // 각도 없는 자리 = 똑바로
    };
    /**
     * item 을 (x, bottom) 에서 (vx, vy) 로 떨어뜨린다 — roll 이면 내려앉은 뒤 굴러가다 선다. save 면 선 자리(바닥 u·굴러 돈 각도)를
     * 메인 창에 저장하고, 던진 것이면 고양이가 쫓게 알린다. save 가 아니면(neko-decor-fall) 이미 저장된 바닥 자리로 떨어지는 모습만
     */
    const fall = (item: DecorItem, x: number, bottom: number, vx: number, vy: number, roll: boolean, save: boolean) => {
      if (!f) return;
      settleFly();
      const fr = f, S = sOf(fr), g = { W: fr.W, floorY: fr.floorY, S }, h = decorBoxes([item], geom(fr))[0]?.h ?? 0;
      const st = { x, bottom, vx, vy };
      let rolling: { x: number; vx: number; rot: number } | null = null, last = performance.now();
      const done = () => {
        cancelAnimationFrame(flyRaf);
        const at = fly;
        fly = null;
        if (at && save && f) {
          const r = Math.round(at.rot * 100) / 100;
          const spot: NekoDecorSpot = { surface: "floor", u: spotOf(at.x, f.floorY, h, g).u, ...(r ? { rot: r } : {}) };
          void emitTo("main", "neko-decor-move", { id: item.id, screen: f.screen, ...spot }).catch(() => {});
          if (roll) void emitTo("main", "neko-decor-thrown", { id: item.id, screen: f.screen }).catch(() => {});
          edit(item.id, spot);
        }
        draw();
      };
      fly = { id: item.id, x, bottom, rot: 0, done };
      const tick = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!fly) return;
        if (rolling) {
          const stop = rollStep(rolling, dt, g, h);
          fly = { ...fly, x: rolling.x, bottom: g.floorY, rot: rolling.rot };
          if (stop) { done(); return; }
        } else if (fallStep(st, dt, g)) {
          fly = { ...fly, x: st.x, bottom: st.bottom };
          if (!roll || Math.abs(st.vx) <= 8 * S) { done(); return; }
          rolling = { x: st.x, vx: st.vx, rot: 0 };
        } else fly = { ...fly, x: st.x, bottom: st.bottom };
        draw();
        flyRaf = requestAnimationFrame(tick);
      };
      flyRaf = requestAnimationFrame(tick);
    };
    /** 움직이던 것을 지금 자리에 세운다(다른 걸 누르거나 창이 닫힐 때) */
    const settleFly = () => { fly?.done(); };
    /** 메인 창이 알린 떨어질 점: 그 선물이 바닥 자리로 목록에 오면 거기서부터 떨어뜨린다(2초 안에 안 오면 버린다) */
    const tryFallHint = () => {
      const hint = fallHint, item = hint && f?.items.find((d) => d.id === hint.id);
      if (!hint || Date.now() - hint.at > 2000) { fallHint = null; return; }
      if (!item || item.surface !== "floor" || !f) return;
      fallHint = null;
      const h = decorBoxes([item], geom(f))[0]?.h ?? 0;
      fall(item, hint.x, Math.min(f.floorY, hint.y + h / 2), 0, 0, false, false);
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
      if (id !== null && id === fly?.id) return; // 날아가는 것의 옛 칸(그림은 이미 떠났다)
      settleFly(); // 다른 걸 잡으면 날던 건 그 자리에 선다(그리는 손이 하나다)
      const b = id === null ? undefined : decorBoxes(f.items, geom(f)).find((o) => o.id === id);
      const item = f.items.find((d) => d.id === id);
      if (!b || !item) return;
      const x = b.x + b.w / 2, bottom = b.y + b.h;
      drag = { item, dx: e.clientX - x, dy: e.clientY - bottom, x, bottom, spot: null, vx: 0, vy: 0, mt: performance.now() };
      setMenu(null);
      try { ref.current?.setPointerCapture(e.pointerId); } catch { /* 없어도 Rust 가 놓을 때까지 받는다 */ }
      draw();
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || !f) return;
      const r = dragDecor(shown(f), geom(f), drag.item.id, e.clientX - drag.dx, e.clientY - drag.dy);
      if (r) {
        const now = performance.now(), ds = Math.max(0.008, (now - drag.mt) / 1000); // 놓을 때 던지는 빠르기
        drag = { ...drag, x: r.x, bottom: r.bottom, spot: r.spot, vx: (drag.vx + (r.x - drag.x) / ds) / 2, vy: (drag.vy + (r.bottom - drag.bottom) / ds) / 2, mt: now };
      }
      draw();
    };
    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      const { item: it, item: { id }, spot: moved } = drag, d = drag;
      // 기운 물건은 집으면 똑바로(사용자) — 옮기지 않고 떼도 그 자리를 각도 없이 저장한다
      const spot = moved ?? (it.surface === "floor" && it.rot ? { surface: "floor" as const, u: it.u } : null);
      drag = null;
      // 액자 아닌 것: 빨리 놓으면 던지기, 공중에 놓으면 떨어진다(방과 같다). 놓기 전 잠깐 멈춰 있었으면 빠르기 0
      const still = performance.now() - d.mt >= THROW_STILL, vx = still ? 0 : d.vx, vy = still ? 0 : d.vy;
      const S = f ? sOf(f) : 1, fast = Math.hypot(vx, vy) > THROW_MIN * S;
      if (!elsewhere && f && moved && !it.frame && e.type === "pointerup" && (fast || moved.surface === "wall")) {
        const g = { W: f.W, floorY: f.floorY, S }, h = decorBoxes([it], geom(f))[0]?.h ?? 0, lim = 900 * S;
        const [tvx, tvy] = fast ? throwVel(vx, vy, d.bottom, h, g) : [Math.max(-lim, Math.min(lim, vx)), Math.max(-lim, Math.min(lim, vy))];
        fall(it, d.x, d.bottom, tvx, tvy, fast, true);
        elsewhere = null;
        return;
      }
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
        tryFallHint();
      }),
      me.listen<{ id: string; x: number; y: number }>("neko-decor-fall", ({ payload }) => { fallHint = { ...payload, at: Date.now() }; tryFallHint(); }),
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
      settleFly();
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
