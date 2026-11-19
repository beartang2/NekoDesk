import { useEffect, useRef, useState } from "react";
import { roomWindows } from "./engine/room-window";
import { useWeatherNow } from "./weatherNow";
import { WINDOW_PAD, WINDOW_SILL, drawWindow, skyAt, weatherKind, type WeatherKind, type WindowState } from "./weatherWindowDraw";

/** 날씨 움직임 프레임 간격(약 15fps) */
const FRAME_MS = 66;
/** 커튼이 다 열리는(닫히는) 시간, 날씨가 바뀔 때 겹쳐 바뀌는 시간 */
const CURTAIN_S = 1.4;
const FADE_S = 2;

const reduceMq = typeof window !== "undefined" ? window.matchMedia?.("(prefers-reduced-motion: reduce)") : undefined;

/**
 * 방·거실 벽의 날씨 창문(자리는 engine/room-window — 엔진도 같은 자리를 읽는다). 네코 자리를 채우는 상자 안에 두면
 * 스스로 크기를 재서 창을 놓는다.
 *
 * - 창밖: 맑음·구름·비·눈·천둥·안개, 하늘색은 해 뜨고 지는 때를 따른다. 날씨가 바뀌면 겹쳐 바뀐다.
 * - 커튼: 날씨가 없으면(위치 없음·권한 없음·못 받음) 닫혀 있고, 날씨가 오면 한 번 열린 뒤 창밖이 움직인다.
 * - CPU: 약 15fps. 창이 비활성이거나 안 보이면(html[data-idle], main.tsx) 멈추고, 동작 줄이기면 멈춘 그림.
 *   멈춰 있을 땐 1분마다 한 번 다시 그려 하늘색만 따라간다.
 */
export function WeatherWindow({ place }: { place: "sidebar" | "dock" }) {
  const boxRef = useRef<HTMLDivElement>(null);
  // 창마다 캔버스 하나(거실은 둘 — 멀리 떨어져 있어 하나로 덮으면 빈 벽까지 다시 그린다)
  const cvRefs = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];
  const [size, setSize] = useState({ w: 0, h: 0 });
  const weather = useWeatherNow();
  const rects = roomWindows(place, size.w, size.h);
  const rect = rects[0];

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 그리기 상태는 ref 로(매 프레임 React 를 거치지 않는다)
  const live = useRef({ kind: "clear" as WeatherKind, prev: null as WeatherKind | null, fadeAt: 0, open: 0, t: 0, weather, rects, wake: () => {} });
  live.current.weather = weather;
  live.current.rects = rects;

  // 날씨가 바뀌면 겹쳐 바꾼다(처음 받은 날씨는 그냥 — 커튼이 열리며 보인다)
  const kind = weather ? weatherKind(weather.code) : null;
  useEffect(() => {
    const L = live.current;
    if (kind && kind !== L.kind) {
      if (L.open > 0) { L.prev = L.kind; L.fadeAt = performance.now(); }
      L.kind = kind;
    }
    L.wake();
  }, [kind, weather, rect?.x, rect?.w, rect?.h]);

  useEffect(() => {
    const cvs = cvRefs.map((r) => r.current).filter((c): c is HTMLCanvasElement => !!c);
    if (!cvs.length) return;
    const L = live.current, root = document.documentElement;
    let timer = 0, last = performance.now();
    const running = () => !root.hasAttribute("data-idle") && !reduceMq?.matches;

    const draw = () => {
      const rs = L.rects, w = L.weather;
      if (!rs.length) return;
      const now = performance.now(), dt = Math.min(0.5, (now - last) / 1000), run = running();
      last = now;
      const target = w ? 1 : 0;
      // 멈춰 있으면 커튼·겹침은 바로 끝으로, 날씨 시계는 그대로
      if (!run) { L.open = target; L.prev = null; }
      else if (L.open !== target) L.open = target ? Math.min(1, L.open + dt / CURTAIN_S) : Math.max(0, L.open - dt / CURTAIN_S);
      else if (L.open === 1) L.t += dt; // 다 열린 뒤에만 창밖이 움직인다
      const fade = L.prev ? Math.min(1, (now - L.fadeAt) / 1000 / FADE_S) : 1;
      if (fade >= 1) L.prev = null;

      const d = Math.min(window.devicePixelRatio || 1, 2);
      const sky = skyAt(Date.now() / 1000, w?.sunrise ?? null, w?.sunset ?? null, w?.is_day ?? true);
      const st: WindowState = { kind: L.kind, prev: L.prev, fade, ...sky, t: L.t, open: L.open, dark: !root.classList.contains("light"), wide: place === "dock" };
      // 창이 여럿이면 한 풍경을 나눠 본다(같은 구름이 두 번 보이지 않게). 사이 벽은 건너뛰고 창끼리 붙인 풍경 —
      // 벽 뒤로 해가 숨지 않게
      const span = rs.reduce((a, r) => a + r.w, 0);
      rs.forEach((r, i) => {
        const cv = cvs[i], g = cv?.getContext("2d");
        if (!cv || !g) return;
        const W = r.w + 2 * WINDOW_PAD, H = r.h + 2 * WINDOW_PAD + WINDOW_SILL;
        if (cv.width !== Math.round(W * d) || cv.height !== Math.round(H * d)) { cv.width = Math.round(W * d); cv.height = Math.round(H * d); }
        g.setTransform(d, 0, 0, d, 0, 0);
        g.clearRect(0, 0, W, H);
        drawWindow(g, r.w, r.h, st, rs.length > 1 ? { x: rs.slice(0, i).reduce((a, q) => a + q.w, 0), w: span } : undefined);
      });
    };
    const loop = () => {
      timer = 0;
      draw();
      // 커튼이 움직이는 중이거나 창밖이 움직이면 다음 프레임. 멈췄으면 1분 뒤(하늘색)
      const moving = running() && L.rects.length > 0 && (L.open !== (L.weather ? 1 : 0) || L.prev || L.open === 1);
      timer = window.setTimeout(loop, moving ? FRAME_MS : 60_000);
    };
    const wake = () => { if (timer) clearTimeout(timer); last = performance.now(); loop(); };
    L.wake = wake;
    loop();
    // 창이 비활성 → 활성, 테마 바뀜, 동작 줄이기 바뀜: 다시 그리고 흐름을 다시 정한다
    const mo = new MutationObserver(wake);
    mo.observe(root, { attributes: true, attributeFilter: ["data-idle", "class"] });
    reduceMq?.addEventListener?.("change", wake);
    return () => {
      if (timer) clearTimeout(timer);
      L.wake = () => {};
      mo.disconnect();
      reduceMq?.removeEventListener?.("change", wake);
    };
  }, [place]);

  return (
    <div ref={boxRef} className="weather-window" aria-hidden="true">
      {/* 캔버스는 늘 둘 다 둔다(그리기 흐름이 처음 한 번만 붙는다). 그 자리에 창이 없으면 숨긴다 */}
      {cvRefs.map((ref, i) => {
        const r = rects[i];
        return (
          <canvas
            key={i}
            ref={ref}
            className="weather-window__cv"
            style={r
              ? { left: r.x - WINDOW_PAD, top: r.y - WINDOW_PAD, width: r.w + 2 * WINDOW_PAD, height: r.h + 2 * WINDOW_PAD + WINDOW_SILL }
              : { display: "none" }}
          />
        );
      })}
      {rect && weather && (
        <span className="weather-window__temp" style={{ left: rect.x + rect.w / 2, top: rect.y + rect.h + WINDOW_SILL + 1 }}>
          {`${Math.round(weather.temp)}°`}
        </span>
      )}
    </div>
  );
}
