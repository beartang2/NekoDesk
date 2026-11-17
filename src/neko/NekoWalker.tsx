import { useEffect, useState } from "react";
import { createNeko, type NekoAppearance } from "./engine/neko-engine";
import { useNekoStore } from "./nekoStore";
import { NekoPortrait } from "./NekoPortrait";

/**
 * 산책 지도 위 네코. 걷는 동안은 걸음 프레임을 돌리고, 들른 곳에 머물거나 집에 오면 정지 그림(NekoPortrait).
 *
 * 걸음 프레임은 화면 밖 엔진에 walkTo 를 시켜 한 걸음 동안 8장을 찍은 것 — 외형별로 한 번 찍어 localStorage 에
 * 둔다. 네코는 앱에 하나라(nekoHost) 지도에 엔진을 계속 띄우지 않는다. '동작 줄이기'면 걸을 때도 정지 그림.
 */

const CACHE_PREFIX = "neko_walk:";
const FRAMES = 8;
/** 찍는 간격 = 지도에서 돌리는 간격 */
const FRAME_MS = 90;
const STAGE = { w: 640, h: 200 };

const memo = new Map<string, Promise<string[]>>();

export function nekoWalkFrames(a: NekoAppearance): Promise<string[]> {
  const key = CACHE_PREFIX + JSON.stringify(a);
  const hit = memo.get(key);
  if (hit) return hit;
  let stored: string[] | null = null;
  try { stored = JSON.parse(localStorage.getItem(key) ?? "null"); } catch { /* 저장소를 못 쓰면 매번 찍는다 */ }
  const job = stored?.length ? Promise.resolve(stored) : shoot(a).then((frames) => {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX) && k !== key) localStorage.removeItem(k);
      localStorage.setItem(key, JSON.stringify(frames));
    } catch { /* 가득 찼으면 메모리에만 */ }
    return frames;
  });
  memo.set(key, job);
  job.catch(() => memo.delete(key));
  return job;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shoot(a: NekoAppearance): Promise<string[]> {
  const cv = document.createElement("canvas");
  Object.assign(cv.style, { position: "fixed", left: "-10000px", top: "0", width: `${STAGE.w}px`, height: `${STAGE.h}px`, pointerEvents: "none" });
  document.body.appendChild(cv);
  const neko = createNeko(cv, { transparent: true, scaleMode: "height", wander: false, maxDpr: 2, appearance: a });
  try {
    await wait(200);
    neko.walkTo(STAGE.w - 40); // 오른쪽으로 길게 — 찍는 동안 다 가지 않게
    await wait(350); // 걸음이 붙을 때까지
    const shots: { data: ImageData; box: [number, number, number, number] }[] = [];
    const g = cv.getContext("2d", { willReadFrequently: true })!;
    for (let i = 0; i < FRAMES; i++) {
      const data = g.getImageData(0, 0, cv.width, cv.height);
      const box = opaqueBox(data);
      if (!box) throw new Error("빈 그림"); // 창이 가려져 엔진이 안 그렸다 — 다음에 다시
      shots.push({ data, box });
      await wait(FRAME_MS);
    }
    // 앞(머리) 끝에 맞춰 자른다 — 몸통 가운데에 맞추면 꼬리가 흔들릴 때마다 머리가 들썩인다.
    const w = Math.max(...shots.map((s) => s.box[2] - s.box[0])) + 4;
    const top = Math.min(...shots.map((s) => s.box[1]));
    const bottom = Math.max(...shots.map((s) => s.box[3]));
    const side = Math.max(w, bottom - top + 4);
    return shots.map(({ data, box }) => {
      const src = document.createElement("canvas");
      src.width = data.width;
      src.height = data.height;
      src.getContext("2d")!.putImageData(data, 0, 0);
      const out = document.createElement("canvas");
      out.width = out.height = side;
      out.getContext("2d")!.drawImage(src, box[2] + 2 - side, top - (side - (bottom - top)) / 2, side, side, 0, 0, side, side);
      return out.toDataURL("image/png");
    });
  } finally {
    neko.destroy();
    cv.remove();
  }
}

/** 불투명한 몸(그림자 포함)의 [x0, y0, x1, y1]. 아무것도 없으면 null. */
function opaqueBox({ data, width: w, height: h }: ImageData): [number, number, number, number] | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] > 160) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** walking 이면 걸음 프레임을 돌린다. facingLeft 면 좌우를 뒤집는다(그림은 오른쪽을 본다). */
export function NekoWalker({ size, walking, facingLeft }: { size: number; walking: boolean; facingLeft: boolean }) {
  const appearance = useNekoStore((s) => s.appearance);
  const [frames, setFrames] = useState<string[] | null>(null);
  const [i, setI] = useState(0);
  const animate = walking && !reducedMotion();

  useEffect(() => {
    if (!animate) return;
    let alive = true;
    nekoWalkFrames(appearance).then((f) => { if (alive) setFrames(f); }).catch(() => {});
    return () => { alive = false; };
  }, [appearance, animate]);

  useEffect(() => {
    if (!animate || !frames) return;
    const id = setInterval(() => setI((n) => (n + 1) % frames.length), FRAME_MS);
    return () => clearInterval(id);
  }, [animate, frames]);

  const flip = facingLeft ? { transform: "scaleX(-1)" } : undefined;
  if (!animate || !frames) return <span style={{ display: "inline-block", lineHeight: 0, ...flip }}><NekoPortrait size={size} /></span>;
  return <img src={frames[i % frames.length]} width={size} height={size} style={flip} alt="" aria-hidden="true" draggable={false} />;
}
