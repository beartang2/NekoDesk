import { useRef } from "react";

/**
 * 마당 네코 머리 위 꺼내기 아치(docs/neko-screen-mode.md §7). 보관함의 최근 것부터 아이콘과 이름을 무지개 모양으로 편다.
 * 열고 닫기·끌어내기(startDrag)는 호스트(NekoScreen)가 한다. 칸마다 `data-neko-arch-hit` — 호스트가 그 안을 클릭 받는 자리로 본다.
 *
 * 자리표시 그림이다. 모양(글래스 알약·펼치는 효과)은 디자이너가 고친다 — props 는 그대로 둔다.
 */
export interface NekoArchItem { name: string; path: string; dir: boolean; icon: string }

/** 아치 반지름(머리 반지름에 더함)과 칸 크기(px) */
const RISE = 90;
const ICON = 40;
/** 누르고 이만큼 움직이면 끌어내기 */
const DRAG_PX = 4;

export function NekoFileArch({ items, head, onDragOut }: {
  items: NekoArchItem[];
  head: { x: number; y: number; r: number };
  onDragOut: (item: NekoArchItem) => void;
}) {
  const press = useRef<{ item: NekoArchItem; x: number; y: number } | null>(null);
  const R = head.r + RISE + items.length * 4;
  return (
    <div
      onPointerMove={(e) => {
        const p = press.current;
        if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_PX) return;
        press.current = null;
        onDragOut(p.item);
      }}
      onPointerUp={() => { press.current = null; }}
    >
      {items.map((it, i) => {
        // 왼쪽(180°)에서 오른쪽(0°)까지 고르게. 하나면 머리 바로 위
        const a = items.length === 1 ? Math.PI / 2 : Math.PI - (i * Math.PI) / (items.length - 1);
        const x = head.x + R * Math.cos(a), y = head.y - R * Math.sin(a);
        return (
          <div
            key={it.path}
            data-neko-arch-hit
            title={it.name}
            onPointerDown={(e) => { if (e.button === 0) press.current = { item: it, x: e.clientX, y: e.clientY }; }}
            style={{ position: "fixed", left: x, top: y, transform: "translate(-50%, -50%)", display: "flex", flexDirection: "column", alignItems: "center", gap: 2, cursor: "grab" }}
          >
            <img src={it.icon} width={ICON} height={ICON} alt="" draggable={false} />
            <span style={{ maxWidth: 96, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", font: "11px system-ui", padding: "1px 7px", borderRadius: 999, color: "#fff", background: "rgba(30,30,34,0.55)", backdropFilter: "blur(8px)" }}>{it.name}</span>
          </div>
        );
      })}
    </div>
  );
}
