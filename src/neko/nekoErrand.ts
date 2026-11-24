import type { NekoController, NekoDecorSpot, NekoEvents } from "./engine/neko-engine";
import { useNekoApp, useNekoSessions } from "./director/stores";
import { useNekoStore, type NekoPlacement } from "./nekoStore";
import { useNekoGifts, type NekoGift } from "./gifts";
import { catScreen, getRemoteNeko } from "./remoteNeko";

/**
 * 사용자가 시킨 심부름(neko.act — neko/nekoAct): 다른 장소로 가기, 선물을 물고 다른 장소로 옮기기, 다른 곳 선물을 물어 오기.
 * 순간이동 없이 걷는다 — 지금 자리 끝으로 걸어 나가고(engine leave → exit), 자리를 바꾼 뒤 반대쪽 끝에서 걸어 들어온다(enterFrom).
 * 하던 답을 마친 뒤 시작하고(감독의 고른 활동과 같은 때), 그동안 감독은 아무 활동 없이 기다린다(chosen null). 옮기는 선물은
 * 장소를 떠나는 순간 그 장소에서 빼고(선물함) 들어와 내려놓은 자리에 다시 놓는다 — 저장·동기화는 선물함 길 그대로다.
 * 엔진이 답이 없으면(시간 초과) 멈춰 있지 않고 다음 단계로 간다: 선물은 그 장소 빈 바닥에 놓인다.
 */

type Side = "left" | "right";
const other = (s: Side): Side => (s === "left" ? "right" : "left");
/** 심부름 동안 감독을 붙잡아 두는 시간(끝나면 바로 푼다) */
const HOLD_MS = 120_000;
/** 시험이 줄여 쓴다 */
export const ERRAND_T = { poll: 400, settle: 2500, step: 200, sameEngine: 400, out: 30_000, fetch: 90_000, put: 30_000, away: 1500, rest: 4000 };
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));
const randomSide = (): Side => (Math.random() < 0.5 ? "left" : "right");

export type Errand =
  | { kind: "go"; to: NekoPlacement }
  /** 지금 자리에 놓인 선물을 물고 to 로 */
  | { kind: "fetchTo"; gift: NekoGift; to: NekoPlacement }
  /** 다른 자리에 놓인 선물을 지금 자리로(다녀온다) */
  | { kind: "fetchHere"; gift: NekoGift };

let running: string | null = null;
/** 하는 중인 심부름 이름(없으면 null). 하는 동안엔 다른 행동을 안 받는다 */
export const errandNow = (): string | null => running;

const BUSY = new Set(["waiting", "tool", "thinking", "answering"]);
/** 하던 답(이 도구를 부른 턴)·네코 글쓰기를 마칠 때까지 기다린다 */
async function untilFree(): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    const busy = Object.values(useNekoSessions.getState().sessions).some((s) => BUSY.has(s.phase)) || useNekoApp.getState().writing > 0;
    if (!busy) break;
    await sleep(ERRAND_T.poll);
  }
  await sleep(ERRAND_T.settle); // 결과 표정·타이핑 마무리
}

function once<K extends keyof NekoEvents>(c: NekoController, ev: K, ms: number): Promise<NekoEvents[K] | null> {
  return new Promise((ok) => {
    let off: () => void = () => {};
    const t = setTimeout(() => { off(); ok(null); }, ms);
    off = c.on(ev, (p) => { clearTimeout(t); off(); ok(p); });
  });
}

const hold = () => useNekoApp.getState().choose(null, HOLD_MS);
function release(): void {
  const ch = useNekoApp.getState().chosen;
  if (ch && (ch.kind === null || ch.kind === "giftplay")) useNekoApp.setState({ chosen: null });
}

/** 그쪽 끝으로 걸어 나간다. 창 위·앉은 자세면 먼저 내려오고 다시 일러야 나가서 몇 번 이른다 */
async function walkOut(c: NekoController, side: Side): Promise<boolean> {
  const got = once(c, "exit", ERRAND_T.out);
  c.leave(side);
  const again = setInterval(() => c.leave(side), 2500);
  const r = await got;
  clearInterval(again);
  return r !== null;
}

/** 자리를 바꾸고 그 자리 엔진을 기다린다. 방 ↔ 거실은 같은 엔진(캔버스만 옮겨 크기가 잡힐 틈), 마당은 화면 창 대리 */
async function switchTo(place: NekoPlacement, ctrlOf: () => NekoController | null): Promise<NekoController | null> {
  const before = ctrlOf();
  const change = place === "screen" || (!!before && before === getRemoteNeko());
  useNekoStore.getState().setPlacement(place);
  if (!change) { await sleep(ERRAND_T.sameEngine); return ctrlOf(); }
  for (let i = 0; i < 40; i++) {
    await sleep(ERRAND_T.step);
    const c = ctrlOf();
    if (c && c !== before) return c;
  }
  return ctrlOf();
}

/** 선물을 물고 그쪽 끝에서 걸어 들어와 내려놓는다. 내려놓은 자리를 선물함에 적는다(마당이면 고양이가 있는 모니터) */
async function bringIn(c: NekoController, side: Side, g: NekoGift, at: NekoPlacement): Promise<void> {
  const cid = `gift:${g.id}`;
  c.carry({ id: cid, kind: "shape", shape: g.shape, size: g.size });
  const put = once(c, "put", ERRAND_T.put);
  c.enterFrom(side, { put: cid });
  const p = await put;
  const gifts = useNekoGifts.getState();
  if (p) {
    const { id: _id, ...spot } = p;
    gifts.place(g.id, spot as NekoDecorSpot, at, at === "screen" ? catScreen() : undefined);
  } else {
    c.drop(cid);
    gifts.place(g.id, "auto", at);
  }
}

async function run(job: Errand, ctrlOf: () => NekoController | null): Promise<void> {
  await untilFree();
  const c = ctrlOf();
  if (!c) return;
  if (job.kind === "go") {
    hold();
    const side = randomSide();
    await walkOut(c, side); // 못 나가도(시간 초과) 간다 — 심부름이 멈춰 있지 않게
    (await switchTo(job.to, ctrlOf))?.enterFrom(other(side));
    await sleep(ERRAND_T.rest);
    return;
  }
  const g = job.gift;
  if (job.kind === "fetchTo") {
    // 그 선물로 가서 물고 가까운 끝으로 나간다(엔진 선물 놀이 fetch)
    c.aim({ gift: g.id, fetch: true });
    useNekoApp.getState().choose("giftplay", HOLD_MS);
    const side = await once(c, "exit", ERRAND_T.fetch);
    if (!side) { c.aim(null); return; } // 못 물었다(선물이 치워짐·잡힘·자리 바뀜) — 그대로 둔다
    hold();
    useNekoGifts.getState().place(g.id, null);
    const c2 = await switchTo(job.to, ctrlOf);
    if (!c2) { useNekoGifts.getState().place(g.id, "auto", job.to); return; }
    await bringIn(c2, other(side), g, job.to);
    return;
  }
  // 다른 자리 선물: 나갔다가 물고 같은 쪽으로 돌아온다
  const here = useNekoStore.getState().stage.placement;
  hold();
  const side = randomSide();
  await walkOut(c, side);
  useNekoGifts.getState().place(g.id, null);
  await sleep(ERRAND_T.away);
  await bringIn(ctrlOf() ?? c, side, g, here);
}

/** 심부름을 뒤에서 시작한다(도구는 바로 답한다). 하나씩만 */
export function startErrand(job: Errand, ctrlOf: () => NekoController | null, label: string): Promise<void> {
  running = label;
  return run(job, ctrlOf).catch(() => {}).finally(() => { running = null; release(); });
}
