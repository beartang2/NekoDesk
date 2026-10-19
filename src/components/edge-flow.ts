/**
 * 캡처 막의 가장자리 빛이 테두리에서 떨어져 나와 한 점으로 모이고(out), 한 점에서 흩어져 테두리에
 * 다시 붙는다(in). 커서가 다른 모니터로 나가면 나간 자리로 모여 빠지고, 들어오면 커서에서 퍼진다.
 * 데스크톱을 넘기면 다 넘긴 뒤 커서에서 퍼진다.
 *
 * 가만있을 땐 네 변의 빛 띠(band)가 이어져 있다. 움직일 땐 띠를 서서히 끄고 그 자리에 연기 덩이(blob)들을
 * 띄워 날린다. 덩이는 변을 따라 촘촘히 겹쳐 놓았고, 혹 몇 개가 엉긴 찌그러진 구름 모양이다. 테두리에서
 * 화면 안쪽으로 피어오르며 부풀었다가 그 점으로 빨려 들고, 퍼질 땐 그 점에서 뭉게뭉게 피어났다가 제자리로
 * 내려앉는다. 빠르기·출발 때는 테두리를 따라 물결처럼 달라지되 덩이마다 조금씩 들쭉날쭉하다 — 고리 모양
 * 그대로 찌그러지며 모이지 않게(그러면 선으로 된 네모처럼 보였다). 색은 포인트 색에서 채도·색상이
 * 테두리를 따라 부드럽게 바뀌어 오로라처럼 섞이고, 내려앉은 뒤 띠도 그 색으로 빛난다. 덩이마다 같은
 * 길을 조금씩 늦게 따라오는 잔상(TRAIL)이 붙는다. 움직임은 transform·opacity 뿐이라 화면을 다시 그리지
 * 않는다.
 */

export type Side = "top" | "right" | "bottom" | "left";
export type Point = [x: number, y: number];

/** 빛 덩이 하나: 붙어 있을 자리(가운데)와 크기, 테두리를 시계 방향으로 한 바퀴 돈 중 어디쯤인지(0~1). */
export interface Blob {
  side: Side;
  x: number;
  y: number;
  w: number;
  h: number;
  around: number;
}

export const SIDES: Side[] = ["top", "right", "bottom", "left"];
const horizontal = (side: Side) => side === "top" || side === "bottom";

/** 덩이 사이 간격 언저리(px). 덩이 길이는 그 OVERLAP 배라 이웃끼리 겹쳐 이어진다. */
const GAP = 140;
const OVERLAP = 3.2;
/** 덩이 가운데가 변에서 들어온 거리, 덩이의 두께(변과 수직 방향). 띠가 가장 짙은 쪽에 놓이고, 띠보다
 *  넓게 퍼져 날아갈 때 빛이 가늘지 않고 넉넉하다. */
const INSET = 70;
const THICK = 300;
/** 덩이가 가장 밝을 때. 촘촘히 겹쳐 있고 날면서 부풀어 하나하나는 옅어야 합쳐서 띠만큼 밝다. */
const PEAK = 0.24;
/** 덩이 하나에 붙는 그림 수: 맨 앞 하나와 그 뒤를 따라오는 잔상들. 뒤로 갈수록 늦고 옅다. */
export const TRAIL = 3;
const TRAIL_LAG = 96;
const TRAIL_ALPHA = [1, 0.45, 0.2];
/**
 * 다른 모니터로 넘어갈 때, 들어간 모니터는 커서가 머무는지 이만큼 기다렸다가 퍼뜨린다. 그새 커서가
 * 또 나가면 퍼뜨리지 않는다 — 빨리 오가는 동안엔 빛이 모인 채 어둡게 있다가 커서가 멈춘 모니터에서만
 * 퍼진다. 나온 모니터의 빛이 다 모일 즈음이기도 해 한 줄기가 건너가는 것처럼 보인다.
 */
export const HANDOFF_MS = 500;

/** w×h 화면의 네 변을 따라 빛 덩이를 촘촘히 겹쳐 늘어놓는다. */
export function blobs(w: number, h: number): Blob[] {
  const out: Blob[] = [];
  const round = 2 * (w + h);
  for (const side of SIDES) {
    const len = horizontal(side) ? w : h;
    const n = Math.max(2, Math.round(len / GAP));
    const size = (len / n) * OVERLAP;
    for (let i = 0; i < n; i++) {
      const at = (len * (i + 0.5)) / n;
      if (side === "top") out.push({ side, x: at, y: INSET, w: size, h: THICK, around: at / round });
      else if (side === "right") out.push({ side, x: w - INSET, y: at, w: THICK, h: size, around: (w + at) / round });
      else if (side === "bottom")
        out.push({ side, x: at, y: h - INSET, w: size, h: THICK, around: (2 * w + h - at) / round });
      else out.push({ side, x: INSET, y: at, w: THICK, h: size, around: (2 * w + 2 * h - at) / round });
    }
  }
  return out;
}

/**
 * 테두리를 따라 부드럽게 오르내리는 물결(0~1). 한 바퀴에 두세 번 굽이치고, 부를 때마다 굽이 자리가
 * 달라진다. 이웃 덩이끼리는 값이 비슷하다.
 */
function wave(): (around: number) => number {
  const a = Math.random() * Math.PI * 2;
  const b = Math.random() * Math.PI * 2;
  return (u) => 0.5 + 0.3 * Math.sin(Math.PI * 2 * 2 * u + a) + 0.2 * Math.sin(Math.PI * 2 * 3 * u + b);
}

/**
 * p 에서 d 방향으로 곧장 나아가 w×h 화면 가장자리에 닿는 점. 커서가 빠르게 나가면 마지막으로 본
 * 자리가 가장자리에서 한참 안쪽이라, 움직이던 방향으로 이어 그어 실제로 나간 자리를 찾는다.
 * 방향이 없으면 가장 가까운 가장자리.
 */
export function edgePoint([x, y]: Point, [dx, dy]: Point, w: number, h: number): Point {
  const hits: number[] = [];
  if (dx > 0) hits.push((w - x) / dx);
  if (dx < 0) hits.push(-x / dx);
  if (dy > 0) hits.push((h - y) / dy);
  if (dy < 0) hits.push(-y / dy);
  if (hits.length) {
    const t = Math.max(0, Math.min(...hits));
    return [Math.min(w, Math.max(0, x + dx * t)), Math.min(h, Math.max(0, y + dy * t))];
  }
  const gaps = [x, w - x, y, h - y];
  const i = gaps.indexOf(Math.min(...gaps));
  return i === 0 ? [0, y] : i === 1 ? [w, y] : i === 2 ? [x, 0] : [x, h];
}

/** 이 파일이 건 애니메이션 이름. 띠 색이 바뀌는 CSS transition 은 건드리지 않게 이것만 거둔다. */
const FLOW = "edge-flow";

function stop(el: HTMLElement) {
  for (const a of el.getAnimations()) if (a.id === FLOW) a.cancel();
}

const opacityOf = (el: HTMLElement) => Number(getComputedStyle(el).opacity);

/**
 * 덩이의 모습: [얼마나 갔나(0~1), 가는 방향으로 늘인 배수, 크기, 투명도].
 * 모일 땐 테두리에서 떠오르며 부풀어 퍼졌다가 그 점으로 빨려 들며 작아지고, 퍼질 땐 그 점에서 작고 짙게
 * 나와 크게 피어올랐다가 제 크기로 내려앉는다. 가는 방향으로는 조금만 늘인다 — 많이 늘이면 휜 길을 따라
 * 늘어난 쪽이 돌아 빙글 도는 것처럼 보였다.
 */
const GATHER: [part: number, stretch: number, size: number, alpha: number][] = [
  [0, 1, 1, 0],
  [0.15, 1.05, 1.3, PEAK],
  [0.45, 1.1, 1.8, PEAK * 0.9],
  [0.75, 1.1, 1.3, PEAK * 0.8],
  [1, 1, 0.4, 0],
];
const SPREAD: [part: number, stretch: number, size: number, alpha: number][] = [
  [0, 1, 0.3, 0],
  [0.15, 1.1, 1.2, PEAK],
  [0.45, 1.1, 2, PEAK * 0.85],
  [0.75, 1.05, 1.4, PEAK * 0.7],
  [1, 1, 1, 0],
];

/**
 * 연기 한 덩이의 모양: 가운데 큰 혹 하나에 둘레로 작은 혹 둘셋이 엉겨 찌그러진 구름. 혹마다 자리·크기가
 * 제멋대로라 덩이마다 생김새가 다르고, 날면서 부풀었다 줄며 모양이 계속 바뀌어 보인다.
 */
function puff(): string {
  const r = (min: number, max: number) => (min + Math.random() * (max - min)).toFixed(1);
  const lobe = (spread: number, min: number, max: number) =>
    `radial-gradient(${r(min, max)}% ${r(min, max)}% at ${r(50 - spread, 50 + spread)}% ${r(50 - spread, 50 + spread)}%, var(--edge), transparent)`;
  const lobes = [lobe(8, 38, 50)];
  const extra = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < extra; i++) lobes.push(lobe(26, 18, 32));
  return lobes.join(", ");
}

/** 포인트 색을 채도 chroma 배, 색상 hue 도 돌린 빛 색. 밑바탕 색조 섞기는 CSS(.cap__edge)를 따른다. */
const tinted = (chroma: number, hue: number) =>
  `color-mix(in oklab, color-mix(in oklab, oklch(from var(--accent) l calc(c * ${chroma}) calc(h + ${hue})) var(--base), var(--with)) var(--alpha), transparent)`;

const ACROSS: Record<Side, string> = { top: "to bottom", bottom: "to top", left: "to right", right: "to left" };

/**
 * 띠를 덩이들이 내려앉은 색 그대로 칠한다: 변을 따라 덩이 자리마다 그 덩이 색, 사이는 번져 이어진다.
 * 변에서 안쪽으로 스러지는 건 마스크가 맡는다.
 */
function paintBand(band: HTMLElement, tints: { blob: Blob; chroma: number; hue: number }[]) {
  for (const side of SIDES) {
    const strip = band.querySelector<HTMLElement>(`.cap__edge--${side}`);
    if (!strip) continue;
    const stops = tints
      .filter((t) => t.blob.side === side)
      .map((t) => `${tinted(t.chroma, t.hue)} ${horizontal(side) ? t.blob.x : t.blob.y}px`);
    strip.style.background = `linear-gradient(${horizontal(side) ? "to right" : "to bottom"}, ${stops.join(", ")})`;
    const fade = `linear-gradient(${ACROSS[side]}, #000, transparent)`;
    strip.style.setProperty("-webkit-mask-image", fade);
    strip.style.setProperty("mask-image", fade);
  }
}

/** 띠마다: 마지막으로 시킨 게 모으기인지 퍼뜨리기인지, 그 덩이들이 언제까지 나는지(performance.now). */
const flights = new WeakMap<HTMLElement, { kind: "in" | "out"; until: number }>();

/**
 * 빛을 at 으로 모아 빼거나(out) at 에서 흩어 테두리에 붙인다(in). at 이 없으면(어디서 왔는지 모르면)
 * 띠만 그 자리에서 서서히 켜고 끈다. after 만큼 기다렸다 퍼뜨린다.
 *
 * - 모으는 중에 다시 퍼뜨리라 하면(커서가 금방 돌아오면) 다 모일 때까지 기다렸다 퍼뜨린다. 띠는 그때까지
 *   꺼져 있다 — 날던 빛 가운데 띠가 미리 켜지지 않게.
 * - 퍼뜨리는 중(또는 퍼뜨리려고 기다리는 중)에 모으라 하면 새로 모으지 않는다. 날던 빛은 그 길을 마저
 *   가며 스러지고, 기다리던 건 시작하지 않는다.
 *
 * els 는 덩이마다 TRAIL 개씩(맨 앞, 잔상들) 차례로 들어 있다.
 */
export function flowEdges(
  band: HTMLElement | null,
  swarm: HTMLElement | null,
  els: (HTMLElement | null)[],
  layout: Blob[],
  kind: "in" | "out",
  at: Point | null,
  w: number,
  h: number,
  after = 0
) {
  if (!band || !swarm) return;
  const now = performance.now();
  const last = flights.get(band);
  const gathering = last?.kind === "out" && now < last.until;
  const spreading = last?.kind === "in" && now < last.until;
  // 띠는 지금 밝기에서 이어 간다 — 하던 걸 거둬도 툭 튀지 않게.
  const lit = opacityOf(band);
  stop(band);

  if (kind === "out") {
    band.animate([{ opacity: lit }, { opacity: 0 }], { id: FLOW, duration: 300, fill: "forwards" });
    if (spreading) {
      const shown = opacityOf(swarm);
      stop(swarm);
      swarm.animate([{ opacity: shown }, { opacity: 0 }], { id: FLOW, duration: 300, fill: "forwards" });
      flights.set(band, { kind: "out", until: now });
      return;
    }
    if (!at || gathering) return;
  } else {
    // 모으던 게 아직 날면 다 모일 때까지 기다린다. 그 덩이들은 그대로 날게 둔다.
    const start = gathering ? Math.max(after, (last?.until ?? now) - now) : after;
    after = start;
    band.animate([{ opacity: lit }, { opacity: 1 }], {
      id: FLOW,
      duration: at ? 650 : 700,
      delay: start + (at ? 340 : 0),
      easing: "ease-out",
      fill: "both",
    });
    if (!at) {
      flights.set(band, { kind: "in", until: now + start });
      return;
    }
  }

  stop(swarm);
  // 모으던 덩이는 다 모일 때까지 둔다(새 퍼뜨림은 그 뒤에 시작한다). 그 밖엔 하던 걸 거둔다.
  if (!gathering) els.forEach((el) => el && stop(el));
  const far = Math.hypot(w, h);
  // 테두리를 따라 굽이치는 물결들: 빠르기, 출발 때, 색상, 채도. 이웃 덩이끼리는 비슷하다.
  const pace = wave();
  const lag = wave();
  const hueWave = wave();
  const chromaWave = wave();
  let until = now;
  const tints: { blob: Blob; chroma: number; hue: number }[] = [];
  layout.forEach((blob, i) => {
    const dx = at[0] - blob.x;
    const dy = at[1] - blob.y;
    const dist = Math.hypot(dx, dy) || 1;
    const reach = dist / far;
    const jitter = 0.6 + pace(blob.around) * 0.8 + (Math.random() - 0.5) * 0.15;
    // 길은 3차 베지어: 제자리(0,0) → c1 → c2 → 그 점(dx,dy). 테두리에서 화면 안쪽으로 피어올랐다가 그
    // 점으로 가고, 그 점 언저리에선 제각각 흩어진 자리를 거친다 — 퍼질 땐 거꾸로 그 점에서 사방으로 피어났다가
    // 내려앉는다. 휘는 쪽은 덩이마다 제각각 — 다 같은 쪽으로 휘면 빙글 도는 것처럼 보였다.
    const ix = w / 2 - blob.x;
    const iy = h / 2 - blob.y;
    const il = Math.hypot(ix, iy) || 1;
    const wander = () => (Math.random() - 0.5) * dist;
    const c1: Point = [(ix / il) * dist * 0.3 + wander() * 0.3, (iy / il) * dist * 0.3 + wander() * 0.3];
    const c2: Point = [dx + wander() * 0.5, dy + wander() * 0.5];
    // 길 위 t(0 제자리 ~ 1 그 점) 자리에서, 가는 방향으로 조금 늘인다.
    const pose = (t: number, stretch: number, size: number) => {
      const u = 1 - t;
      const x = 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * dx;
      const y = 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * dy;
      const tx = 3 * u * u * c1[0] + 6 * u * t * (c2[0] - c1[0]) + 3 * t * t * (dx - c2[0]);
      const ty = 3 * u * u * c1[1] + 6 * u * t * (c2[1] - c1[1]) + 3 * t * t * (dy - c2[1]);
      const angle = (Math.atan2(ty, tx) * 180) / Math.PI;
      return `translate(${x}px, ${y}px) rotate(${angle}deg) scale(${stretch * size}, ${size}) rotate(${-angle}deg)`;
    };
    const duration = kind === "out" ? (380 + reach * 360) * jitter : (480 + reach * 460) * jitter;
    // 채도·색상이 테두리를 따라 물결치듯 바뀌어 부드럽게 섞인다.
    const chroma = 0.7 + chromaWave(blob.around) * 0.6;
    const hue = (hueWave(blob.around) - 0.5) * 100;
    tints.push({ blob, chroma, hue });
    // 출발은 반은 물결을, 반은 덩이마다 제멋대로 — 고리 모양 그대로 움직이지 않게.
    const delay = after + (lag(blob.around) * 0.5 + Math.random() * 0.5) * 260;
    const shape = puff();
    const frames = (kind === "out" ? GATHER : SPREAD).map(([t, stretch, size, alpha]) => ({
      offset: t,
      transform: pose(kind === "out" ? t : 1 - t, stretch, size),
      alpha,
    }));
    for (let k = 0; k < TRAIL; k++) {
      const el = els[i * TRAIL + k];
      if (!el) continue;
      el.style.background = shape;
      el.style.setProperty("--chroma", String(chroma));
      el.style.setProperty("--hue", String(hue));
      // 잔상은 같은 길을 조금씩 늦게, 옅게 따라온다.
      el.animate(
        frames.map(({ offset, transform, alpha }) => ({ offset, transform, opacity: alpha * TRAIL_ALPHA[k] })),
        {
          id: FLOW,
          duration,
          delay: delay + k * TRAIL_LAG,
          easing: kind === "out" ? "cubic-bezier(0.55, 0, 0.8, 0.35)" : "cubic-bezier(0.22, 1, 0.36, 1)",
        }
      );
    }
    // 모으기는 다 모일 때까지 기다리지만, 퍼뜨리기는 덩이들이 거의 내려앉으면(60%) 끝난 셈 친다 — 그 뒤엔
    // 커서가 나가면 다시 모은다. 끝까지 기다리면 조금만 빨리 오가도 모이는 게 안 나왔다.
    until = Math.max(until, now + delay + (kind === "out" ? (TRAIL - 1) * TRAIL_LAG + duration : duration * 0.6));
  });
  // 퍼뜨릴 땐 덩이들이 내려앉은 색으로 띠도 칠한다. 띠는 덩이들이 거의 다 붙은 뒤에 켜지니 지금 칠해도 안 보인다.
  if (kind === "in") paintBand(band, tints);
  flights.set(band, { kind, until });
}

/** 빛을 바로 끈다. 커서가 없는 막은 빛이 없다. */
export function hideEdges(band: HTMLElement | null) {
  if (!band) return;
  stop(band);
  band.animate([{ opacity: 0 }], { id: FLOW, duration: 0, fill: "forwards" });
}
