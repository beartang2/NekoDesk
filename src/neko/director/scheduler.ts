import type { NekoActivity, NekoMood, NekoPose, NekoReaction, NekoTailSign } from "../engine/neko-engine";
import { baseOf, mixable } from "../engine/activity-mix";
import { RESULT_LINGER_MS, type DeriveOut } from "./derive";
import type { NekoLayer, NekoPlan, Reaction } from "./types";

/**
 * 스케줄러(설계 docs/neko-p2-director.md §6): 계획을 엔진에 '천천히' 적용한다.
 * 시계와 컨트롤러를 받아서 만들기 때문에 테스트에선 가짜 둘을 넣는다.
 *
 * 1 최소 머무름 · 2 같은 활동은 이어 감 · 3 바꾸기는 엔진에 맡김(쏙→뿅) · 4 한 번짜리는 끝까지
 * 5 결과 여운 · 6 반응 묶기·띄우기 · 7 손(잡기) 뒤 다시 적용 · 8 세션 전환 · 9 깨어남(기지개 → 인사)
 * 10 타이머 하나 · 11 꼬리 유지
 */

export const DWELL_MS = 1500;
/**
 * 일할 때(도구·답 쓰기) 활동은 한 번 시작하면 이만큼은 보인다(사용자: 5~10초, 6초로 정함). 빠른 도구가 연달아 와도
 * 활동이 스쳐 지나가거나 깜빡이지 않게 — 그동안 온 다음 도구의 활동은 이 뒤에 이어 보인다. 기다림(확인·질문)은
 * 막지 않는다. 일이 끝나면(세션이 일에서 벗어남) 남은 머무름을 다 채우지 않고 FINISH_MS 만 마무리한다.
 */
export const WORK_DWELL_MS = 6000;
/**
 * 일이 끝났을 때 하던 동작을 마무리하는 시간(타자를 마지막으로 탁탁). 그 뒤 결과 표정으로 가고, 결과 반응(떨기 등)도
 * 이 마무리가 끝나야 나온다 — 머무름 6초에 밀려 답이 끝난 한참 뒤에 나오지 않게, 타이핑 중에 떨지 않게.
 */
export const FINISH_MS = 800;
/** 세션이 아직 일하는 중인 층. 이 밖으로 가면 '일이 끝났다' */
const WORK_LAYERS: ReadonlySet<NekoLayer> = new Set(["tool", "think", "answer", "waiting"]);
/** 다른 앱 따라 하기 활동은 앱을 금방 바꿔도 이만큼은 이어 한다(⌘Tab 마다 바꾸면 산만해 보인다) */
export const AMBIENT_DWELL_MS = 15_000;
export const ONE_SHOT_CAP_MS = 12_000;
export const REPEAT_GAP_MS = 400;
export const REACT_DEDUPE_MS = 800;
export const REACT_GAP_MS = 400;
export const DROP_SETTLE_MS = 900;
export const TAIL_HOLD_EVERY_MS = 2500;

/** 스케줄러가 쓰는 컨트롤러 부분(NekoController 가 그대로 맞는다) */
export interface SchedulerCtrl {
  setMood(m: NekoMood): void;
  setPose(p: NekoPose): void;
  act(key: NekoActivity | null): void;
  readonly activity: NekoActivity | null;
  tail(sign: NekoTailSign, sec?: number): void;
  react(kind: NekoReaction): boolean;
  setWander(on: boolean): void;
  /** 곁들임. 지금 도는 것과 안 맞으면 엔진이 거절한다(false) */
  mix(key: NekoActivity | null): boolean;
  on(ev: "activity" | "side", fn: (a: NekoActivity | null) => void): () => void;
  on(ev: "grab" | "drop", fn: () => void): () => void;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

interface Running {
  activity: NekoActivity;
  startedAt: number;
  oneShot: boolean;
  dwell: boolean;
  /** 최소 머무름 길이(일하는 활동은 WORK_DWELL_MS) */
  dwellMs: number;
  /** 이 활동을 시킨 층 */
  layer: NekoLayer;
  /** 세션 일(도구·답 쓰기)로 하던 활동인데 일이 끝난 걸 처음 본 시각. 이 뒤 FINISH_MS 만 더 한다 */
  finishFrom: number | null;
  instance: string;
  /** 엔진이 끝냈거나(한 번짜리 끝·잡힘) 우리가 바꾼 시각 */
  endedAt: number | null;
}

interface Queued {
  r: Reaction;
  dueAt: number;
  gated: boolean;
}

export interface SchedulerLogEntry {
  t: number;
  what: string;
}

export interface Scheduler {
  /** 계획을 다시 받아 적용한다(입력이 바뀌었을 때 부른다) */
  update(): void;
  /** 일회성 반응을 줄에 넣는다 */
  react(rs: Reaction[]): void;
  /** 활성 세션이 바뀜: 머무름·다음·쌓인 반응을 버리고 바로 새 계획 */
  resetSession(): void;
  dispose(): void;
  /** 적용한 것의 기록(개발용·테스트용) */
  log(): SchedulerLogEntry[];
  readonly layer: NekoLayer | null;
}

export function createScheduler(ctrl: SchedulerCtrl, clock: Clock, getPlan: (now: number) => DeriveOut): Scheduler {
  let cur: Running | null = null;
  let wakeGreetPending = false;
  let grabbed = false;
  let settleUntil = 0;
  let lastLayer: NekoLayer | null = null;
  let applied: { mood?: NekoMood; pose?: NekoPose; wander?: boolean } = {};
  /** 마지막으로 보낸(엔진이 끝내면 엔진이 알린) 곁들임 */
  let sentSide: NekoActivity | null = null;
  let tailHold: { sign: NekoTailSign; nextAt: number } | null = null;
  let queue: Queued[] = [];
  const lastFired = new Map<string, number>();
  let lastFireAt = -Infinity;
  /** 마지막 한 번짜리 활동이 끝난 시각: 결과 반응은 이 뒤 여운만큼 기다린다 */
  let oneShotEndedAt = -Infinity;
  /** 머무름으로 지금 활동을 붙잡아 둔 끝 시각. 결과 반응은 이 뒤에(마무리 중에 떨지 않게) */
  let holdUntil = -Infinity;
  /** 머무름 때문에 밀린 한 번짜리 도구 활동(발도장): 짧은 도구라도 꼭 한 번은 보여 준다 */
  let owed: NekoPlan | null = null;
  let timer: unknown = null;
  let inUpdate = false;
  let dirty = false;
  let disposed = false;
  const entries: SchedulerLogEntry[] = [];
  const log = (what: string) => { entries.push({ t: clock.now(), what }); if (entries.length > 400) entries.shift(); };

  const offs = [
    ctrl.on("activity", (a) => {
      // 엔진이 활동을 끝냄(한 번짜리가 끝났거나, 잡혀서 그만둠). 우리가 시킨 act() 로 바뀐 건 무시
      if (a === null && cur && cur.endedAt === null) {
        cur.endedAt = clock.now();
        if (cur.oneShot) oneShotEndedAt = cur.endedAt;
        log(`끝남 ${cur.activity}`);
      }
      if (inUpdate) dirty = true; else update();
    }),
    // 엔진이 곁들임을 끝냄(또는 거절). 적어만 둔다 — 다음 계획 적용 때 맞춘다(여기서 다시 보내면 거절과 핑퐁)
    ctrl.on("side", (a) => { sentSide = a; }),
    ctrl.on("grab", () => { grabbed = true; log("잡힘"); }),
    ctrl.on("drop", () => {
      grabbed = false;
      settleUntil = clock.now() + DROP_SETTLE_MS; // 털기가 끝날 때쯤 다시
      log("놓임");
      schedule(settleUntil);
    }),
  ];

  const running = () => !!cur && cur.endedAt === null && ctrl.activity === cur.activity;
  const dwellMsOf = (p: NekoPlan) =>
    p.layer === "ambient" ? AMBIENT_DWELL_MS : p.layer === "tool" || p.layer === "answer" || p.layer === "outside" ? WORK_DWELL_MS : DWELL_MS;

  function start(p: NekoPlan, now: number) {
    if (p.activity === null) return;
    ctrl.act(p.activity);
    cur = { activity: p.activity, startedAt: now, oneShot: p.oneShot, dwell: p.dwell, dwellMs: dwellMsOf(p), layer: p.layer, finishFrom: null, instance: p.instance, endedAt: null };
    log(`활동 ${p.activity}`);
  }

  function setLook(p: NekoPlan) {
    if (applied.mood !== p.mood) { ctrl.setMood(p.mood); applied.mood = p.mood; }
    if (applied.wander !== p.wander) { ctrl.setWander(p.wander); applied.wander = p.wander; }
  }

  function setPose(p: NekoPlan) {
    if (applied.pose !== p.pose) { ctrl.setPose(p.pose); applied.pose = p.pose; }
  }

  /** 반응 하나를 낸다. 같은 반응은 REACT_DEDUPE_MS 안에 한 번만 */
  function fire(r: Reaction, now: number) {
    const key = r.type === "react" ? r.kind : `tail:${r.sign}`;
    const prev = lastFired.get(key);
    lastFired.set(key, now);
    if (prev !== undefined && now - prev < REACT_DEDUPE_MS) return false;
    if (r.type === "react") ctrl.react(r.kind); else ctrl.tail(r.sign, r.sec);
    log(`반응 ${key}`);
    return true;
  }

  /** 때가 된 반응을 낸다(반응끼리는 REACT_GAP_MS 띄움). 다음에 볼 시각을 돌려준다 */
  function flush(now: number): number | null {
    let next: number | null = null;
    const want = (t: number) => { if (next === null || t < next) next = t; };
    const oneShotBusy = running() && !!cur?.oneShot;
    const keep: Queued[] = [];
    for (const q of queue) {
      if (q.dueAt > now) { keep.push(q); want(q.dueAt); continue; }
      if (q.gated && oneShotBusy) { keep.push(q); continue; } // 한 번짜리(발도장·간식)가 끝난 뒤에
      if (q.gated && now < holdUntil) { keep.push(q); want(holdUntil); continue; } // 하던 일 마무리가 끝난 뒤에
      if (q.gated && now < oneShotEndedAt + RESULT_LINGER_MS) { keep.push(q); want(oneShotEndedAt + RESULT_LINGER_MS); continue; } // …여운을 두고
      if (now < lastFireAt + REACT_GAP_MS) { keep.push(q); want(lastFireAt + REACT_GAP_MS); continue; }
      if (fire(q.r, now)) lastFireAt = now;
    }
    queue = keep;
    return next;
  }

  function schedule(t: number | null) {
    if (timer !== null) { clock.clearTimeout(timer); timer = null; }
    if (t === null || disposed) return;
    timer = clock.setTimeout(() => { timer = null; update(); }, Math.max(0, t - clock.now()));
  }

  function update() {
    if (disposed) return;
    if (inUpdate) { dirty = true; return; }
    inUpdate = true;
    try {
      do { dirty = false; step(); } while (dirty);
    } finally {
      inUpdate = false;
    }
  }

  function step() {
    const now = clock.now();
    if (grabbed) return; // 놓을 때 다시
    if (now < settleUntil) { schedule(settleUntil); return; }

    const { plan: p, recheckAt } = getPlan(now);
    let next: number | null = recheckAt;
    const want = (t: number | null) => { if (t !== null && (next === null || t < next)) next = t; };

    // 9) 깨어남: 자다가 다른 층으로 → 기지개(한 번) → 인사
    if (lastLayer === "sleep" && p.layer !== "sleep" && p.layer !== "waiting") {
      ctrl.act("stretch");
      cur = { activity: "stretch", startedAt: now, oneShot: true, dwell: false, dwellMs: DWELL_MS, layer: p.layer, finishFrom: null, instance: `wake:${now}`, endedAt: null };
      wakeGreetPending = true;
      log("깨어남 기지개");
    }
    if (lastLayer !== p.layer) log(`층 ${p.layer}`);
    lastLayer = p.layer;
    setLook(p);

    const busyOneShot = running() && cur!.oneShot;
    if (wakeGreetPending && !busyOneShot) {
      wakeGreetPending = false;
      queue.push({ r: { type: "react", kind: "greet" }, dueAt: now, gated: false });
    }

    let hold = false;
    // 4) 한 번짜리는 끝까지(기다림만 끊는다). 최대 시간이 지나면 넘어간다
    if (busyOneShot && p.activity !== cur!.activity && p.layer !== "waiting" && now < cur!.startedAt + ONE_SHOT_CAP_MS) {
      hold = true;
      want(cur!.startedAt + ONE_SHOT_CAP_MS);
    }
    // 1) 최소 머무름(기다림은 막지 않는다). 한 번짜리 도구(발도장)는 짧은 머무름 뒤에 끼어든다 — 결과 떨기보다 먼저 찍게
    else if (running() && cur!.dwell && p.activity !== cur!.activity && p.layer !== "waiting") {
      const oneShotTool = p.layer === "tool" && p.oneShot;
      let until = cur!.startedAt + (oneShotTool || owed ? DWELL_MS : cur!.dwellMs);
      // 세션 일로 하던 활동인데 일이 끝났다: 남은 머무름 대신 마무리만(FINISH_MS)
      if ((cur!.layer === "tool" || cur!.layer === "answer") && !WORK_LAYERS.has(p.layer)) {
        cur!.finishFrom ??= now;
        until = Math.min(until, cur!.finishFrom + FINISH_MS);
      } else cur!.finishFrom = null;
      if (now < until) {
        hold = true;
        holdUntil = until;
        want(until);
        if (oneShotTool) owed = p;
      }
    }
    if (!hold) holdUntil = -Infinity;

    if (!hold && owed) {
      // 밀린 발도장: 기다림이 아니고 지금 계획이 다른 한 번짜리가 아니면 먼저 찍는다
      const o = owed;
      owed = null;
      if (p.layer !== "waiting" && !(p.oneShot && p.activity !== o.activity)) {
        if (p.activity !== o.activity) { start(o, now); hold = true; want(now + ONE_SHOT_CAP_MS); }
      }
    }

    if (!hold) {
      const engineAct = ctrl.activity;
      if (p.activity === null) {
        cur = null; // 먼저 비워서 엔진의 '끝남' 알림을 우리가 끝낸 것으로 본다
        if (engineAct !== null) { ctrl.act(null); log("활동 끝냄"); }
      } else if (engineAct === p.activity) {
        // 2) 같은 활동이면 이어 간다(소품을 다시 뽑지 않음)
        if (cur && cur.activity === p.activity) { cur.instance = p.instance; cur.dwell = p.dwell; cur.dwellMs = Math.max(cur.dwellMs, dwellMsOf(p)); cur.layer = p.layer; cur.finishFrom = null; }
        else cur = { activity: p.activity, startedAt: now, oneShot: p.oneShot, dwell: p.dwell, dwellMs: dwellMsOf(p), layer: p.layer, finishFrom: null, instance: p.instance, endedAt: null };
      } else if (p.oneShot && cur && cur.activity === p.activity && cur.instance === p.instance && cur.endedAt !== null) {
        // 이 일에서 이미 한 번 했다: 되풀이면 잠깐 쉬고 다시, 아니면 그대로 둔다
        if (p.repeat) {
          if (now < cur.endedAt + REPEAT_GAP_MS) want(cur.endedAt + REPEAT_GAP_MS);
          else start(p, now);
        }
      } else {
        start(p, now); // 3) 바꾸기: act(다음) 하나면 엔진이 소품을 쏙 넣고 새 소품을 '뿅'
      }
      setPose(p);
    }

    // 12) 곁들임: 계획의 곁들임을 지금 엔진에서 도는 것(활동, 없으면 적용한 자세의 기본 상태) 위에 얹을 수 있을 때만.
    // 머무름으로 이전 활동이 도는 중이면 그 활동으로 본다. 바뀔 때만 보낸다
    const on = ctrl.activity ?? baseOf(applied.pose ?? "stand");
    const side = p.side && mixable(on, p.side).ok ? p.side : null;
    if (side !== sentSide) {
      sentSide = side;
      ctrl.mix(side);
      log(`곁들임 ${side ?? "끝"}`);
    }

    // 11) 꼬리 유지
    if (p.tailHold) {
      if (!tailHold || tailHold.sign !== p.tailHold || now >= tailHold.nextAt) {
        ctrl.tail(p.tailHold, 3);
        tailHold = { sign: p.tailHold, nextAt: now + TAIL_HOLD_EVERY_MS };
      }
      want(tailHold.nextAt);
    } else tailHold = null;

    want(flush(now));
    // 10) 타이머 하나
    schedule(next);
  }

  return {
    update,
    react(rs) {
      const now = clock.now();
      for (const r of rs) {
        const gated = r.gate === "result";
        queue.push({ r, dueAt: now + (gated ? RESULT_LINGER_MS : 0) + (r.delay ?? 0), gated });
      }
      update();
    },
    resetSession() {
      queue = [];
      owed = null;
      wakeGreetPending = false;
      tailHold = null;
      if (cur) { cur.dwell = false; cur.oneShot = false; } // 머무름·끝까지 규칙을 풀어 바로 바꾼다
      log("세션 전환");
      update();
    },
    dispose() {
      disposed = true;
      schedule(null);
      offs.forEach((f) => f());
    },
    log: () => entries.slice(),
    get layer() { return lastLayer; },
  };
}
