import { useEffect, useRef, useState } from "react";
import { createNeko, type NekoAppearance } from "./engine/neko-engine";
import { useNekoStore } from "./nekoStore";

/**
 * 사이드바 밖에서 네코를 보여 주는 두 가지.
 *
 * - NekoPortrait: 엔진으로 서 있는 옆모습을 한 번 그려 정지 그림(PNG)으로 쓴다. 빈 대화·빠른 질문·산책 지도처럼
 *   작은 자리. 네코는 앱에 하나라(nekoHost) 여기에 엔진을 하나 더 띄워 두지 않는다.
 * - NekoBootCat: 부팅 화면에서 잠깐 깨어나 기지개를 켜는 엔진. 화면이 걷히면 없앤다.
 *
 * 외형이 같으면 같은 그림이라, 외형별로 한 번만 그리고 localStorage 에 둔다 — 빠른 질문 창(따로 뜬 창)도
 * 같은 저장소를 읽어서 다시 그릴 일이 없다.
 */

const CACHE_PREFIX = "neko_portrait:";
/** 그릴 때 무대 크기(css px). 이 높이로 고양이 크기가 정해진다(scaleMode "height"). */
const STAGE = { w: 240, h: 200 };
/** 첫 프레임들이 그려질 시간. 자세는 바꾸지 않는다 — 앉는 동작 중간이 찍히면 어정쩡하다. */
const SETTLE_MS = 300;

const memo = new Map<string, Promise<string>>();

function keyOf(a: NekoAppearance): string {
  return CACHE_PREFIX + JSON.stringify(a);
}

/** 엔진으로 서 있는 네코를 그려, 몸과 발밑 그림자만 남게 잘라 PNG data URL 로 돌려준다. */
export function nekoSnapshot(a: NekoAppearance): Promise<string> {
  const key = keyOf(a);
  const hit = memo.get(key);
  if (hit) return hit;
  let stored: string | null = null;
  try { stored = localStorage.getItem(key); } catch { /* 저장소를 못 쓰면 매번 그린다 */ }
  const job = stored ? Promise.resolve(stored) : draw(a).then((url) => {
    try {
      // 외형을 바꿀 때마다 쌓이지 않게 옛 그림은 지운다
      for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX) && k !== key) localStorage.removeItem(k);
      localStorage.setItem(key, url);
    } catch { /* 가득 찼으면 메모리에만 */ }
    return url;
  });
  memo.set(key, job);
  job.catch(() => memo.delete(key));
  return job;
}

async function draw(a: NekoAppearance): Promise<string> {
  // 엔진은 캔버스의 화면 크기로 무대를 잡는다 — 화면 밖에 붙여 크기를 준다.
  const cv = document.createElement("canvas");
  Object.assign(cv.style, { position: "fixed", left: "-10000px", top: "0", width: `${STAGE.w}px`, height: `${STAGE.h}px`, pointerEvents: "none" });
  document.body.appendChild(cv);
  const neko = createNeko(cv, { transparent: true, scaleMode: "height", wander: false, maxDpr: 2, appearance: a });
  try {
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    // 창이 가려져 있으면 엔진이 그리지 않는다(document.hidden) — 한 번이라도 그려질 때까지 조금 더 기다린다.
    for (let i = 0; i < 30; i++) {
      neko.pause();
      try { return crop(cv); } catch { neko.resume(); }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("네코를 그리지 못했다");
  } finally {
    neko.destroy();
    cv.remove();
  }
}

/** 투명한 여백을 잘라 낸다(몸과 발밑 그림자만 남는다). */
function crop(cv: HTMLCanvasElement): string {
  const g = cv.getContext("2d")!;
  const { width: w, height: h } = cv;
  const px = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (px[(y * w + x) * 4 + 3] > 160) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) throw new Error("빈 그림");
  // 정사각형으로 — 작은 칸에 넣을 때 가로세로 비가 늘 같게
  const side = Math.max(x1 - x0, y1 - y0) + 4;
  const out = document.createElement("canvas");
  out.width = out.height = side;
  out.getContext("2d")!.drawImage(cv, x0 - (side - (x1 - x0)) / 2, y0 - (side - (y1 - y0)) / 2, side, side, 0, 0, side, side);
  return out.toDataURL("image/png");
}

/** 지금 외형의 네코 그림. 그리는 동안(외형별 처음 한 번, 1초 안)은 빈 자리. */
export function NekoPortrait({ size, className }: { size: number; className?: string }) {
  const appearance = useNekoStore((s) => s.appearance);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    nekoSnapshot(appearance).then((u) => alive && setSrc(u)).catch(() => {});
    return () => { alive = false; };
  }, [appearance]);
  return src
    ? <img className={className} src={src} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
    : <span className={className} style={{ display: "inline-block", width: size, height: size }} aria-hidden="true" />;
}

/**
 * 부팅 화면의 네코: 졸다가 기지개를 켠다. durationMs 가 지나면 onDone 을 한 번 부른다.
 * 엔진을 못 띄우면(예외) 바로 onDone — 부팅이 고양이 때문에 멈추면 안 된다.
 */
export function NekoBootCat({ size, durationMs, onDone }: { size: number; durationMs: number; onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let neko: ReturnType<typeof createNeko> | null = null;
    try {
      neko = createNeko(cv, { transparent: true, scaleMode: "height", wander: false, appearance: useNekoStore.getState().appearance });
      neko.setPose("sit");
      neko.setMood("sleepy");
    } catch {
      done.current();
      return;
    }
    const wake = setTimeout(() => { neko?.setMood("idle"); neko?.act("stretch"); }, 250);
    const end = setTimeout(() => done.current(), durationMs);
    return () => {
      clearTimeout(wake);
      clearTimeout(end);
      neko?.destroy();
    };
  }, [durationMs]);
  return <canvas ref={ref} style={{ width: size * 1.4, height: size }} aria-hidden="true" />;
}
