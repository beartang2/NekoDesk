/**
 * 그림 속 먹선을 점 경로로 뽑는다(image.trace). 네코가 사용자가 준 그림을 따라 그릴 때, 눈대중으로
 * 좌표를 옮기면 선이 크게 빗나간다 — 이 경로를 neko_draw 의 stroke·shape 에 그대로 넘기면 선은 원본
 * 자리에 놓이고 손떨림·끊김 같은 화풍만 입는다.
 *
 * 순서: 어두운 픽셀(잉크) → 굵은 덩어리(눈동자·점)와 선 가르기 → 선을 한 픽셀 뼈대로 깎기 →
 * 뼈대를 끝점·갈림길 사이 경로로 잇기 → 점 줄이기 → 1536 캔버스 좌표로.
 */

export interface TraceImage {
  width: number;
  height: number;
  data: Uint8ClampedArray; // RGBA
}

export interface LineTrace {
  /** 열린 선 경로들. 위에서 아래 순. */
  lines: [number, number][][];
  /** 속이 꽉 찬 먹 덩어리(눈동자·점·굵은 붓 획)의 둘레와 원본 색. */
  blobs: { color: string; points: [number, number][] }[];
  /** 흰색·먹색을 뺀 주요 색, 많은 순. */
  colors: string[];
  /** 같은 색으로 칠한 면들의 둘레와 색. 큰 것부터 — 이 순서로 깔면 작은 면(안경알·부리)이 위에 온다. */
  fills: { color: string; points: [number, number][] }[];
}

/**
 * 먹선으로 칠 밝기 상한 = 그림에서 가장 어두운 0.5% 의 밝기 + INK_MARGIN, INK_MIN~INK_MAX 안에서.
 * 고정 110 이었을 땐 진한 커피색 면(~107)이 먹선으로 잡혀 컵 안이 통째로 선·덩어리가 됐다.
 * 검은 선(~25)이면 ~80 이 돼 진한 면은 빠지고, 갈색 선만 있는 그림이면 그만큼 올라간다.
 */
const INK_MARGIN = 55;
const INK_MIN = 70;
const INK_MAX = 120;
/** 이보다 짧은 뼈대 조각은 버린다(작업 해상도 픽셀). 선 끝의 잔가지다. */
const MIN_PATH = 10;

const N8: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** 마스크 안쪽 픽셀에서 가장 가까운 바깥까지의 거리(chamfer 3-4, ×3). 그림 밖은 바깥으로 친다. */
function distance(mask: Uint8Array, w: number, h: number): Int32Array {
  const d = new Int32Array(w * h);
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? 1 << 28 : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i]) d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i]) d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  return d;
}

/** Zhang-Suen 세선화. 제자리에서 깎는다. */
function thin(m: Uint8Array, w: number, h: number): void {
  const p = new Array<number>(8);
  for (let changed = true; changed; ) {
    changed = false;
    for (const step of [0, 1]) {
      const kill: number[] = [];
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!m[i]) continue;
          // N, NE, E, SE, S, SW, W, NW
          p[0] = m[i - w]; p[1] = m[i - w + 1]; p[2] = m[i + 1]; p[3] = m[i + w + 1];
          p[4] = m[i + w]; p[5] = m[i + w - 1]; p[6] = m[i - 1]; p[7] = m[i - w - 1];
          const b = p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + p[7];
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) a++;
          if (a !== 1) continue;
          if (step === 0 && (p[0] * p[2] * p[4] || p[2] * p[4] * p[6])) continue;
          if (step === 1 && (p[0] * p[2] * p[6] || p[0] * p[4] * p[6])) continue;
          kill.push(i);
        }
      for (const i of kill) m[i] = 0;
      if (kill.length) changed = true;
    }
  }
}

/**
 * 뼈대 픽셀 경로를 앞뒤 k점씩 평균해 픽셀 계단을 편다. 그대로 점을 줄이면 계단 모서리가 점으로 남아,
 * 1536 으로 키운 곡선에 혹처럼 튀어나온다. 두 끝점은 그대로 — 선이 짧아지지 않게.
 */
function relax(P: [number, number][], k: number): [number, number][] {
  return P.map((p, i) => {
    if (i === 0 || i === P.length - 1) return p;
    const lo = Math.max(0, i - k), hi = Math.min(P.length - 1, i + k);
    let x = 0, y = 0;
    for (let j = lo; j <= hi; j++) { x += P[j][0]; y += P[j][1]; }
    return [x / (hi - lo + 1), y / (hi - lo + 1)];
  });
}

/**
 * 갈림길에서 나뉜 경로 중 방향이 이어지는 두 갈래를 한 획으로 잇는다(제자리에서 고친다). 뼈대는
 * 갈림길마다 경로를 끊어서, 컵 외곽선처럼 뚜껑 선이 붙은 곡선도 토막으로 나왔다. 두 갈래가 서로
 * 반대쪽(135° 넘게 벌어짐)으로 나갈 때만 잇는다 — 꺾인 모서리까지 이으면 모양이 뭉개진다.
 */
/** 경로 끝에서 경로 안쪽으로 6점 들어간 방향(단위 벡터). 바깥으로 이어질 방향은 이것의 반대다. */
function away(p: number[], atStart: boolean, w: number): [number, number] {
  const k = Math.min(6, p.length - 1);
  const [a, b] = atStart ? [p[0], p[k]] : [p[p.length - 1], p[p.length - 1 - k]];
  const dx = (b % w) - (a % w), dy = Math.floor(b / w) - Math.floor(a / w), len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/**
 * 먹선이 잠깐 옅어져 끊긴 틈을 잇는다(제자리에서 고친다). 작은 그림을 키우면 1px 선이 군데군데 기준보다
 * 밝아져 한 획이 점선처럼 토막 났다. 두 끝이 maxGap 안(거의 일직선이면 두 배까지)에서 서로를 향해 뻗을 때만 — 옆 글자 획처럼
 * 나란히 있거나 등을 돌린 끝은 잇지 않는다. 한 경로의 두 끝이 마주보면 고리로 닫는다.
 */
function bridgeGaps(paths: number[][], w: number, maxGap: number): void {
  for (;;) {
    const ends: { path: number; atStart: boolean; x: number; y: number; ox: number; oy: number }[] = [];
    paths.forEach((p, i) => {
      if (p.length < 2 || p[0] === p[p.length - 1]) return;
      for (const atStart of [true, false]) {
        const node = atStart ? p[0] : p[p.length - 1];
        const [dx, dy] = away(p, atStart, w);
        ends.push({ path: i, atStart, x: node % w, y: Math.floor(node / w), ox: -dx, oy: -dy });
      }
    });
    let best: [number, number] | null = null;
    let bestD = maxGap * 2;
    for (let a = 0; a < ends.length; a++)
      for (let b = a + 1; b < ends.length; b++) {
        const A = ends[a], B = ends[b];
        if (A.path === B.path && paths[A.path].length < 20) continue;
        const vx = B.x - A.x, vy = B.y - A.y, d = Math.hypot(vx, vy);
        if (d < 1 || d > bestD) continue;
        // 마주보는 정도. maxGap 안이면 대충 마주봐도(0.5), 그 두 배까지는 거의 일직선(0.9)일 때만.
        const facing = Math.min((A.ox * vx + A.oy * vy) / d, -(B.ox * vx + B.oy * vy) / d);
        if (facing < (d > maxGap ? 0.9 : 0.5)) continue;
        best = [a, b];
        bestD = d;
      }
    if (!best) return;
    const A = ends[best[0]], B = ends[best[1]];
    if (A.path === B.path) {
      const p = paths[A.path];
      paths[A.path] = [...p, p[0]];
      continue;
    }
    const pa = A.atStart ? [...paths[A.path]].reverse() : paths[A.path]; // 틈이 끝에 오게
    const pb = B.atStart ? paths[B.path] : [...paths[B.path]].reverse(); // 틈이 처음에 오게
    paths[A.path] = [...pa, ...pb];
    paths[B.path] = [];
  }
}

function joinThroughJunctions(paths: number[][], w: number): void {
  for (let merged = true; merged; ) {
    merged = false;
    const ends = new Map<number, { path: number; atStart: boolean }[]>();
    paths.forEach((p, i) => {
      if (p.length < 2 || p[0] === p[p.length - 1]) return; // 고리는 그대로
      for (const atStart of [true, false]) {
        const node = atStart ? p[0] : p[p.length - 1];
        ends.set(node, [...(ends.get(node) ?? []), { path: i, atStart }]);
      }
    });
    for (const list of ends.values()) {
      let best: [number, number] | null = null;
      let bestDot = -Math.cos((135 * Math.PI) / 180);
      for (let a = 0; a < list.length; a++)
        for (let b = a + 1; b < list.length; b++) {
          if (list[a].path === list[b].path) continue;
          const [ax, ay] = away(paths[list[a].path], list[a].atStart, w);
          const [bx, by] = away(paths[list[b].path], list[b].atStart, w);
          const dot = ax * bx + ay * by;
          if (dot < -bestDot) { bestDot = -dot; best = [a, b]; }
        }
      if (!best) continue;
      const A = list[best[0]], B = list[best[1]];
      const pa = A.atStart ? [...paths[A.path]].reverse() : paths[A.path]; // 갈림길이 끝에 오게
      const pb = B.atStart ? paths[B.path] : [...paths[B.path]].reverse(); // 갈림길이 처음에 오게
      paths[A.path] = [...pa, ...pb.slice(1)];
      paths[B.path] = [];
      merged = true;
      break; // 끝점 목록이 바뀌었으니 다시 센다
    }
  }
}

function rdp(P: [number, number][], eps: number): [number, number][] {
  if (P.length < 3) return P;
  const [x1, y1] = P[0];
  const [x2, y2] = P[P.length - 1];
  const len = Math.hypot(x2 - x1, y2 - y1);
  let at = 0;
  let far = -1;
  for (let k = 1; k < P.length - 1; k++) {
    // 닫힌 고리는 두 끝이 같은 점이라 직선이 없다 — 그 점에서의 거리로 가장 먼 곳을 찾는다.
    const d = len
      ? Math.abs((y2 - y1) * P[k][0] - (x2 - x1) * P[k][1] + x2 * y1 - y2 * x1) / len
      : Math.hypot(P[k][0] - x1, P[k][1] - y1);
    if (d > far) { far = d; at = k; }
  }
  if (far <= eps) return [P[0], P[P.length - 1]];
  return [...rdp(P.slice(0, at + 1), eps).slice(0, -1), ...rdp(P.slice(at), eps)];
}

/**
 * upscale: 원본을 몇 배 키워 넘겼는지. 작은 그림을 키우면 계단 한 칸이 그만큼 길어진다 — 점을
 * 평균해 펴면 "+" 같은 작은 모서리까지 뭉개져서, 대신 그 배율만큼 점을 더 성글게 줄여 계단을 건너뛴다.
 */
export function traceLineArt(img: TraceImage, canvas = 1536, upscale = 1): LineTrace {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const luma = new Float32Array(n);
  const hist = new Array<number>(256).fill(0);
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    luma[i] = data[i * 4 + 3] > 128 ? 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2] : 255;
    if (data[i * 4 + 3] > 128) { hist[Math.min(255, Math.floor(luma[i]))]++; opaque++; }
  }
  let dark = 0;
  for (let acc = 0; dark < 255 && (acc += hist[dark]) < opaque * 0.005; dark++);
  const inkLuma = Math.min(INK_MAX, Math.max(INK_MIN, dark + INK_MARGIN));
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) ink[i] = luma[i] < inkLuma ? 1 : 0;
  const eps = Math.max(0.8, 0.5 * upscale);
  const S = canvas / Math.max(w, h);
  const ox = (canvas - w * S) / 2, oy = (canvas - h * S) / 2;
  const toCanvas = ([x, y]: [number, number]): [number, number] => [Math.round(x * S + ox), Math.round(y * S + oy)];
  // 면 둘레는 조금만 편다 — 많이 펴면 면이 오그라들어 이웃 면과 틈이 난다.
  const fills = regions(img, ink).map((f) => ({ color: f.color, points: rdp(relax(f.points, 2), eps).map(toCanvas) }));

  // 선 굵기: 능선(가로·세로 이웃보다 먼 곳)의 거리 중앙값이 반폭이다.
  const D = distance(ink, w, h);
  const ridge: number[] = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (D[i] && D[i] >= Math.max(D[i - 1], D[i + 1], D[i - w], D[i + w])) ridge.push(D[i]);
    }
  const colors = palette(img, ink);
  if (!ridge.length) return { lines: [], blobs: [], colors, fills };
  ridge.sort((a, b) => a - b);
  const half = ridge[ridge.length >> 1] / 3;

  // 반폭의 1.7배보다 두꺼운 곳(그 둘레까지)은 덩어리, 나머지 잉크는 선.
  const R = half * 1.7;
  const notCore = new Uint8Array(n);
  for (let i = 0; i < n; i++) notCore[i] = D[i] / 3 > R ? 0 : 1;
  const toCore = distance(notCore, w, h);
  const blob = new Uint8Array(n);
  const line = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!ink[i]) continue;
    if (toCore[i] / 3 <= R + 1) blob[i] = 1;
    else line[i] = 1;
  }

  // 덩어리 무리. 작은 것은 선이 겹치거나 꾹 눌러 그은 자리라 선으로 돌려보낸다 — 덩어리로 두면
  // 그 자리에서 선이 끊긴다. 눈동자·점처럼 선 굵기의 몇 배 되는 것만 남긴다.
  const minBlob = Math.max(30, 20 * half * half);
  const seen = new Uint8Array(n);
  const comps: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (!blob[s] || seen[s]) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy, j = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && blob[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    // 진짜 덩어리(눈동자·점·굵은 눈)만 남긴다. 선보다 조금 굵을 뿐(2.6배 미만)이면서 길쭉한 무리는
    // 붓이 눌린 외곽선 토막이다 — 덩어리로 두면 곡선이 거기서마다 끊겨 짧은 토막 선이 된다.
    let thick = 0;
    for (const i of comp) thick = Math.max(thick, D[i] / 3);
    const elongated = comp.length / (thick * thick) > 12;
    if (comp.length >= minBlob && (thick >= half * 2.6 || !elongated)) comps.push(comp);
    else for (const i of comp) line[i] = 1;
  }

  thin(line, w, h);
  const neighbors = (i: number): number[] => {
    const x = i % w, y = (i - x) / w, out: number[] = [];
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && line[ny * w + nx]) out.push(ny * w + nx);
    }
    return out;
  };
  const touching = (a: number, b: number) => Math.max(Math.abs((a % w) - (b % w)), Math.abs(Math.floor(a / w) - Math.floor(b / w))) === 1;
  // 계단 모서리처럼 빼도 이웃끼리 이어지는 점은 지운다 — 남기면 이웃이 갈림길로 보여 선이 토막 난다.
  for (let i = 0; i < n; i++) {
    if (!line[i]) continue;
    const nb = neighbors(i);
    if (nb.length < 2) continue;
    const left = new Set(nb.slice(1));
    const stack = [nb[0]];
    while (stack.length) {
      const a = stack.pop()!;
      for (const b of [...left]) if (touching(a, b)) { left.delete(b); stack.push(b); }
    }
    if (!left.size) line[i] = 0;
  }

  const used = new Set<number>();
  const key = (a: number, b: number) => Math.min(a, b) * n + Math.max(a, b);
  const isNode = (i: number) => neighbors(i).length !== 2;
  const walk = (a: number, b: number): number[] => {
    const path = [a, b];
    used.add(key(a, b));
    while (!isNode(path[path.length - 1])) {
      const cur = path[path.length - 1];
      const next = neighbors(cur).find((q) => !used.has(key(cur, q)) && q !== path[path.length - 2]);
      if (next === undefined) break;
      used.add(key(cur, next));
      path.push(next);
      if (next === path[0]) break;
    }
    return path;
  };
  const raw: number[][] = [];
  const starts: number[] = [];
  for (let i = 0; i < n; i++) if (line[i] && isNode(i)) starts.push(i);
  for (let i = 0; i < n; i++) if (line[i] && !isNode(i)) starts.push(i); // 끝점 없는 고리
  for (const a of starts) for (const b of neighbors(a)) if (!used.has(key(a, b))) raw.push(walk(a, b));
  // 끝에 붙은 짧은 잔가지를 먼저 걷는다 — 남아 있으면 진짜 선 끝이 갈림길이 돼 잇기도, 틈 메우기도 못 한다.
  for (let i = 0; i < raw.length; i++) if (raw[i].length < MIN_PATH && raw[i][0] !== raw[i][raw[i].length - 1]) raw[i] = [];
  joinThroughJunctions(raw, w);
  // 1px 쯤 끊긴 틈 — 원본 1px 이 작업 해상도에선 upscale px 다. 뼈대로 깎으면 끝이 선 반폭만큼씩 물러나
  // 틈이 그만큼 더 벌어진다.
  bridgeGaps(raw, w, Math.max(4, 1.6 * upscale) + 2.5 * half);

  const lines = raw
    .filter((p) => p.length >= MIN_PATH)
    .map((p) => rdp(relax(p.map((i): [number, number] => [i % w, Math.floor(i / w)]), 3), eps).map(toCanvas))
    .sort((a, b) => Math.min(...a.map((q) => q[1])) - Math.min(...b.map((q) => q[1])));

  // 덩어리 둘레는 면과 같은 둘레 추적으로 — 길쭉한 붓 획도 제 모양대로. 색은 원본 평균(검정만은 아니다).
  const blobLabel = new Int32Array(n).fill(-1);
  comps.forEach((comp, k) => { for (const i of comp) blobLabel[i] = k; });
  const blobs = comps.map((comp, k) => {
    // 색은 속(가장자리에서 먼 30%)만 본다 — 가장자리는 옆 면 색과 섞여 번져서, 굵어진 외곽선 토막이
    // 갈색 면 옆에선 갈색으로 칠해져 선이 얼룩덜룩해졌다.
    const core = [...comp].sort((a, b) => D[b] - D[a]).slice(0, Math.max(1, Math.ceil(comp.length * 0.3)));
    const sum = [0, 0, 0];
    for (const i of core) { sum[0] += data[i * 4]; sum[1] += data[i * 4 + 1]; sum[2] += data[i * 4 + 2]; }
    return { color: hexColor(sum.map((v) => v / core.length)), points: rdp(relax(outline(blobLabel, k, w, h), 2), eps).map(toCanvas) };
  });

  // 다른 선과 안 이어진 작은 먹 자국(작은 그림의 2~3px 눈·점)은 뼈대가 MIN_PATH 보다 짧아 선에서도,
  // 덩어리 크기에도 못 들어 통째로 사라졌다 — 그 모양·색 그대로 덩어리로 남긴다.
  const inkLabel = new Int32Array(n).fill(-1);
  const inkComps: number[][] = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (!ink[s0] || inkLabel[s0] >= 0) continue;
    const comp: number[] = [];
    const stack = [s0];
    inkLabel[s0] = inkComps.length;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w, y = (i - x) / w;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy, j = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && ink[j] && inkLabel[j] < 0) { inkLabel[j] = inkComps.length; stack.push(j); }
      }
    }
    inkComps.push(comp);
  }
  const drawn = new Uint8Array(inkComps.length);
  for (const p of raw) if (p.length >= MIN_PATH) for (const i of p) drawn[inkLabel[i]] = 1;
  for (const comp of comps) drawn[inkLabel[comp[0]]] = 1;
  inkComps.forEach((comp, c) => {
    if (drawn[c] || comp.length < 12) return;
    const k = blobs.length;
    for (const i of comp) blobLabel[i] = k;
    const darkest = [...comp].sort((a, b) => luma[a] - luma[b]).slice(0, Math.ceil(comp.length / 2));
    const sum = [0, 0, 0];
    for (const i of darkest) { sum[0] += data[i * 4]; sum[1] += data[i * 4 + 1]; sum[2] += data[i * 4 + 2]; }
    blobs.push({ color: hexColor(sum.map((v) => v / darkest.length)), points: rdp(relax(outline(blobLabel, k, w, h), 2), eps).map(toCanvas) });
  });

  return { lines, blobs, colors, fills };
}

/**
 * 번호 지도(768px PNG). 원본을 흐리게 깔고 선마다 색과 번호를 단다 — 네코가 몇 번이 귀이고
 * 몇 번이 머리인지 보고 고른다. 덩어리는 B0, B1….
 */
export function drawTraceMap(trace: LineTrace, source: CanvasImageSource & { width: number; height: number }): string {
  const size = 768, k = size / 1536;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, size, size);
  const s = size / Math.max(source.width, source.height);
  g.globalAlpha = 0.3;
  g.drawImage(source, (size - source.width * s) / 2, (size - source.height * s) / 2, source.width * s, source.height * s);
  g.globalAlpha = 1;
  g.lineCap = g.lineJoin = "round";
  g.font = "bold 15px -apple-system, sans-serif";
  const label = (text: string, [x, y]: [number, number], color: string) => {
    g.lineWidth = 4;
    g.strokeStyle = "#fff";
    g.strokeText(text, x * k + 4, y * k - 4);
    g.fillStyle = color;
    g.fillText(text, x * k + 4, y * k - 4);
  };
  // 면 번호(F0, F1…)는 면 한가운데에 — 변주에서 털색을 바꿀 면을 빠짐없이 고르게.
  trace.fills.forEach((f, i) => {
    const cx = f.points.reduce((a, p) => a + p[0], 0) / f.points.length;
    const cy = f.points.reduce((a, p) => a + p[1], 0) / f.points.length;
    label(`F${i}`, [cx, cy], "#666");
  });
  trace.blobs.forEach((b, i) => {
    g.fillStyle = b.color;
    g.beginPath();
    b.points.forEach(([x, y], j) => (j ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k)));
    g.fill();
    label(`B${i}`, b.points[0], "#111");
  });
  trace.lines.forEach((p, i) => {
    const color = `hsl(${(i * 47) % 360} 80% 42%)`;
    g.strokeStyle = color;
    g.lineWidth = 3;
    g.beginPath();
    p.forEach(([x, y], j) => (j ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k)));
    g.stroke();
    label(String(i), p[Math.floor(p.length / 2)], color);
  });
  return c.toDataURL("image/png");
}

function hexColor(rgb: number[]): string {
  return `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** 두 색이 같은 면으로 칠해졌다고 볼 RGB 거리. JPEG 얼룩(±10)은 넘고 회색 두 톤(~25)은 가른다. */
const SAME_FILL = 18;
/** 맞닿은 두 면의 평균색이 이만큼 가까우면 한 면으로 합친다. 그라데이션·JPEG 로 쪼개진 같은 면을 잇되
 *  회색 두 톤 얼굴(~38)·안경알과 얼굴(~35)·회색 머리와 분홍 귀(~25)는 남긴다. */
const MERGE_FILL = 20;

/**
 * 먹선이 아닌 픽셀을 비슷한 색끼리 묶어 면을 찾는다(그림의 0.05% 보다 작은 조각은 버린다). 그다음 먹선 자리와 번진 자투리를 이웃 면에
 * 나눠 줘 면들이 빈틈없이 맞물리게 하고(선은 그 위에 그어진다), 같은 색으로 쪼개진 이웃 면은 합친다.
 * 그림 가장자리에 닿은 흰 바탕은 버린다. 면 안의 구멍은 따로 안 판다 — 큰 면부터 깔면 그 자리의
 * 작은 면이 위에 덮인다.
 */
function regions(img: TraceImage, ink: Uint8Array): { color: string; points: [number, number][] }[] {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const found: { area: number; rgb: number[]; edge: boolean }[] = [];
  for (let s = 0; s < n; s++) {
    if (ink[s] || label[s] >= 0) continue;
    const id = found.length;
    const sum = [data[s * 4], data[s * 4 + 1], data[s * 4 + 2]];
    let area = 1, edge = false;
    const stack = [s];
    label[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || ink[j] || label[j] >= 0) continue;
        // 시작점이 아니라 지금까지 모인 면의 평균과 비교한다 — 키운 그림의 완만한 번짐에서 시작해도 면이 안 쪼개진다.
        if (Math.hypot(data[j * 4] - sum[0] / area, data[j * 4 + 1] - sum[1] / area, data[j * 4 + 2] - sum[2] / area) > SAME_FILL) continue;
        label[j] = id;
        sum[0] += data[j * 4]; sum[1] += data[j * 4 + 1]; sum[2] += data[j * 4 + 2];
        area++;
        stack.push(j);
      }
    }
    found.push({ area, rgb: sum, edge });
  }

  // 같은 색으로 쪼개진 면을 합친다 — 먹선 없이 바로 맞닿은 면끼리만. 선으로 갈린 면(눈의 초승달 홍채와
  // 얼굴처럼)은 색이 비슷해도 따로 둔다. 예전엔 먹선 자리를 이웃 면에 나눠 준 뒤에 합쳐서, 선 너머의 비슷한
  // 색까지 붙어 홍채가 얼굴에 묻혔다.
  const parent = found.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  const mean = (f: { area: number; rgb: number[] }) => f.rgb.map((v) => v / f.area);
  for (let i = 0; i < n; i++) {
    const x = i % w;
    for (const j of [x < w - 1 ? i + 1 : -1, i + w < n ? i + w : -1]) {
      if (j < 0 || label[i] < 0 || label[j] < 0) continue;
      const a = root(label[i]), b = root(label[j]);
      if (a === b) continue;
      const [ma, mb] = [mean(found[a]), mean(found[b])];
      if (Math.hypot(ma[0] - mb[0], ma[1] - mb[1], ma[2] - mb[2]) > MERGE_FILL) continue;
      parent[b] = a;
      found[a] = { area: found[a].area + found[b].area, rgb: found[a].rgb.map((v, k) => v + found[b].rgb[k]), edge: found[a].edge || found[b].edge };
    }
  }
  for (let i = 0; i < n; i++) if (label[i] >= 0) label[i] = root(label[i]);

  // 먹선·자투리 픽셀은 가장 가까운 큰 면에 붙인다(여러 출발점 너비 우선) — 면들이 빈틈없이 맞물리게.
  // 작은 그림의 반짝이 속·부리도 남게 0.05%. 선 가장자리 번짐 조각은 이보다 작거나, 남아도 선 밑에 묻힌다.
  const big = found.map((f, id) => root(id) === id && f.area >= n * 0.0005);
  let queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0 && big[label[i]]) queue.push(i);
    else label[i] = -1;
  }
  while (queue.length) {
    const next: number[] = [];
    for (const i of queue) {
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || label[j] >= 0) continue;
        label[j] = label[i];
        next.push(j);
      }
    }
    queue = next;
  }

  return found
    .map((f, id) => ({ ...f, id, color: mean(f) }))
    .filter((f) => root(f.id) === f.id && big[f.id] && !(f.edge && Math.min(...f.color) > 235))
    .sort((a, b) => b.area - a.area)
    .map((f) => ({ color: hexColor(f.color), points: outline(label, f.id, w, h) }));
}

/**
 * Moore 이웃 추적으로 면 하나의 바깥 둘레. 면을 한 픽셀 불려서 돈다 — 픽셀 중심을 따라가면 이웃 면과
 * 반 픽셀씩 떠서, 키운 그림에서 면 사이로 흰 실금이 보였다.
 */
function outline(label: Int32Array, id: number, w: number, h: number): [number, number][] {
  const own = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === id;
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < w && y < h && (own(x, y) || own(x - 1, y) || own(x + 1, y) || own(x, y - 1) || own(x, y + 1));
  let start = -1;
  for (let i = 0; i < w * h && start < 0; i++) if (inside(i % w, Math.floor(i / w))) start = i;
  // 화면 좌표(아래가 +y)에서 시계 방향: E, SE, S, SW, W, NW, N, NE
  const dirs: [number, number][] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const dirOf = (dx: number, dy: number) => dirs.findIndex(([a, b]) => a === dx && b === dy);
  const sx = start % w, sy = (start - sx) / w;
  let x = sx, y = sy, bx = sx - 1, by = sy;
  const out: [number, number][] = [[x, y]];
  for (let step = 0; step < 4 * w * h; step++) {
    const k0 = dirOf(bx - x, by - y);
    let moved = false;
    for (let s = 1; s <= 8; s++) {
      const [dx, dy] = dirs[(k0 + s) % 8];
      if (!inside(x + dx, y + dy)) continue;
      const [px, py] = dirs[(k0 + s - 1) % 8];
      bx = x + px; by = y + py;
      x += dx; y += dy;
      moved = true;
      break;
    }
    if (!moved || (x === sx && y === sy)) break;
    out.push([x, y]);
  }
  out.push([sx, sy]); // 닫는다 — rdp 가 고리로 다룬다
  return out;
}

/** 흰 바탕·먹선을 뺀 픽셀을 채널당 16단계로 묶어 많은 순 6색. 0.2% 미만은 버린다(눈의 노란 초승달도 남게). */
function palette(img: TraceImage, ink: Uint8Array): string[] {
  const { data } = img;
  const groups = new Map<number, [number, number, number, number]>();
  let total = 0;
  for (let i = 0; i < ink.length; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    if (ink[i] || data[i * 4 + 3] <= 128 || (r > 238 && g > 238 && b > 238)) continue;
    total++;
    const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const s = groups.get(k) ?? [0, 0, 0, 0];
    s[0]++; s[1] += r; s[2] += g; s[3] += b;
    groups.set(k, s);
  }
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return [...groups.values()]
    .filter((s) => s[0] >= total * 0.002)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 6)
    .map(([c, r, g, b]) => `#${hex(r / c)}${hex(g / c)}${hex(b / c)}`.toUpperCase());
}
