import type { NekoActivity, NekoMood, NekoPose, NekoReaction, NekoTailSign } from "../../engine/neko-engine";
import type { Clock, SchedulerCtrl } from "../scheduler";

/** 가짜 시계: advance(ms) 로 시간을 흘리면 그 사이 타이머를 차례로 부른다 */
export class FakeClock implements Clock {
  t = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.seq; this.timers.set(id, { at: this.t + Math.max(0, ms), fn }); return id; }
  clearTimeout(id: unknown) { this.timers.delete(id as number); }
  advanceTo(target: number) {
    for (;;) {
      let best: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (e[1].at <= target && (!best || e[1].at < best[1].at || (e[1].at === best[1].at && e[0] < best[0]))) best = e;
      if (!best) break;
      this.timers.delete(best[0]);
      this.t = Math.max(this.t, best[1].at);
      best[1].fn();
    }
    this.t = Math.max(this.t, target);
  }
}

/** 한 번짜리 활동이 엔진에서 걸리는 시간(대략, ms) */
export const ONE_SHOT_LEN: Partial<Record<NekoActivity, number>> = { stamp: 4300, snack: 9000, stretch: 3000, climb: 6000 };
const KEEP_ON_GRAB = new Set<NekoActivity>(["music", "butterfly", "yarn"]);

/** 가짜 엔진 컨트롤러: 부른 것을 시각과 함께 적고, 한 번짜리는 정해진 시간 뒤 스스로 끝낸다 */
export class FakeCtrl implements SchedulerCtrl {
  activity: NekoActivity | null = null;
  mood: NekoMood = "idle";
  pose: NekoPose = "stand";
  wander = true;
  calls: Array<{ t: number; call: string }> = [];
  private ls = new Map<string, Set<(a?: unknown) => void>>();
  constructor(private clock: FakeClock) {}
  private emit(ev: string, a?: unknown) { this.ls.get(ev)?.forEach((f) => f(a)); }
  private rec(call: string) { this.calls.push({ t: this.clock.now(), call }); }
  on(ev: string, fn: (a: never) => void): () => void {
    const set = this.ls.get(ev) ?? new Set();
    set.add(fn as (a?: unknown) => void);
    this.ls.set(ev, set);
    return () => set.delete(fn as (a?: unknown) => void);
  }
  setMood(m: NekoMood) { this.mood = m; this.rec(`mood:${m}`); }
  setPose(p: NekoPose) { this.pose = p; this.rec(`pose:${p}`); }
  setWander(on: boolean) { this.wander = on; this.rec(`wander:${on}`); }
  tail(sign: NekoTailSign, sec?: number) { this.rec(`tail:${sign}${sec ? `:${sec}` : ""}`); }
  react(kind: NekoReaction) { this.rec(`react:${kind}`); return true; }
  act(key: NekoActivity | null) {
    if (key === this.activity) return;
    this.activity = key;
    this.rec(`act:${key}`);
    if (key && ONE_SHOT_LEN[key]) {
      const k = key, id = this.clock.now();
      this.clock.setTimeout(() => { if (this.activity === k && this.startedAt === id) this.finish(); }, ONE_SHOT_LEN[key]!);
    }
    this.startedAt = this.clock.now();
    this.emit("activity", key);
  }
  private startedAt = 0;
  /** 엔진이 활동을 스스로 끝냄 */
  finish() { this.activity = null; this.rec("end"); this.emit("activity", null); }
  grab() { this.emit("grab"); if (this.activity && !KEEP_ON_GRAB.has(this.activity)) this.finish(); }
  drop() { this.emit("drop"); }
  /** 시각(초) 붙인 호출 목록. prefix 로 거른다 */
  seen(prefix: string) { return this.calls.filter((c) => c.call.startsWith(prefix)).map((c) => `${(c.t / 1000).toFixed(1)} ${c.call}`); }
}
