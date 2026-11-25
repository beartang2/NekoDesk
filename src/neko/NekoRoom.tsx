import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { onShapeImage } from "./engine/gift-shape";
import { decorBoxes, decorDims, decorK, dragDecor, drawDecor, fallStep, hitDecorAt, rollStep, spotOf, throwVel, THROW_MIN, THROW_STILL } from "./engine/decor-draw";
import { validateShape } from "./engine/gift-shape";
import { stageS } from "./engine/stage-scale";
import type { NekoDecorSpot } from "./engine/neko-engine";
import type { DecorDrag } from "./engine/decor-draw";
import { decorItems, useNekoGifts } from "./gifts";
import { holdTops, useNekoFurniture } from "./furniture";
import { WeatherWindow } from "./WeatherWindow";
import { FloorBand, SkyTint, WallPattern } from "./Wallpaper";
import { setHolding } from "./holding";
import { useShown } from "../lib/useShown";
import "./NekoRoom.css";

/**
 * 네코 방(사이드바 자리)의 겉모습: 벽·바닥·러그와 벽의 날씨 창문(RoomBackdrop, 창문은 WeatherWindow), 네코가 다른 자리에 가 있을 때
 * 방에 놓인 선물만 그린 정지 그림(RoomGifts). 엔진은 앱에 하나라 빈 방엔 엔진을 띄우지 않는다.
 *
 * 색은 벽을 패널 바탕과 거의 같은 밝기로 둬 고양이 대비를 지금처럼 지킨다 — 라이트에선 조금 어둡게(흰 고양이),
 * 다크에선 조금 밝게(검은 고양이). 선 없이 면만, 네코 그림체처럼.
 */

/** 앱 무대의 자리 계산(neko-engine 의 resize: 투명 무대라 바닥은 아래에서 6px, 배율은 높이·폭 중 작은 쪽 × 방 배율 0.82 — 맥·폰 같다, stage-scale ROOM_K) */
export function stageMetrics(W: number, H: number) {
  const floorY = H - 6;
  return { floorY, S: stageS(W, floorY, "sidebar") };
}

/** 벽과 바닥이 만나는 줄: 발 위(WALL_GAP 18). 이보다 높이 놓은 액자는 벽에 걸리고, 다른 물건은 떨어진다 */
const seamOf = (floorY: number, S: number) => floorY - 18 * S;

function useSize<T extends Element>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** 방 배경. 방(.cat-room = 사이드바 네코 자리 높이)을 채운다. 창문은 벽 위, 네코 자리 아래 */
export function RoomBackdrop() {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  const { floorY, S } = stageMetrics(w, h);
  const seam = seamOf(floorY, S);

  return (
    <div ref={ref} className="neko-room">
      {w > 0 && h > 0 && (
        <svg width={w} height={h} aria-hidden="true">
          <rect className="neko-room__wall" x={0} y={0} width={w} height={seam} />
          <WallPattern place="sidebar" w={w} wallH={seam} />
          <FloorBand w={w} h={h} seam={seam} S={S} />
          <ellipse className="neko-room__rug" cx={w * 0.52} cy={floorY - 1} rx={w * 0.3} ry={Math.max(3, 5 * S)} />
          <SkyTint w={w} h={h} />
        </svg>
      )}
      <WeatherWindow place="sidebar" />
    </div>
  );
}

/** 꾹 누르기('정리' 메뉴): 이만큼(ms) 이 거리(px) 안에서 누르고 있으면. 엔진 무대와 같다 */
const HOLD_MS = 500, HOLD_SLOP = 8;

/**
 * 네코가 다른 자리(거실·마당)에 가 있을 때 방에 놓인 선물. 엔진 무대·마당 선물 창과 같은 그리기(decor-draw drawDecor)로
 * 정지 그림만 그린다(뿅·흔들림 없이). 엔진이 없어도 옮기고 치울 수 있다 — 끌면 옮기고(놓을 때 선물함에 적는다), 우클릭이나
 * 터치로 꾹 누르면 onMenu 로 '정리' 버튼 자리를 알린다(NekoSlot). 폰은 네코가 거실에 살아 방은 늘 이 그림이다.
 * 벽에 건 것은 children(가구 정지 그림) 밑 캔버스에 따로 — 벽 → 벽 선물 → 가구 → 바닥 선물(사용자: 가구 위에 액자가 걸리지 않게).
 * 끄는 것은 위 캔버스(맨 위). 누르기는 위 캔버스가 다 받는다
 */
export function RoomGifts({ isDark, onMenu, children }: { isDark: boolean; onMenu?: (m: { id: string; x: number; y: number }) => void; children?: ReactNode }) {
  const gifts = useNekoGifts((s) => s.gifts);
  const [ref, { w, h }] = useSize<HTMLCanvasElement>();
  const wallRef = useRef<HTMLCanvasElement>(null);
  // 낙서 그림(shape.img)을 다 읽으면 다시 그린다(처음엔 매트만 보인다)
  const [loaded, setLoaded] = useState(0);
  useEffect(() => onShapeImage(() => setLoaded((n) => n + 1)), []);
  const shown = useShown(); // 다시 보이면 다시 그린다 — iOS 가 뒤에 있는 동안 캔버스를 비울 수 있다
  const items = useMemo(() => decorItems(gifts, "sidebar"), [gifts]);
  // 탁자 위 선물(가구 윗면): 놓인 가구의 물건 얹는 면을 엔진과 같은 자리로
  const furn = useNekoFurniture((s) => s.items);
  const view = useMemo(() => { const { floorY, S } = stageMetrics(w, h); return { W: w, H: h, floorY, scale: S, tops: holdTops(furn, "sidebar", w, floorY, S) }; }, [w, h, furn]);
  // 끄는 중인 물건(물건 가운데 x, 바닥 y). 그리기가 무대 안으로 묶고 들어 올린 모양으로 맨 위에 그린다
  const [drag, setDrag] = useState<DecorDrag | null>(null);
  const press = useRef<{ id: string; pid: number; dx: number; dy: number; x0: number; y0: number; hold: number; spot: NekoDecorSpot | null; vx: number; vy: number; mt: number; x: number; bottom: number } | null>(null);
  const fallRaf = useRef(0);
  // 날아가거나 굴러가는 중인 것(던지기·벽 쪽에 놓아 떨어짐): 지금 그린 자리(가운데 x, 바닥)·칸·각도. 다 서야 저장된다
  const fly = useRef<{ id: string; x: number; bottom: number; w: number; h: number; rot: number; geom: { W: number; floorY: number; S: number } } | null>(null);
  /**
   * 날던 것을 지금 자리에 세워 저장한다(바닥 그 가로 자리, 굴러 돈 각도) — 사용자가 물건을 다시 집거나 방이 닫힐 때.
   * 안 그러면 굴림이 끊긴 채 저장이 안 돼 원래 자리로 돌아갔다(사용자: 방에서 구른 물건이 다시 원래대로 돌아와)
   */
  const settleFly = () => {
    const f = fly.current;
    if (!f) return null;
    cancelAnimationFrame(fallRaf.current); fly.current = null;
    useNekoGifts.getState().place(f.id, { surface: "floor", u: spotOf(f.x, f.geom.floorY, f.h, f.geom).u, rot: f.rot });
    return f;
  };
  useEffect(() => () => { clearTimeout(press.current?.hold); settleFly(); if (press.current) setHolding(false); }, []);
  useEffect(() => {
    const cv = ref.current, wall = wallRef.current;
    if (!cv || !wall || !w || !h) return;
    const o = { ...view, dpr: Math.min(window.devicePixelRatio || 1, 2), dark: isDark, drag };
    drawDecor(wall, items, { ...o, only: "wall" });
    drawDecor(cv, items, { ...o, only: "rest" });
  }, [items, view, isDark, drag, loaded, shown, ref, w, h]);

  const pos = (e: React.MouseEvent) => { const r = e.currentTarget.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const boxOf = (id: string | null) => (id === null ? undefined : decorBoxes(items, view).find((b) => b.id === id));
  const menu = (id: string | null) => { const b = boxOf(id); if (b) onMenu?.({ id: b.id, x: b.x + b.w, y: b.y }); return !!b; };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    // 날던 것은 지금 그린 자리로 누르고(저장된 자리는 아직 굴리기 전 자리), 그 밖의 것은 저장된 자리로
    const [x, y] = pos(e), f = fly.current, pad = 3 * view.scale;
    const onFly = !!f && Math.abs(x - f.x) <= f.w / 2 + pad && y >= f.bottom - f.h - pad && y <= f.bottom + pad;
    const hit = onFly ? null : hitDecorAt(items, view, x, y);
    const b = onFly ? { id: f.id, x: f.x - f.w / 2, y: f.bottom - f.h, w: f.w, h: f.h } : hit !== null && hit !== f?.id ? boxOf(hit) : undefined;
    if (!b) return;
    // 잡으면 굴림을 멈춘다 — 굴림과 끌기가 같이 자리를 바꿔 버벅였다(사용자). 다른 걸 잡아도 날던 건 그 자리에 선다(그림 자리가 하나다)
    settleFly();
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 이미 끝난 포인터 */ }
    const p = { id: b.id, pid: e.pointerId, dx: x - (b.x + b.w / 2), dy: y - (b.y + b.h), x0: x, y0: y, hold: 0, spot: null, vx: 0, vy: 0, mt: performance.now(), x: b.x + b.w / 2, bottom: b.y + b.h };
    // 터치·펜으로 꾹 누르면 끌기를 접고 '정리' 메뉴(iOS 웹뷰엔 contextmenu 가 안 온다). 마우스는 우클릭만
    if (e.pointerType !== "mouse") p.hold = window.setTimeout(() => { if (press.current !== p) return; press.current = null; setHolding(false); setDrag(null); menu(p.id); }, HOLD_MS);
    press.current = p;
    setHolding(true);
    setDrag({ id: b.id, x: b.x + b.w / 2, bottom: b.y + b.h });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = pos(e), p = press.current;
    if (!p || e.pointerId !== p.pid) { e.currentTarget.classList.toggle("can-grab", hitDecorAt(items, view, x, y) !== null); return; }
    if (p.hold && Math.hypot(x - p.x0, y - p.y0) > HOLD_SLOP) { clearTimeout(p.hold); p.hold = 0; } // 움직이면 그냥 끌기
    const r = dragDecor(items, view, p.id, x - p.dx, y - p.dy);
    if (!r) return;
    const now = performance.now(), ds = Math.max(0.008, (now - p.mt) / 1000); // 놓을 때 던지는 속도
    p.vx = (p.vx + (r.x - p.x) / ds) / 2; p.vy = (p.vy + (r.bottom - p.bottom) / ds) / 2; p.mt = now; p.x = r.x; p.bottom = r.bottom;
    p.spot = r.spot; setDrag({ id: p.id, x: r.x, bottom: r.bottom });
  };
  /**
   * 액자 아닌 물건을 벽 쪽에 놓았다: 엔진과 같은 중력·튕김으로 떨어뜨리고(fallStep) 내려앉은 바닥 자리를 적는다(사용자, 0.1.24).
   * roll(던지기, 사용자): 놓는 순간의 빠르기로 날아가 떨어지고 바닥에선 굴러가다(rollStep) 선 자리를 적는다. 네코가 없으니 쫓지는 않는다
   */
  const dropToFloor = (p: NonNullable<typeof press.current>, roll = false) => {
    const it = items.find((d) => d.id === p.id);
    if (!it) return;
    const shape = validateShape(it.shape), geom = { W: view.W, floorY: view.floorY, S: view.scale };
    const { w, h } = decorDims(shape, decorK(shape, it.size, it.scale, "sidebar", geom).k, geom.S), lim = 900 * geom.S;
    const [vx, vy] = roll ? throwVel(p.vx, p.vy, p.bottom, h, geom) : [Math.max(-lim, Math.min(lim, p.vx)), Math.max(-lim, Math.min(lim, p.vy))];
    const f = { x: p.x, bottom: p.bottom, vx, vy };
    let rolling: { x: number; vx: number; rot: number } | null = null, last = performance.now();
    const now0 = { id: p.id, x: f.x, bottom: f.bottom, w, h, rot: 0, geom };
    fly.current = now0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (rolling) {
        const stop = rollStep(rolling, dt, geom, h);
        Object.assign(now0, { x: rolling.x, bottom: geom.floorY, rot: rolling.rot });
        if (stop) { setDrag(null); settleFly(); return; } // 선 자리·각도를 저장
        setDrag({ id: p.id, x: rolling.x, bottom: geom.floorY, fly: true, rot: rolling.rot });
      } else if (fallStep(f, dt, geom)) {
        Object.assign(now0, { x: f.x, bottom: f.bottom });
        if (!roll || Math.abs(f.vx) <= 8 * geom.S) { setDrag(null); settleFly(); return; }
        rolling = { x: f.x, vx: f.vx, rot: 0 };
      } else { Object.assign(now0, { x: f.x, bottom: f.bottom }); setDrag({ id: p.id, x: f.x, bottom: f.bottom, fly: roll }); }
      fallRaf.current = requestAnimationFrame(tick);
    };
    fallRaf.current = requestAnimationFrame(tick);
  };
  const onPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pid) return;
    clearTimeout(p.hold); press.current = null; setHolding(false);
    if (performance.now() - p.mt >= THROW_STILL) { p.vx = 0; p.vy = 0; } // 멈춰 있다 놓았다: 던지지 않는다
    const frame = items.find((d) => d.id === p.id)?.frame;
    if (!frame && e.type === "pointerup" && p.spot && Math.hypot(p.vx, p.vy) > THROW_MIN * view.scale) { dropToFloor(p, true); return; } // 던지기
    if (p.spot?.surface === "wall" && !frame && e.type === "pointerup") { dropToFloor(p); return; } // 액자만 벽에 건다
    setDrag(null);
    // 액자는 바닥 근처에 놓아도 벽 맨 아래에(떨어진 액자를 집어 다시 걸 때도) — 바닥에 눕는 건 네코가 떨군 것뿐
    const spot = frame && p.spot?.surface === "floor" ? { surface: "wall" as const, u: p.spot.u, v: 0 } : p.spot;
    if (spot && e.type === "pointerup") useNekoGifts.getState().place(p.id, spot);
    else if (e.type === "pointerup") { // 움직이지 않고 떼면 그 자리 — 기운 물건은 집은 것이라 똑바로(사용자). 누운 액자는 그대로
      const it = items.find((d) => d.id === p.id);
      if (it && it.surface !== "wall" && it.rot && !(it.frame && it.surface === "floor")) useNekoGifts.getState().place(p.id, it.surface === "furniture" ? { surface: "furniture", u: it.u, fid: it.fid, i: it.i, fu: it.fu } : { surface: "floor", u: it.u });
    }
  };
  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const [x, y] = pos(e);
    if (menu(hitDecorAt(items, view, x, y))) e.preventDefault();
  };
  return (<>
    <canvas ref={wallRef} className="neko-room__gifts neko-room__gifts--wall" aria-hidden="true" />
    {children}
    <canvas
      ref={ref}
      className={`neko-room__gifts${drag ? " dragging" : ""}`}
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onContextMenu={onContextMenu}
    />
  </>);
}
