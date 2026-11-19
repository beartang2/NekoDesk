import { useEffect, useId, useRef, useState } from "react";
import { useSettingsStore, type NekoWallpaper } from "../stores/settingsStore";
import { useWeatherNow } from "./weatherNow";
import { skyAt } from "./weatherWindowDraw";
import "./Wallpaper.css";

/**
 * 방·거실 벽지(설정 › 고양이, 사용자가 고른다)와 창밖 빛 연동. 무늬는 옅은 면·선만(모던): 무지·세로 판넬·투톤·아치.
 * 벽색은 창밖 하늘과 같은 계산(skyAt)으로 낮엔 그대로, 해 뜨고 질 무렵엔 따뜻하게, 밤엔 어둡고 푸르게 덮는다 — 색만 바뀌고
 * 움직이지 않는다(1분에 한 번). 날씨를 모르면(커튼이 닫힘) 낮 그대로. 색은 테마마다 Wallpaper.css
 */
export const WALLPAPERS: { value: NekoWallpaper; label: string }[] = [
  { value: "plain", label: "무지" },
  { value: "panel", label: "세로 판넬" },
  { value: "twotone", label: "투톤" },
  { value: "arch", label: "아치" },
];

/** 창밖 하늘의 밝기(1분마다). 날씨를 모르면 낮 */
export function useSkyLight() {
  const w = useWeatherNow();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return w ? skyAt(now / 1000, w.sunrise, w.sunset, w.is_day) : { light: 1, glow: 0 };
}

/**
 * 벽(0,0 ~ w×wallH)의 무늬. 방(sidebar)은 고양이 쪽(오른쪽)에, 거실(dock)은 두 창 사이 가운데에 아치를 둔다
 */
export function WallPattern({ place, w, wallH }: { place: "sidebar" | "dock"; w: number; wallH: number }) {
  const kind = useSettingsStore((s) => s.nekoWallpaper);
  const id = useId().replace(/:/g, "");
  if (kind === "panel") {
    return (
      <>
        <defs>
          <pattern id={`wp-panel-${id}`} width={22} height={10} patternUnits="userSpaceOnUse">
            <rect className="neko-wall__line" x={18} y={0} width={1} height={10} />
          </pattern>
        </defs>
        <rect x={0} y={0} width={w} height={wallH} fill={`url(#wp-panel-${id})`} />
      </>
    );
  }
  if (kind === "twotone") {
    const y = Math.round(wallH * 0.64);
    return (
      <>
        <rect className="neko-wall__lower" x={0} y={y} width={w} height={wallH - y} />
        <rect className="neko-wall__molding" x={0} y={y - 2} width={w} height={2} />
      </>
    );
  }
  if (kind === "arch") {
    const cx = place === "sidebar" ? w * 0.62 : w * 0.5;
    const aw = place === "sidebar" ? w * 0.42 : Math.min(w * 0.2, wallH * 0.8), top = wallH * 0.12;
    const d = `M${cx - aw / 2} ${wallH} V${top + aw / 2} A${aw / 2} ${aw / 2} 0 0 1 ${cx + aw / 2} ${top + aw / 2} V${wallH} Z`;
    return <path className="neko-wall__arch" d={d} />;
  }
  return null;
}

/** 창밖 빛: 벽(과 바닥) 위에 덮는 노을·밤 색. w×h 전체 */
export function SkyTint({ w, h }: { w: number; h: number }) {
  const { light, glow } = useSkyLight();
  return (
    <>
      {glow > 0 && <rect className="neko-wall__dusk" x={0} y={0} width={w} height={h} opacity={0.16 * glow} />}
      {light < 1 && <rect className="neko-wall__night" x={0} y={0} width={w} height={h} opacity={0.34 * (1 - light)} />}
    </>
  );
}

/** 거실 벽(채팅 바 아래 띠·폰 가로 화면): 띠 전체가 벽이다. 날씨 창문과 고양이 무대 아래 */
export function DockWall() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { w, h } = size;
  return (
    <div ref={ref} className="neko-dock-wall" aria-hidden="true">
      {w > 0 && h > 0 && (
        <svg width={w} height={h}>
          <rect className="neko-room__wall" x={0} y={0} width={w} height={h} />
          <WallPattern place="dock" w={w} wallH={h} />
          <SkyTint w={w} h={h} />
        </svg>
      )}
    </div>
  );
}
