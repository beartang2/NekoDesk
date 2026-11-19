import { useEffect, useRef, useState } from "react";
import { roomWindow } from "./engine/room-window";
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
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const weather = useWeatherNow();
  const rect = roomWindow(place, size.w, size.h);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 그리기 상태는 ref 로(매 프레임 React 를 거치지 않는다)
  const live = useRef({ kind: "clear" as WeatherKind, prev: null as WeatherKind | null, fadeAt: 0, open: 0, t: 0, weather, rect, wake: () => {} });
  live.current.weather = weather;
  live.current.rect = rect;

  // 날씨가 바뀌면 겹쳐 바꾼다(처음 받은 날씨는 그냥 — 커튼이 열리며 보인다)
  const kind = weather ? weatherKind(weather.code) : null;
  useEffect(() => {
    const L = live.current;
    if (kind && kind !== L.kind) {
      if (L.open > 0) { L.prev = L.kind; L.fadeAt = performance.now(); }
      L.kind = kind;
    }
    L.wake();
  }, [kind, weather, rect?.w, rect?.h]);

  useEffect(() => {
    const cv = cvRef.current, g = cv?.getContext("2d");
    if (!cv || !g) return;
    const L = live.current, root = document.documentElement;
    let timer = 0, last = performance.now(), dpr = 0, cw = 0, ch = 0;
    const running = () => !root.hasAttribute("data-idle") && !reduceMq?.matches;

    const draw = () => {
      const r = L.rect, w = L.weather;
      if (!r) return;
      const now = performance.now(), dt = Math.min(0.5, (now - last) / 1000), run = running();
      last = now;
      const target = w ? 1 : 0;
      // 멈춰 있으면 커튼·겹침은 바로 끝으로, 날씨 시계는 그대로
      if (!run) { L.open = target; L.prev = null; }
      else if (L.open !== target) L.open = target ? Math.min(1, L.open + dt / CURTAIN_S) : Math.max(0, L.open - dt / CURTAIN_S);
      else if (L.open === 1) L.t += dt; // 다 열린 뒤에만 창밖이 움직인다
      const fade = L.prev ? Math.min(1, (now - L.fadeAt) / 1000 / FADE_S) : 1;
      if (fade >= 1) L.prev = null;

      const d = Math.min(window.devicePixelRatio || 1, 2), W = r.w + 2 * WINDOW_PAD, H = r.h + 2 * WINDOW_PAD + WINDOW_SILL;
      if (d !== dpr || W !== cw || H !== ch) {
        dpr = d; cw = W; ch = H;
        cv.width = Math.round(W * d); cv.height = Math.round(H * d);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const sky = skyAt(Date.now() / 1000, w?.sunrise ?? null, w?.sunset ?? null, w?.is_day ?? true);
      const st: WindowState = { kind: L.kind, prev: L.prev, fade, ...sky, t: L.t, open: L.open, dark: !root.classList.contains("light"), wide: place === "dock" };
      drawWindow(g, r.w, r.h, st);
    };
    const loop = () => {
      timer = 0;
      draw();
      // 커튼이 움직이는 중이거나 창밖이 움직이면 다음 프레임. 멈췄으면 1분 뒤(하늘색)
      const moving = running() && L.rect && (L.open !== (L.weather ? 1 : 0) || L.prev || L.open === 1);
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
      {/* 캔버스는 늘 둔다(그리기 흐름이 처음 한 번만 붙는다). 자리를 모르면 숨긴다 */}
      <canvas
        ref={cvRef}
        className="weather-window__cv"
        style={rect
          ? { left: rect.x - WINDOW_PAD, top: rect.y - WINDOW_PAD, width: rect.w + 2 * WINDOW_PAD, height: rect.h + 2 * WINDOW_PAD + WINDOW_SILL }
          : { display: "none" }}
      />
      {rect && weather && (
        <span className="weather-window__temp" style={{ left: rect.x + rect.w / 2, top: rect.y + rect.h + WINDOW_SILL + 1 }}>
          {`${Math.round(weather.temp)}°`}
        </span>
      )}
    </div>
  );
}
