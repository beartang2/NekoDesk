import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { drawShape, onShapeImage } from "./engine/gift-shape";
import { decorDims, decorK } from "./engine/decor-draw";
import { decorItems, useNekoGifts } from "./gifts";
import { useSettingsStore } from "../stores/settingsStore";
import { setTimeZone } from "../lib/time";
import "./NekoRoom.css";

/**
 * 네코 방(사이드바 자리)의 겉모습: 벽·바닥·러그와 벽에 건 날씨 액자(RoomBackdrop), 네코가 다른 자리에 가 있을 때
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

export interface WeatherNow {
  place: string;
  label: string;
  emoji: string;
  temp: number;
  /** IANA 시간대("Asia/Seoul"). 앱의 시각 표시가 이걸 따른다(lib/time). */
  timezone: string;
}

const WEATHER_STALE_MS = 30 * 60 * 1000;

/** 지금 날씨. 30분 지나면 다시 본다. 못 가져오면 null. */
function useWeatherNow(): WeatherNow | null {
  const location = useSettingsStore((s) => s.weatherLocation.trim());
  const [now, setNow] = useState<WeatherNow | null>(null);
  useEffect(() => {
    setNow(null);
    if (!location) { setTimeZone(undefined); return; }
    let alive = true;
    let fetchedAt = 0;
    const load = () => {
      fetchedAt = Date.now();
      invoke<WeatherNow>("weather_now", { location })
        .then((w) => { if (alive) { setNow(w); setTimeZone(w.timezone); } })
        .catch(() => {});
    };
    load();
    // 30분짜리 타이머는 잠자는 동안 멈춰서, 밤새 자고 깨도 30분을 더 기다린다.
    // 1분마다 벽시계로 오래됐는지만 본다 — 깨고 1분 안에 새로 받는다.
    const t = setInterval(() => { if (Date.now() - fetchedAt > WEATHER_STALE_MS) load(); }, 60 * 1000);
    return () => { alive = false; clearInterval(t); };
  }, [location]);
  return now;
}

/** 방 배경. 방(.cat-room = 사이드바 네코 자리 높이)을 채우고, 햇빛(.cat-panel__sun)이 그 위에 든다. */
export function RoomBackdrop() {
  const weather = useWeatherNow();
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
          {weather && <WeatherFrame w={weather} />}
        </svg>
      )}
    </div>
  );
}

/** 벽에 건 날씨 액자(왼쪽 위). 나무 테 안에 날씨 그림과 기온 */
function WeatherFrame({ w }: { w: WeatherNow }) {
  const X = 10, Y = 12, FW = 54, FH = 30;
  return (
    <g className="neko-room__frame">
      <rect className="neko-room__frame-shadow" x={X + 1.5} y={Y + 2} width={FW} height={FH} rx={4} />
      <rect className="neko-room__frame-wood" x={X} y={Y} width={FW} height={FH} rx={4} />
      <rect className="neko-room__frame-mat" x={X + 3.5} y={Y + 3.5} width={FW - 7} height={FH - 7} rx={2} />
      <circle className="neko-room__nail" cx={X + FW / 2} cy={Y - 3} r={1.6} />
      <text className="neko-room__frame-emoji" x={X + 17} y={Y + FH / 2 + 0.5}>{w.emoji}</text>
      <text className="neko-room__frame-temp" x={X + 38} y={Y + FH / 2 + 0.5}>{`${Math.round(w.temp)}°`}</text>
    </g>
  );
}

/**
 * 네코가 다른 자리(거실·마당)에 가 있을 때 방에 놓인 선물. 엔진의 decorAt·drawDecorItem 과 같은 자리·크기로
 * 정지 그림만 그린다(뿅·흔들림 없이). 엔진의 자리 계산이 바뀌면 여기도 맞춘다.
 */
export function RoomGifts({ isDark }: { isDark: boolean }) {
  const gifts = useNekoGifts((s) => s.gifts);
  const [ref, { w, h }] = useSize<HTMLCanvasElement>();
  // 낙서 그림(shape.img)을 다 읽으면 다시 그린다(처음엔 매트만 보인다)
  const [loaded, setLoaded] = useState(0);
  useEffect(() => onShapeImage(() => setLoaded((n) => n + 1)), []);
  useEffect(() => {
    const cv = ref.current;
    const g = cv?.getContext("2d");
    if (!cv || !g || !w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const { floorY, S } = stageMetrics(w, h), m = 16 * S;
    for (const d of decorItems(gifts, "sidebar")) {
      // 크기 × 사용자 배율, 방 상한까지 — 엔진·선물 창과 같은 식(decor-draw)
      const { bd, u, w: iw, h: ih } = decorDims(d.shape, decorK(d.shape, d.size, d.scale, "sidebar", { floorY, S }).k, S);
      const x = m + d.u * Math.max(0, w - 2 * m);
      const wall = d.surface === "wall";
      const bottom = wall ? floorY - (d.v ?? 0.5) * Math.max(1, floorY - ih - 10 * S) : floorY;
      if (!wall) {
        g.save(); g.globalAlpha = 0.5; g.fillStyle = isDark ? "rgba(0, 0, 0, 0.32)" : "rgba(20, 14, 24, 0.18)";
        g.beginPath(); g.ellipse(x, floorY + S, iw * 0.5, 2.6 * S, 0, 0, Math.PI * 2); g.fill(); g.restore();
      }
      drawShape(g, d.shape, x - ((bd.x0 + bd.x1) / 2) * u, bottom, u, 4 * dpr);
      if (wall) { // 압정
        g.fillStyle = "#8f8a86"; g.beginPath(); g.arc(x, bottom - ih + 1.5 * S, 1.8 * S, 0, Math.PI * 2); g.fill();
        g.fillStyle = "rgba(255,255,255,0.6)"; g.beginPath(); g.arc(x - 0.5 * S, bottom - ih + S, 0.7 * S, 0, Math.PI * 2); g.fill();
      }
    }
  }, [gifts, w, h, isDark, ref, loaded]);
  return <canvas ref={ref} className="neko-room__gifts" aria-hidden="true" />;
}
