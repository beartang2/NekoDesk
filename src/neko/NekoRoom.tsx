import { useEffect, useMemo, useRef, useState } from "react";
import { onShapeImage } from "./engine/gift-shape";
import { decorBoxes, dragDecor, drawDecor, hitDecorAt } from "./engine/decor-draw";
import type { NekoDecorSpot } from "./engine/neko-engine";
import { decorItems, useNekoGifts } from "./gifts";
import { WeatherWindow } from "./WeatherWindow";
import "./NekoRoom.css";

/**
 * 네코 방(사이드바 자리)의 겉모습: 벽·바닥·러그와 벽의 날씨 창문(RoomBackdrop, 창문은 WeatherWindow), 네코가 다른 자리에 가 있을 때
 * 방에 놓인 선물만 그린 정지 그림(RoomGifts). 엔진은 앱에 하나라 빈 방엔 엔진을 띄우지 않는다.
 *
 * 색은 벽을 패널 바탕과 거의 같은 밝기로 둬 고양이 대비를 지금처럼 지킨다 — 라이트에선 조금 어둡게(흰 고양이),
 * 다크에선 조금 밝게(검은 고양이). 선 없이 면만, 네코 그림체처럼.
 */

/** 앱 무대의 자리 계산(neko-engine 의 resize: 투명 무대라 바닥은 아래에서 6px, 배율은 높이·폭 중 작은 쪽) */
export function stageMetrics(W: number, H: number) {
  const floorY = H - 6;
  return { floorY, S: Math.min(1.4, Math.max(0.35, Math.min(floorY / 240, W / 250))) };
}

/** 벽과 바닥이 만나는 줄: 발 위. 이보다 높이 띄운 물건은 엔진이 벽에 건다(WALL_GAP 18) */
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
          <defs>
            <linearGradient id="neko-room-floor" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="neko-room__floor-far" />
              <stop offset="1" className="neko-room__floor-near" />
            </linearGradient>
          </defs>
          <rect className="neko-room__wall" x={0} y={0} width={w} height={seam} />
          <rect x={0} y={seam} width={w} height={h - seam} fill="url(#neko-room-floor)" />
          <rect className="neko-room__base" x={0} y={seam - 3 * S} width={w} height={3 * S} />
          <ellipse className="neko-room__rug" cx={w * 0.52} cy={floorY - 1} rx={w * 0.3} ry={Math.max(3, 5 * S)} />
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
 * 터치로 꾹 누르면 onMenu 로 '정리' 버튼 자리를 알린다(NekoSlot). 폰은 네코가 거실에 살아 방은 늘 이 그림이다
 */
export function RoomGifts({ isDark, onMenu }: { isDark: boolean; onMenu?: (m: { id: string; x: number; y: number }) => void }) {
  const gifts = useNekoGifts((s) => s.gifts);
  const [ref, { w, h }] = useSize<HTMLCanvasElement>();
  // 낙서 그림(shape.img)을 다 읽으면 다시 그린다(처음엔 매트만 보인다)
  const [loaded, setLoaded] = useState(0);
  useEffect(() => onShapeImage(() => setLoaded((n) => n + 1)), []);
  const items = useMemo(() => decorItems(gifts, "sidebar"), [gifts]);
  const view = useMemo(() => { const { floorY, S } = stageMetrics(w, h); return { W: w, H: h, floorY, scale: S }; }, [w, h]);
  // 끄는 중인 물건(물건 가운데 x, 바닥 y). 그리기가 무대 안으로 묶고 들어 올린 모양으로 맨 위에 그린다
  const [drag, setDrag] = useState<{ id: string; x: number; bottom: number } | null>(null);
  const press = useRef<{ id: string; pid: number; dx: number; dy: number; x0: number; y0: number; hold: number; spot: NekoDecorSpot | null } | null>(null);
  useEffect(() => () => clearTimeout(press.current?.hold), []);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !w || !h) return;
    drawDecor(cv, items, { ...view, dpr: Math.min(window.devicePixelRatio || 1, 2), dark: isDark, drag });
  }, [items, view, isDark, drag, loaded, ref, w, h]);

  const pos = (e: React.MouseEvent) => { const r = e.currentTarget.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const boxOf = (id: string | null) => (id === null ? undefined : decorBoxes(items, view).find((b) => b.id === id));
  const menu = (id: string | null) => { const b = boxOf(id); if (b) onMenu?.({ id: b.id, x: b.x + b.w, y: b.y }); return !!b; };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const [x, y] = pos(e), b = boxOf(hitDecorAt(items, view, x, y));
    if (!b) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 이미 끝난 포인터 */ }
    const p = { id: b.id, pid: e.pointerId, dx: x - (b.x + b.w / 2), dy: y - (b.y + b.h), x0: x, y0: y, hold: 0, spot: null };
    // 터치·펜으로 꾹 누르면 끌기를 접고 '정리' 메뉴(iOS 웹뷰엔 contextmenu 가 안 온다). 마우스는 우클릭만
    if (e.pointerType !== "mouse") p.hold = window.setTimeout(() => { if (press.current !== p) return; press.current = null; setDrag(null); menu(p.id); }, HOLD_MS);
    press.current = p;
    setDrag({ id: b.id, x: b.x + b.w / 2, bottom: b.y + b.h });
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const [x, y] = pos(e), p = press.current;
    if (!p || e.pointerId !== p.pid) { e.currentTarget.classList.toggle("can-grab", hitDecorAt(items, view, x, y) !== null); return; }
    if (p.hold && Math.hypot(x - p.x0, y - p.y0) > HOLD_SLOP) { clearTimeout(p.hold); p.hold = 0; } // 움직이면 그냥 끌기
    const r = dragDecor(items, view, p.id, x - p.dx, y - p.dy);
    if (r) { p.spot = r.spot; setDrag({ id: p.id, x: r.x, bottom: r.bottom }); }
  };
  const onPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = press.current;
    if (!p || e.pointerId !== p.pid) return;
    clearTimeout(p.hold); press.current = null; setDrag(null);
    if (p.spot && e.type === "pointerup") useNekoGifts.getState().place(p.id, p.spot); // 움직이지 않고 떼면 그대로
  };
  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const [x, y] = pos(e);
    if (menu(hitDecorAt(items, view, x, y))) e.preventDefault();
  };
  return (
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
  );
}
