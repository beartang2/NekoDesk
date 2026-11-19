import type { MapPlace } from "../api/tauri";

/**
 * 네코 산책 경로. 떠날 때 한 번 다 정해 저장하고, 지금 자리는 시각만으로 구한다(positionAt) —
 * 앱을 껐다 켜거나 맥이 잠들어도 산책이 끊기지 않는다.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/** 집 기준 미터 [동, 북]. */
export type Pt = [number, number];
/** 경로 한 점 [동, 북, 시각 ms]. 같은 자리가 두 번 이어지면 그 사이는 머문다. */
export type TimedPt = [number, number, number];

export interface Walk {
  /** 집(출발한 곳). null 이면 위치를 몰라 지도 없이 걷는다. */
  home: LatLon | null;
  /** 실제 길을 따라 걷는가. 아니면 대체 경로(fallbackLegs)라 지도 대신 동심원 위에 그린다. */
  onMap: boolean;
  /** 들르는 곳(onMap) 또는 근처에서 찾은 곳. 머리(startWalkBrain)에 그대로 준다. */
  places: MapPlace[];
  path: TimedPt[];
  /** 다녀왔다. 지우지 않고 남겨 다음 산책까지의 간격과 선물 핀에 쓴다. */
  done?: boolean;
  pin?: MapPlace;
  /** 음악을 듣다 나갔다: 헤드폰을 낀 채 걷는다(지도 위 네코·산책 중 그림·마당 팻말 음표) */
  music?: true;
}

export const WALK_MS = 30 * 60_000;

/** 집 둘레를 평평하게 펴서 미터로(등장방형). 1 km 남짓이면 오차는 무시할 만하다. */
export function toMeters(o: LatLon, lat: number, lon: number): Pt {
  return [(lon - o.lon) * Math.cos((o.lat * Math.PI) / 180) * 111320, (lat - o.lat) * 110540];
}

export function toLatLon(o: LatLon, [x, y]: Pt): [number, number] {
  return [o.lat + y / 110540, o.lon + x / (Math.cos((o.lat * Math.PI) / 180) * 111320)];
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const walkEnd = (w: Walk) => w.path[w.path.length - 1][2];
export const walkStart = (w: Walk) => w.path[0][2];

/* ---------- 언제 나가나 ----------
   정기 산책: 아침 7–9시·점심 12–14시·저녁 18–20시(로컬 시각) 한 번씩. 그 시간대에 졸고 있으면(5분 조용) 기다리지 않고
   나간다 — 간격은 안 본다. 그 시간대에 이미 다녀왔으면(추가 산책 포함) 다시 안 나가고, 끝날 때까지 한 번도 안 졸았으면
   건너뛴다. 꺼져 있던 시간대는 따라잡지 않는다(앱이 켜져 졸 때만 따진다).
   추가 산책: 졸기 시작하고 5–20분 더 조용하고, 지난 산책이 끝나고 2시간이 지났을 때. */
/** 정기 산책 시간대 [시작 시, 끝 시, 이름] */
export const ROUTINE_HOURS: [number, number, string][] = [[7, 9, "아침"], [12, 14, "점심"], [18, 20, "저녁"]];
export const WALK_GAP_MS = 2 * 60 * 60_000;
export const EXTRA_WAIT_MS: [number, number] = [5 * 60_000, 20 * 60_000];

/** 그 날(로컬)의 정기 산책 시간대들 [시작, 끝) */
export function routineWindows(day: number): [number, number][] {
  const d = new Date(day), at = (h: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
  return ROUTINE_HOURS.map(([a, b]) => [at(a), at(b)]);
}
/** 그 시각이 든 정기 산책 이름(아침·점심·저녁). 시간대 밖이면 null */
export function routineName(time: number): string | null {
  const h = new Date(time).getHours();
  return ROUTINE_HOURS.find(([a, b]) => h >= a && h < b)?.[2] ?? null;
}

/** 기기들이 같이 보는 마지막 산책(동기화, docs/neko-sync.md §5.4). mine = 이 기기가 나간 것 */
export interface SharedWalk { start: number; end: number; mine: boolean }

/** 다음 산책을 잴 '지난 산책': 이 기기 것과 같이 보는 것 중 더 늦게 나간 쪽. 다른 기기가 끼니 산책을 다녀왔으면 또 나가지 않는다 */
export function lastWalkWith(local: { start: number; end: number } | null, shared: SharedWalk | null): { start: number; end: number } | null {
  if (!shared) return local;
  const s = { start: shared.start, end: shared.end };
  return local && local.start >= s.start ? local : s;
}

/** 다른 기기가 지금 산책 중인가 — 그동안 이 기기의 네코도 자리에 없다 */
export const walkingElsewhere = (shared: SharedWalk | null, now: number): boolean =>
  !!shared && !shared.mine && now >= shared.start && now < shared.end;

export interface WalkPlan {
  /** 나갈 시각(ms). 지금보다 이르면 바로 */
  at: number;
  /** 정기 산책인가(아니면 추가 산책) */
  routine: boolean;
}

/**
 * 졸기 시작한 뒤 언제 나갈지 — 정기 산책과 추가 산책 중 이른 쪽. 계속 졸고 있다는 가정이라, 그사이 사용자가 돌아오면
 * 부르는 쪽이 다시 졸 때 새로 구한다. lastWalk = 지난 산책(다녀온 것)의 시작·끝.
 */
export function nextWalkAt(o: { dozeAt: number; lastWalk: { start: number; end: number } | null; extraWait: number }): WalkPlan {
  const { dozeAt, lastWalk, extraWait } = o;
  const extra: WalkPlan = { at: Math.max(dozeAt + extraWait, lastWalk ? lastWalk.end + WALK_GAP_MS : 0), routine: false };
  for (const day of [dozeAt, dozeAt + 86_400_000]) {
    for (const [a, b] of routineWindows(day)) {
      if (b <= dozeAt) continue; // 이미 지난 시간대
      if (lastWalk && lastWalk.start >= a && lastWalk.start < b) continue; // 그 시간대엔 다녀왔다
      const at = Math.max(a, dozeAt);
      return at < extra.at ? { at, routine: true } : extra; // 첫 시간대만 보면 된다(뒤엣것은 더 늦다)
    }
  }
  return extra;
}

/** 들를 곳 2–4 곳. 집에서 가까운 순으로 세워 점점 멀어졌다가 마지막에 돌아오게 한다. */
export function pickPlaces(home: LatLon, places: MapPlace[], rnd = Math.random): MapPlace[] {
  const names = new Set<string>();
  const all = places
    .map((p) => {
      const [x, y] = toMeters(home, p.lat, p.lon);
      return { p, d: Math.hypot(x, y), a: Math.atan2(y, x) };
    })
    // 바로 집 앞은 산책이 아니다. 같은 이름(체인점 여러 곳)은 한 번만.
    .filter((c) => c.d > 60 && !names.has(c.p.name) && !!names.add(c.p.name));
  if (!all.length) return [];
  // 한쪽으로 나갔다 오게 — 가까운 순으로만 세우면 집을 사이에 두고 오가며 지그재그가 됐다.
  const dir = all[Math.floor(rnd() * all.length)].a;
  const side = all.filter((c) => Math.abs(Math.atan2(Math.sin(c.a - dir), Math.cos(c.a - dir))) < Math.PI * 0.4);
  const far = side.length >= 2 ? side : all;
  for (let i = far.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [far[i], far[j]] = [far[j], far[i]];
  }
  return far
    .slice(0, 2 + Math.floor(rnd() * 3))
    .sort((a, b) => a.d - b.d)
    .map((c) => c.p);
}

/**
 * 구간들(집→곳→…→집)을 이어 durationMs 동안 걷는 경로. 빠르기는 일정하게 길이에 맞춰 늘이고,
 * 구간 사이(들른 곳)마다 dwellMs[k] 만큼 머문다.
 */
export function buildPath(legs: Pt[][], start: number, durationMs: number, dwellMs: number[] = []): TimedPt[] {
  const pts: Pt[] = [];
  const stays = new Map<number, number>();
  legs.forEach((leg, k) => {
    pts.push(...leg);
    if (k < legs.length - 1) stays.set(pts.length - 1, dwellMs[k] ?? 0);
  });
  const len = pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : s), 0);
  const stayMs = [...stays.values()].reduce((a, b) => a + b, 0);
  const msPerM = len > 0 ? Math.max(0, durationMs - stayMs) / len : 0;
  const out: TimedPt[] = [];
  let t = start;
  pts.forEach((p, i) => {
    if (i) t += dist(pts[i - 1], p) * msPerM;
    out.push([p[0], p[1], t]);
    const stay = stays.get(i);
    if (stay) out.push([p[0], p[1], (t += stay)]);
  });
  return out;
}

/** now 의 자리. 떠나기 전엔 첫 점, 다녀온 뒤엔 마지막 점. */
export function positionAt(path: TimedPt[], now: number): Pt {
  const i = path.findIndex((p) => p[2] > now);
  const p = path[i === -1 ? path.length - 1 : i];
  if (i <= 0) return [p[0], p[1]];
  const a = path[i - 1];
  const f = (now - a[2]) / (p[2] - a[2]);
  return [a[0] + (p[0] - a[0]) * f, a[1] + (p[1] - a[1]) * f];
}

/** 지금까지 걸어온 자취(지금 자리까지). */
export function walkedAt(path: TimedPt[], now: number): Pt[] {
  return [...path.filter((p) => p[2] <= now).map((p): Pt => [p[0], p[1]]), positionAt(path, now)];
}

/**
 * 사용자가 돌아오면 남은 길을 버리고 곧장 집으로 — 1–2분. route 는 지금 자리→집 걷기 경로,
 * 없으면 직선. 앞뒤에 지금 자리와 집을 붙여 경로가 길에 붙느라 어긋나도 끊기지 않게 한다.
 */
export function hurryHome(path: TimedPt[], now: number, route: Pt[] = []): TimedPt[] {
  const way: Pt[] = [positionAt(path, now), ...route, [0, 0]];
  const len = way.reduce((s, p, i) => (i ? s + dist(way[i - 1], p) : s), 0);
  const ms = 60_000 + 60_000 * Math.min(1, len / 1500);
  return [...path.filter((p) => p[2] <= now), ...buildPath([way], now, ms)];
}

/**
 * 지도나 길을 못 쓸 때의 산책. 목표를 향해 조금씩만 꺾으며 흔들리는 편향 상관 랜덤 워크(BCRW) —
 * 곧장 가면 기계 같고, 그냥 랜덤 워크는 제자리를 맴돈다. 목표는 집에서 점점 먼 곳들, 마지막은 집.
 */
export function fallbackLegs(rnd = Math.random): Pt[][] {
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const STEP = 15, MAX_TURN = 0.5, SIGMA = 0.25;
  let bearing = rnd() * 2 * Math.PI;
  const targets: Pt[] = Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => 150 + rnd() * 550)
    .sort((a, b) => a - b)
    .map((r) => {
      bearing += (rnd() - 0.5) * 1.5; // 한 방향으로 뻗어 나간다
      return [Math.cos(bearing) * r, Math.sin(bearing) * r];
    });
  targets.push([0, 0]);
  let pos: Pt = [0, 0];
  let theta = Math.atan2(targets[0][1], targets[0][0]);
  return targets.map((target) => {
    const leg: Pt[] = [pos];
    // 꺾는 반경(STEP/MAX_TURN ≈ 30m)보다 넓게 잡아야 목표 둘레를 맴돌지 않는다.
    for (let i = 0; i < 300 && dist(pos, target) > 2 * STEP; i++) {
      const want = Math.atan2(target[1] - pos[1], target[0] - pos[0]);
      const turn = Math.atan2(Math.sin(want - theta), Math.cos(want - theta));
      theta += Math.max(-MAX_TURN, Math.min(MAX_TURN, turn)) + gauss() * SIGMA;
      pos = [pos[0] + Math.cos(theta) * STEP, pos[1] + Math.sin(theta) * STEP];
      leg.push(pos);
    }
    leg.push((pos = target));
    return leg;
  });
}
