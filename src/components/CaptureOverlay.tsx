import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { syncWindowTheme } from "../lib/window-theme";
import "./CaptureOverlay.css";

/** 포인트, 이 모니터의 왼쪽 위가 0,0 (Rust 는 전체 화면 기준 좌표를 쓴다). */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Target extends Rect {
  id: number;
  app: string;
}
type Pick = { kind: "window"; id: number } | { kind: "region"; rect: Rect };

/** 이만큼 움직여야 드래그로 본다. 그보다 작으면 클릭(창 고르기). */
const DRAG_MIN = 4;
/**
 * 창에서 빈 곳(창 사이 틈, 바탕화면)으로 나가도 이만큼은 강조를 둔다. 그 안에 다른 창에 닿으면
 * 접히지 않고 바로 넘어간다 — 틈을 지날 때마다 강조가 꺼졌다 켜져 깜빡였다.
 */
const LEAVE_MS = 120;
/** 흐린 원(.cap-spread)이 1.1초에 걸쳐 퍼지는데, 끝으로 갈수록 느려지는 곡선이라 이때쯤이면
 *  이미 화면을 다 덮었다. 여기서 진짜 막으로 바꾼다. */
const SWAP_MS = 820;
/** .cap-spread 의 원 지름(px)과, 그 안에서 덮개 색이 꽉 찬 비율(그 바깥은 흐려진다). */
const SPREAD_SIZE = 200;
const SPREAD_SOLID = 0.62;
/** 강조가 꺼질 때 테두리가 사라지며 창 자리가 덮개로 서서히 어두워지는 시간. CSS 와 같게. */
const FADE_MS = 260;
/** 브라우저 마우스 이벤트가 이 안에 왔으면 Rust 가 보낸 마우스는 버린다(둘이 겹치면 떨린다). */
const DOM_FRESH_MS = 150;
/** 찍기 전 반짝이는 시간. 막은 그 뒤에 걷힌다. */
const FLASH_MS = 140;
/** 막이 화면을 덮는 정도. CSS 의 --cap-dim(검정 36%)과 같아야 밝기 계산이 맞는다. */
const DIM = 0.36;
/**
 * 발바닥·발자국·가장자리 빛이 어두운 쪽으로 바뀌는 밑바탕 밝기(0~1, 막이 덮은 만큼 어둡게 친 값).
 * 0.55 였을 땐 막 아래에서 원래 밝기 0.86 은 넘어야 해 거의 흰 화면에서만 바뀌었고, 적당히
 * 밝은 화면에선 밝은 발바닥이 묻혔다. 0.42 면 막 아래 원래 밝기 0.66 쯤부터 어둡게 간다.
 */
const BRIGHT = 0.42;
/** 커서 옆 발바닥의 자리(커서에서 떨어진 거리)와 크기. CSS 와 같게. */
const PAW_OFFSET = 12;
const PAW_SIZE = 18;

/** 화면 여기저기 떠다니는 옅은 발자국. 자리(0~1)·크기·기울기·시작 시각. */
const DRIFT_PAWS: [x: number, y: number, size: number, rotate: number, delay: number][] = [
  [0.1, 0.2, 40, -18, 0],
  [0.84, 0.16, 34, 14, 1.6],
  [0.22, 0.76, 46, 8, 3.1],
  [0.7, 0.72, 36, -10, 4.4],
  [0.46, 0.3, 32, 22, 2.3],
  [0.9, 0.52, 42, -4, 5.6],
];

/**
 * 밝기 지도. Rust 가 막 아래 화면을 흑백으로 줄여 보낸다(한 칸 1바이트) — 처음 한 번,
 * 그리고 캡처하는 동안 1초마다(capture-lum). 화면이 바뀌어도 따라간다.
 */
export interface Lum {
  w: number;
  h: number;
  data: Uint8Array;
}

/** Rust 가 보내는 모양: data 는 base64. */
interface WireLum {
  w: number;
  h: number;
  data: string;
}

function decodeLum({ w, h, data }: WireLum): Lum {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { w, h, data: bytes };
}

/** fx, fy(0~1) 자리 한 점의 밝기(0~1). 발바닥 정중앙이 걸친 곳의 색으로 정한다 —
 *  둘레를 섞으면 발바닥이 다 넘어가야 바뀌어서 굼떠 보였다. */
export function brightnessAt(lum: Lum, fx: number, fy: number): number {
  const x = Math.round(Math.min(1, Math.max(0, fx)) * (lum.w - 1));
  const y = Math.round(Math.min(1, Math.max(0, fy)) * (lum.h - 1));
  return lum.data[y * lum.w + x] / 255;
}

/**
 * x0~x1, y0~y1(0~1) 네모 칸의 평균 밝기(0~1). 가장자리 빛처럼 넓은 곳의 밑바탕을 볼 때 쓴다.
 * 칸이 수만 개라 다 더하지 않고 STEP 칸마다 하나씩 본다 — 밝기 판단엔 그걸로 충분하다.
 */
export function regionBrightness(lum: Lum, x0: number, y0: number, x1: number, y1: number): number {
  const STEP = 4;
  const ax = Math.round(Math.max(0, Math.min(x0, x1)) * (lum.w - 1));
  const bx = Math.round(Math.min(1, Math.max(x0, x1)) * (lum.w - 1));
  const ay = Math.round(Math.max(0, Math.min(y0, y1)) * (lum.h - 1));
  const by = Math.round(Math.min(1, Math.max(y0, y1)) * (lum.h - 1));
  let sum = 0;
  let n = 0;
  for (let y = ay; y <= by; y += STEP) {
    for (let x = ax; x <= bx; x += STEP) {
      sum += brightnessAt(lum, x / (lum.w - 1 || 1), y / (lum.h - 1 || 1));
      n++;
    }
  }
  return n ? sum / n : 0;
}

type Tone = "light" | "dark";
/**
 * 밝기 기준 둘레의 여유 폭. 지금 색조를 바꾸려면 기준을 이만큼 넘어야 한다 — 기준 언저리
 * 밑바탕에선 밝기 지도가 올 때마다(2초) 밝은 빛·어두운 빛이 번갈아 바뀌어 깜빡였다.
 */
const HYSTERESIS = 0.04;

/** 막이 덮은 밑바탕 밝기로 정한 색조. 어두운 곳엔 밝게, 밝은 곳엔 어둡게 — 커서 발바닥과 같은 기준. */
export function toneOver(raw: number, covered = true, prev?: Tone): Tone {
  const seen = covered ? raw * (1 - DIM) : raw;
  if (prev === "dark") return seen > BRIGHT - HYSTERESIS ? "dark" : "light";
  if (prev === "light") return seen > BRIGHT + HYSTERESIS ? "dark" : "light";
  return seen > BRIGHT ? "dark" : "light";
}

/** 가장자리 빛 띠의 두께(0~1, 화면 대비). 밑바탕을 이만큼 안쪽까지 본다. */
const EDGE_BAND = 0.08;

interface Ambient {
  paws: Tone[];
  edges: Record<"top" | "right" | "bottom" | "left", Tone>;
}

/** 떠다니는 발자국 자리와 네 가장자리의 밑바탕을 보고 색조를 정한다. prev 는 지난 색조(여유 폭용). */
function ambientTones(lum: Lum, width: number, height: number, prev: Ambient | null): Ambient {
  return {
    paws: DRIFT_PAWS.map(([x, y, size], i) =>
      toneOver(brightnessAt(lum, x + size / 2 / width, y + size / 2 / height), true, prev?.paws[i])
    ),
    edges: {
      top: toneOver(regionBrightness(lum, 0, 0, 1, EDGE_BAND), true, prev?.edges.top),
      bottom: toneOver(regionBrightness(lum, 0, 1 - EDGE_BAND, 1, 1), true, prev?.edges.bottom),
      left: toneOver(regionBrightness(lum, 0, 0, EDGE_BAND, 1), true, prev?.edges.left),
      right: toneOver(regionBrightness(lum, 1 - EDGE_BAND, 0, 1, 1), true, prev?.edges.right),
    },
  };
}


/** 전체 화면 기준 창 위치를 이 모니터 기준으로. 앞에 있는 창이 먼저 온다. */
const toLocal = (windows: Target[], screen: Rect): Target[] =>
  windows.map((t) => ({ ...t, x: t.x - screen.x, y: t.y - screen.y }));

const inside = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

function normalize(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}


/**
 * 네코 캡처 막. 모니터마다 하나씩 뜬다(capture.rs).
 * 클릭하면 그 아래 창, 드래그하면 그 영역, esc·오른쪽 클릭이면 그만둔다.
 */
export function CaptureOverlay() {
  const [screen, setScreen] = useState<Rect | null>(null);
  const [windows, setWindows] = useState<Target[]>([]);
  const [hover, setHover] = useState<Target | null>(null);
  const [drag, setDrag] = useState<Rect | null>(null);
  const [flash, setFlash] = useState<Rect | null>(null);
  /**
   * 커서 자리. 상태로 두면 마우스가 움직일 때마다(초당 60~120번) 막 전체를 다시 그려 끊겼다.
   * 발바닥은 이 값으로 위치만 직접 옮기고(transform), 보일지·색은 바뀔 때만 상태로 둔다.
   */
  const cursor = useRef<{ x: number; y: number } | null>(null);
  const paw = useRef<SVGSVGElement>(null);
  const [pawVisible, setPawVisible] = useState(false);
  const [pawTone, setPawTone] = useState<Tone | undefined>(undefined);
  const [session, setSession] = useState(0);
  /**
   * 막 내용이 보이는가. 숨길 때 미리 꺼 두고(투명), 다시 켤 땐 한 프레임 투명하게 그린 뒤 켜서
   * 부드럽게 나타나게 한다. 안 그러면 숨겨 둔 막이 보이는 순간 지난번 마지막 화면이 비쳤다가
   * 다시 0 부터 나타나 깜빡였다.
   */
  const [on, setOn] = useState(false);
  /** 막이 퍼져 나오는 중심. 시작할 때 커서가 이 모니터에 있었으면 거기, 아니면 가운데. */
  const [origin, setOrigin] = useState<[number, number] | null>(null);
  /** 다 퍼졌다. 그 뒤엔 퍼지는 마스크를 떼어 다시 그릴 일을 줄인다. */
  const [revealed, setRevealed] = useState(false);
  const revealTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [ambient, setAmbient] = useState<Ambient | null>(null);
  const lum = useRef<Lum | null>(null);
  /** 이 막의 모니터 위치. 창 목록이 새로 올 때 모니터 기준으로 바꾸는 데 쓴다. */
  const screenRef = useRef<Rect | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const done = useRef(false);
  /** 지금 강조 중인 칸. 밝기 지도가 새로 올 때 발바닥 색을 다시 고르는 데 쓴다. */
  const focusRef = useRef<Rect | null>(null);
  const hoverRef = useRef<Target | null>(null);
  const leaving = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** 강조가 꺼지는 중 — 테두리가 사라지며 창 자리가 서서히 어두워진다(FADE_MS 뒤 접힌다). */
  const [fading, setFading] = useState(false);

  /** 처음 열릴 때와, 숨겨 둔 막을 다시 쓸 때(capture-start)마다. 지난 고르기를 지운다. */
  function reset() {
    setOn(false);
    clearTimeout(revealTimer.current);
    setRevealed(false);
    clearTimeout(leaving.current);
    leaving.current = undefined;
    setFading(false);
    setHover(null);
    setDrag(null);
    setFlash(null);
    hidePaw();
    start.current = null;
  }

  function applyLum(l: Lum) {
    lum.current = l;
    setAmbient((prev) => ambientTones(l, window.innerWidth, window.innerHeight, prev));
    // 커서를 안 움직여도 새 화면 밝기로 발바닥 색을 다시 고른다.
    const c = cursor.current;
    if (c) setPawTone((prev) => toneAt(c.x, c.y, focusRef.current, prev));
  }

  function hidePaw() {
    cursor.current = null;
    setPawVisible(false);
  }

  /** 발바닥 정중앙 밑바탕이 밝으면 어둡게, 어두우면 밝게. 막이 덮은 곳은 덮인 만큼 어둡게 친다 —
   *  뚫린 칸 안만 원래 밝기 그대로 보인다. 화면을 못 읽었으면 기본색. */
  function toneAt(x: number, y: number, focus: Rect | null, prev?: Tone): Tone | undefined {
    if (!lum.current) return undefined;
    const px = x + PAW_OFFSET + PAW_SIZE / 2;
    const py = y + PAW_OFFSET + PAW_SIZE / 2;
    const raw = brightnessAt(lum.current, px / window.innerWidth, py / window.innerHeight);
    return toneOver(focus && inside(focus, px, py) ? raw : raw * (1 - DIM), false, prev);
  }

  /** 다른 창에 닿았다. 꺼지던 중이면 거두고 그 창으로 넘어간다. */
  function keepFocus(target: Target) {
    clearTimeout(leaving.current);
    leaving.current = undefined;
    setFading(false);
    setHover(target);
  }

  /**
   * 강조를 서서히 끈다: (wait 동안 기다렸다가) 테두리가 사라지며 창 자리가 어두워지고,
   * 다 어두워지면 접는다. 그 사이 다른 창에 닿으면 keepFocus 가 거둔다.
   */
  function letGo(wait: number) {
    if (!hoverRef.current || leaving.current) return;
    const fade = () => {
      setFading(true);
      leaving.current = setTimeout(() => {
        leaving.current = undefined;
        setFading(false);
        setHover(null);
      }, FADE_MS);
    };
    if (wait > 0) leaving.current = setTimeout(fade, wait);
    else fade();
  }

  function begin() {
    reset();
    done.current = false;
    lum.current = null;
    setAmbient(null);
    // 숨겨 둔 막을 다시 쓸 때도 등장 효과가 처음부터 돌게 통째로 다시 그린다.
    setSession((n) => n + 1);
    // 투명한 채로 한 번 그려진 뒤에 켜야 페이드가 걸린다(두 프레임 뒤). 다 퍼질 즈음 마스크를 뗀다
    // — 등록한 CSS 변수의 transitionend 는 WebKit 에서 믿기 어려워 시간으로 잰다.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setOn(true);
        clearTimeout(revealTimer.current);
        revealTimer.current = setTimeout(() => setRevealed(true), SWAP_MS);
      })
    );
    syncWindowTheme(false);
    invoke<{ screen: Rect; windows: Target[]; lum: WireLum | null; start: [number, number] | null }>(
      "capture_targets"
    )
      .then(({ screen, windows, lum: wire, start }) => {
        setOrigin(start);
        setScreen(screen);
        screenRef.current = screen;
        setWindows(toLocal(windows, screen));
        if (wire) applyLum(decodeLum(wire));
      })
      // 진행 중인 캡처가 없을 때 열린 것 — 다음 capture-start 를 기다린다.
      .catch(() => {});
  }

  useEffect(() => {
    begin();
    // Rust 는 막마다 emit_to(라벨) 로 보낸다. listen 의 기본 대상은 "모든 창" 이라 그대로
    // 들으면 다른 모니터 막 몫까지 받는다 — 발바닥이 모니터마다 하나씩 생기고, 창 목록이
    // 다른 모니터 것으로 덮여 엉뚱한 창 하나만 잡혔다. 자기 라벨로 온 것만 듣는다.
    const mine = { target: getCurrentWindow().label };
    const unlisten = listen("capture-start", begin, mine);
    // 막 밖에서 끝났을 때(전역 esc·시간 초과)도 숨기기 전에 비운다. Rust 가 잠깐 기다렸다 숨긴다.
    const unlistenEnd = listen("capture-end", reset, mine);
    // 캡처 중에도 창 목록이 바뀌면(데스크톱을 막 옮긴 직후 등) Rust 가 새로 보낸다.
    const unlistenWindows = listen<Target[]>(
      "capture-windows",
      ({ payload }) => {
        if (screenRef.current) setWindows(toLocal(payload, screenRef.current));
      },
      mine
    );
    const unlistenLum = listen<WireLum>("capture-lum", ({ payload }) => applyLum(decodeLum(payload)), mine);
    const unlistenCursor = listen<{ x: number; y: number; down: boolean } | null>(
      "capture-cursor",
      ({ payload }) => fromRust.current(payload),
      mine
    );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      void unlisten.then((f) => f());
      void unlistenEnd.then((f) => f());
      void unlistenWindows.then((f) => f());
      void unlistenCursor.then((f) => f());
      void unlistenLum.then((f) => f());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 막은 숨겨졌다가 다음 캡처 때 그대로 다시 보인다. 그래서 알리기 **전에** 비우고, 빈 화면이
   * 실제로 그려진 뒤(두 프레임)에 알린다 — 알리자마자 숨겨지니 그 뒤에 비우면 덮개가 남은 채로
   * 숨었다가, 빨리 다시 켰을 때 한 프레임 비치고 사라져 깜빡였다.
   */
  function finish(pick: Pick | null, shown?: Rect) {
    if (done.current) return;
    done.current = true;
    const send = () => {
      reset();
      requestAnimationFrame(() => requestAnimationFrame(() => void invoke("capture_pick", { pick })));
    };
    if (!pick || !shown) return send();
    setFlash(shown);
    setTimeout(send, FLASH_MS);
  }

  const hit = (x: number, y: number) => windows.find((t) => inside(t, x, y)) ?? null;

  // 목록이 바뀌면 커서를 안 움직여도 강조를 다시 고른다.
  useEffect(() => {
    if (cursor.current && !start.current) setHover(hit(cursor.current.x, cursor.current.y));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windows]);

  // 마우스는 두 길로 온다: 브라우저 이벤트(이 막이 키 창일 때), 그리고 Rust 가 초당 30번
  // 직접 읽어 보내는 것(capture-cursor — 키 창이 아니어도 온다). 둘 다 아래 셋으로 모인다.
  const lastDom = useRef(0);

  function pressAt(x: number, y: number) {
    start.current = { x, y };
  }

  function moveAt(x: number, y: number) {
    cursor.current = { x, y };
    if (paw.current) paw.current.style.transform = `translate(${x + PAW_OFFSET}px, ${y + PAW_OFFSET}px)`;
    setPawVisible(true);
    const s = start.current;
    let next: Rect | null;
    if (s && (drag || Math.hypot(x - s.x, y - s.y) >= DRAG_MIN)) {
      // 다른 모니터로 넘어가도 이 모니터 안에서 자른다.
      const cx = Math.max(0, Math.min(x, window.innerWidth));
      const cy = Math.max(0, Math.min(y, window.innerHeight));
      next = normalize(s.x, s.y, cx, cy);
      setDrag(next);
    } else {
      // 같은 창 위면 같은 객체라 React 가 다시 그리지 않는다.
      const target = hit(x, y);
      if (target) keepFocus(target);
      else letGo(LEAVE_MS);
      next = target ?? hoverRef.current;
    }
    setPawTone((prev) => toneAt(x, y, next, prev));
  }

  function onMouseDown(e: React.MouseEvent) {
    lastDom.current = performance.now();
    if (e.button === 2) return finish(null);
    if (e.button === 0) pressAt(e.clientX, e.clientY);
  }

  function onMouseMove(e: React.MouseEvent) {
    lastDom.current = performance.now();
    moveAt(e.clientX, e.clientY);
  }

  function onMouseUp(e: React.MouseEvent) {
    lastDom.current = performance.now();
    if (e.button === 0) releaseAt(e.clientX, e.clientY);
  }

  // 리스너는 한 번만 달고, 최신 상태를 보는 처리는 매번 바꿔 끼운다.
  const fromRust = useRef<(c: { x: number; y: number; down: boolean } | null) => void>(() => {});
  fromRust.current = (c) => {
    if (!c) {
      // 커서가 다른 모니터로 갔다. 드래그 중이 아니면 강조와 발바닥을 거둔다. 이건 브라우저
      // 이벤트가 방금 왔어도 따른다 — 넘어가는 순간엔 늘 방금 왔어서, 걸러 버리면 발바닥이
      // 모니터마다 하나씩 남았다(모니터를 넘을 때 mouseleave 가 안 올 때가 있다).
      if (!start.current) {
        letGo(0);
        hidePaw();
      }
      return;
    }
    if (performance.now() - lastDom.current < DOM_FRESH_MS) return;
    if (c.down && !start.current) pressAt(c.x, c.y);
    moveAt(c.x, c.y);
    if (!c.down && start.current) releaseAt(c.x, c.y);
  };

  function releaseAt(x: number, y: number) {
    if (!start.current || !screen) return;
    start.current = null;
    if (drag && drag.w >= DRAG_MIN && drag.h >= DRAG_MIN) {
      const rect = { ...drag, x: drag.x + screen.x, y: drag.y + screen.y };
      return finish({ kind: "region", rect }, drag);
    }
    setDrag(null);
    const target = hit(x, y);
    // 창이 없는 곳(바탕화면)을 누르면 이 모니터 전체.
    if (target) finish({ kind: "window", id: target.id }, target);
    else finish({ kind: "region", rect: screen }, { x: 0, y: 0, w: screen.w, h: screen.h });
  }

  const focus: Rect | null = drag ?? hover;
  focusRef.current = focus;
  hoverRef.current = hover;
  const mode = drag ? "region" : "window";

  // 강조 칸은 늘 떠 있다. 고른 게 없으면 커서 자리의 크기 0 칸으로 접혀 있다가, 창에 올리면
  // 그 자리에서 펼쳐진다 — 칸이 생겼다 사라지며 화면 전체의 어둡기가 깜빡이지 않는다.
  // 다 퍼지기 전엔 강조를 띄우지 않는다 — 퍼진 뒤 커서 아래 창이 서서히 밝아지며 켜진다.
  const shown = revealed ? focus : null;
  const at = cursor.current;
  const hole: Rect = shown ?? { x: at?.x ?? window.innerWidth / 2, y: at?.y ?? window.innerHeight / 2, w: 0, h: 0 };

  // 흐린 원을 얼마나 키워야 가장 먼 모서리까지 덮개 색으로 꽉 차는지.
  const ox = origin?.[0] ?? window.innerWidth / 2;
  const oy = origin?.[1] ?? window.innerHeight / 2;
  const far = Math.max(
    Math.hypot(ox, oy),
    Math.hypot(window.innerWidth - ox, oy),
    Math.hypot(ox, window.innerHeight - oy),
    Math.hypot(window.innerWidth - ox, window.innerHeight - oy)
  );
  const spread = far / (SPREAD_SIZE / 2) / SPREAD_SOLID;
  const place = { "--ox": `${ox}px`, "--oy": `${oy}px`, "--spread": spread } as React.CSSProperties;

  return (
    <>
    {!revealed && <div key={`spread-${session}`} className="cap-spread" data-on={on ? "" : undefined} style={place} />}
    <div
      key={session}
      className="cap"
      data-revealed={revealed ? "" : undefined}

      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { letGo(0); hidePaw(); }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {!flash && (
        <div
          // 빈 곳 → 창으로 들어갈 땐 새로 그려 그 자리에 바로 나타나게(점에서 펼쳐지지 않게).
          // 창 → 창은 같은 칸이 짧게 미끄러져 넘어간다.
          key={shown ? "on" : "off"}
          className="cap__hole"
          data-mode={mode}
          data-fading={fading && !drag ? "" : undefined}
          data-empty={shown ? undefined : ""}
          // 위치는 transform 으로 — 칸이 옮겨 갈 때 화면 배치를 다시 계산하지 않는다.
          style={{ transform: `translate(${hole.x}px, ${hole.y}px)`, width: hole.w, height: hole.h }}
        >
          {drag && (
            <svg className="cap__ants" aria-hidden>
              <rect width="100%" height="100%" rx="4" />
            </svg>
          )}
          {shown && focus && (
            <span className={`cap__tag ${focus.y < 34 ? "cap__tag--inside" : ""}`}>
              {drag ? `${Math.round(drag.w)} × ${Math.round(drag.h)}` : `🐾 ${hover?.app || "창"}`}
            </span>
          )}
        </div>
      )}

      {!flash && (
        <div className="cap__ambient" aria-hidden>
          {/* 가장자리 빛은 네 띠로 나눠, 띠마다 맞닿은 밑바탕에 맞춰 밝거나 어둡게. */}
          <div className="cap__glow">
            {(["top", "right", "bottom", "left"] as const).map((side) => (
              <div key={side} className={`cap__edge cap__edge--${side}`} data-tone={ambient?.edges[side]} />
            ))}
          </div>
          {DRIFT_PAWS.map(([x, y, size, rotate, delay], i) => (
            <svg
              key={i}
              className="cap__drift"
              data-tone={ambient?.paws[i]}
              viewBox="0 0 24 24"
              style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: size, height: size, rotate: `${rotate}deg`, animationDelay: `${delay}s` }}
            >
              <use href="#cap-paw" />
            </svg>
          ))}
        </div>
      )}

      {flash && (
        <div className="cap__flash" style={{ left: flash.x, top: flash.y, width: flash.w, height: flash.h }} />
      )}

      {!flash && (
        <svg
          ref={paw}
          className="cap__paw"
          data-tone={pawTone}
          style={{
            visibility: pawVisible ? "visible" : "hidden",
            transform: at ? `translate(${at.x + PAW_OFFSET}px, ${at.y + PAW_OFFSET}px)` : undefined,
          }}
          viewBox="0 0 24 24"
          aria-hidden
        >
          <use href="#cap-paw" />
        </svg>
      )}

      {/* 발바닥 모양 하나를 커서와 떠다니는 발자국이 같이 쓴다. */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <defs>
          <g id="cap-paw">
            <ellipse cx="12" cy="16" rx="5.2" ry="4.4" />
            <ellipse cx="5.6" cy="10.2" rx="2.1" ry="2.6" />
            <ellipse cx="9.6" cy="6.4" rx="2.1" ry="2.7" />
            <ellipse cx="14.4" cy="6.4" rx="2.1" ry="2.7" />
            <ellipse cx="18.4" cy="10.2" rx="2.1" ry="2.6" />
          </g>
        </defs>
      </svg>

      {!flash && (
        <div className="cap__hint">
          <b>클릭</b> 창 · <b>드래그</b> 영역 · <b>esc</b> 취소
        </div>
      )}
    </div>
    </>
  );
}
