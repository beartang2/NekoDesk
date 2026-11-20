import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./NekoFileArch.css";

/**
 * 마당 네코 머리 위 꺼내기 아치(docs/neko-screen-mode.md §7). 보관함의 최근 것부터 12개까지 아이콘과 이름 알약을
 * 무지개처럼 두 겹 띠로 편다(안쪽 5개, 바깥 7개). 열고 닫기·끌어내기(startDrag)는 호스트(NekoScreen)가 한다 —
 * 이 컴포넌트는 그려지면 머리에서 날아올라 펼치는 효과만. 칸마다 `data-neko-arch-hit`: 호스트가 그 안을 클릭 받는 자리로 본다.
 * 화면 가장자리에서 열려도 창 안에 다 보이게 아치 전체를 안쪽으로 민다. 움직임은 transform·opacity 만(투명 창이라 합성만)
 */
export interface NekoArchItem { name: string; path: string; dir: boolean; icon: string }

/** 펼칠 최대 개수 */
export const ARCH_MAX = 12;
/** 안쪽 띠 개수(나머지 최대 7개는 바깥 띠). 이름 알약(64px)이 같은 띠에서 안 겹치는 간격 */
const INNER = 5;
/** 띠 반지름(px), 펼치는 각(머리 위 반원에서 양끝을 조금 남긴다) */
const R_IN = 118, R_OUT = 196, SPAN = (140 * Math.PI) / 180;
/** 칸(아이콘+알약)의 반폭·위·아래(px, NekoFileArch.css 와 같다) — 창 안에 두기 계산용. 창 가장자리 여백 */
const HALF_W = 32, TOP = 24, BOTTOM = 46, EDGE = 8;
/** 누르고 이만큼 움직이면 끌어내기 */
const DRAG_PX = 4;

/** 아치 자리: 기준점(0,0) 위 각 칸 가운데(아이콘 가운데)의 (x, y). 안쪽 띠 먼저 왼쪽에서 오른쪽, 넘치면 바깥 띠. 순수 함수 */
export function archSpots(n: number): { x: number; y: number }[] {
  const m = Math.min(n, ARCH_MAX), inner = Math.min(m, INNER), outer = m - inner;
  const band = (count: number, r: number) =>
    Array.from({ length: count }, (_, i) => {
      const t = count === 1 ? 0.5 : i / (count - 1), a = Math.PI + (Math.PI - SPAN) / 2 + t * SPAN; // 왼쪽 위 → 오른쪽 위
      return { x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r) };
    });
  return [...band(inner, R_IN), ...band(outer, R_OUT)];
}

/** 아치 기준점: 머리 가운데에서 머리 반지름 + 여백만큼 위(양끝 칸이 귀·몸에 안 걸리게), 창 안에 다 들게 민 자리. 순수 함수 */
export function archOrigin(head: { x: number; y: number; r: number }, spots: { x: number; y: number }[], view: { w: number; h: number }) {
  let x = head.x, y = head.y - head.r - 12;
  if (!spots.length) return { x, y };
  const x0 = Math.min(...spots.map((p) => p.x)) - HALF_W, x1 = Math.max(...spots.map((p) => p.x)) + HALF_W;
  const y0 = Math.min(...spots.map((p) => p.y)) - TOP, y1 = Math.max(...spots.map((p) => p.y)) + BOTTOM;
  x = Math.min(Math.max(x, EDGE - x0), view.w - EDGE - x1);
  y = Math.min(Math.max(y, EDGE - y0), view.h - EDGE - y1);
  return { x, y };
}

/** 글자 폭: 한글·한자·전각은 2, 나머지 1 */
const cw = (ch: string) => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠]/.test(ch) ? 2 : 1);
const width = (s: string) => [...s].reduce((a, ch) => a + cw(ch), 0);
/** 이름이 길면 줄인다(확장자는 남긴다). max = 폭(영문 1, 한글 2) — 알약(64px)에 들어가게 */
export function shortName(name: string, max = 11): string {
  if (width(name) <= max) return name;
  const dot = name.lastIndexOf("."), ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : "";
  let head = "", room = max - width(ext) - 1;
  for (const ch of name.slice(0, name.length - ext.length)) { if (cw(ch) > room) break; head += ch; room -= cw(ch); }
  return `${head.trimEnd()}…${ext}`;
}

export function NekoFileArch({ items, head, onDragOut }: {
  items: NekoArchItem[];
  head: { x: number; y: number; r: number };
  onDragOut: (item: NekoArchItem) => void;
}) {
  const shown = items.slice(0, ARCH_MAX), spots = archSpots(shown.length);
  const o = archOrigin(head, spots, { w: window.innerWidth, h: window.innerHeight });
  // 그려진 다음 프레임에 펼친다(머리에서 제자리로 날아오르는 전환이 걸리게)
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => { const id = requestAnimationFrame(() => setOpen(true)); return () => cancelAnimationFrame(id); }, []);
  const press = useRef<{ item: NekoArchItem; x: number; y: number } | null>(null);
  useEffect(() => () => { press.current = null; }, []);
  // 머리가 아치 기준점에서 얼마나 떨어졌나: 칸이 머리에서 날아오르게 그 차이에서 시작한다
  const from = { x: head.x - o.x, y: head.y - o.y };
  return (
    <div
      className={`neko-arch${open ? " neko-arch--open" : ""}`}
      style={{ left: o.x, top: o.y, "--fx": `${from.x}px`, "--fy": `${from.y}px` } as React.CSSProperties}
    >
      {shown.map((it, i) => (
        <div
          key={it.path}
          data-neko-arch-hit
          className={`neko-arch__item${it.dir ? " neko-arch__item--dir" : ""}`}
          style={{ "--x": `${spots[i].x}px`, "--y": `${spots[i].y}px`, "--i": i } as React.CSSProperties}
          title={it.name}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            press.current = { item: it, x: e.clientX, y: e.clientY };
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 이미 끝난 포인터 */ }
          }}
          onPointerMove={(e) => {
            const p = press.current;
            if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) <= DRAG_PX) return;
            press.current = null;
            onDragOut(p.item);
          }}
          onPointerUp={() => { press.current = null; }}
          onPointerCancel={() => { press.current = null; }}
        >
          <img className="neko-arch__icon" src={it.icon} alt="" draggable={false} />
          <span className="neko-arch__name">{shortName(it.name)}</span>
        </div>
      ))}
    </div>
  );
}
