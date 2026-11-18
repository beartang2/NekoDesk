import { emotionPlan } from "../emotionMap";
import { resultLook } from "./session";
import { ONE_SHOT } from "./toolActivity";
import type { NekoActivity } from "../engine/neko-engine";
import type { DirectorInput, NekoLayer, NekoPlan } from "./types";

/**
 * 계획 만들기(설계 docs/neko-p2-director.md §5). 순수 함수: 지금 상황과 시각으로 보여 줄 계획 하나와,
 * 시간만 지나도 계획이 바뀌는 다음 시각(recheckAt)을 돌려준다. 위층이 이긴다.
 */

/** 도구가 끝나고 '생각'으로 가도 이만큼은 그 도구의 활동을 이어 간다(앉았다 섰다 하지 않게) */
export const THINK_GRACE_MS = 2000;
/** 생각이 이만큼 이어지면 골똘히 활동을 시작한다 */
export const THINK_DELAY_MS = 500;
/** 놀아주기: 털실·나비를 이만큼 논 뒤 게임이 이어받는다 */
export const PLAY_MS = 6000;
/** 밥을 다 먹고 행복한 여운(세수) */
export const FED_MS = 3500;
/** 결과 반응 전 여운(스케줄러와 같은 값) */
export const RESULT_LINGER_MS = 600;
/** 무활동: 졸림(식빵) → 누워 자기 */
export const SLEEPY_MS = 5 * 60_000;
export const DEEP_SLEEP_MS = 6 * 60_000;

/** 돌아다니며 하는 혼자 놀기 */
const ROAMING: ReadonlySet<string> = new Set(["yarn", "butterfly", "giftplay", "climb"]);
/** 혼자 놀 거리(신남). 일하는 활동(타이핑·발도장·달력…)은 뺀다 */
export const SOLO: readonly NekoActivity[] = [
  "box", "yarn", "butterfly", "draw", "music", "reading", "groom", "knead", "window", "stretch", "snack", "climb",
];

/** 혼자 놀 거리 하나. 놓아 둔 선물이 있으면 그것도 조금 자주. 방금 한 것은 뺀다 */
export function pickSolo(last: NekoActivity | null, hasGifts: boolean, r = Math.random()): NekoActivity {
  const pool = [...SOLO, ...(hasGifts ? (["giftplay", "giftplay"] as const) : [])].filter((k) => k !== last);
  return pool[Math.floor(r * pool.length)];
}

function plan(layer: NekoLayer, p: Partial<NekoPlan> = {}): NekoPlan {
  return {
    layer, mood: "idle", pose: "stand", activity: null, oneShot: false, repeat: false, dwell: false,
    instance: layer, tailHold: null, wander: false, ...p,
  };
}

export interface DeriveOut {
  plan: NekoPlan;
  recheckAt: number | null;
}

export function deriveNeko(input: DirectorInput, now: number): DeriveOut {
  let recheckAt: number | null = null;
  const at = (t: number) => { if (t > now && (recheckAt === null || t < recheckAt)) recheckAt = t; };
  const out = (p: NekoPlan): DeriveOut => ({ plan: p, recheckAt });
  const s = input.session;

  // 1) 기다림: 확인·질문을 기다리는 동안은 무엇보다 먼저(밥 먹다가도)
  if (s.phase === "waiting") {
    return out(plan("waiting", { mood: "curious", pose: "sit", activity: "wait", tailHold: "question", instance: `waiting:${s.since}` }));
  }

  // 2) 밥 먹기(대화 요약 중): 끝날 때까지 냠냠(그릇이 비면 다시 채워진다)
  if (input.feeding) {
    return out(plan("meal", { activity: "meal", instance: `meal:${input.feeding.since}` }));
  }

  // 3) 에이전트
  if (s.phase === "tool" && s.tool) {
    const c = s.tool;
    // 한 번짜리(발도장)는 도구가 더 오래 걸리면 되풀이, 이어지는 활동(타이핑 등)은 최소 머무름
    return out(plan("tool", { activity: c.activity, oneShot: c.oneShot, repeat: c.oneShot, dwell: !c.oneShot, instance: `tool:${c.name}:${s.since}` }));
  }
  if (s.phase === "thinking") {
    const lt = s.lastTool;
    if (lt && now < lt.endedAt + THINK_GRACE_MS) {
      at(lt.endedAt + THINK_GRACE_MS);
      const c = lt.cue;
      return out(plan("tool", { activity: c.activity, oneShot: c.oneShot, repeat: false, dwell: !c.oneShot, instance: `tool:${c.name}:${lt.startedAt}` }));
    }
    // 골똘히는 생각이 조금 이어질 때만(곧바로 도구가 오면 앉았다 일어나기만 하고 지나가게)
    const settled = now >= s.since + THINK_DELAY_MS;
    if (!settled) at(s.since + THINK_DELAY_MS);
    return out(plan("think", { mood: "curious", pose: "sit", activity: settled ? "think" : null, instance: `think:${s.since}` }));
  }
  if (s.phase === "answering") {
    return out(plan("answer", { activity: "typing", dwell: true, instance: "answer" }));
  }
  if (s.phase === "result" && s.result) {
    const look = resultLook(s.result.kind, s.result.petState);
    const end = s.result.at + RESULT_LINGER_MS + look.holdMs;
    if (look.holdMs > 0 && now < end) {
      at(end);
      return out(plan("result", { mood: look.mood, pose: look.pose, instance: `result:${s.result.at}` }));
    }
  }

  // 밥을 다 먹은 여운
  if (input.fedAt !== null && now < input.fedAt + FED_MS) {
    at(input.fedAt + FED_MS);
    return out(plan("fed", { mood: "happy", activity: "groom", instance: `fed:${input.fedAt}` })); // 다 먹고 세수
  }

  // 4) 놀아주기: 털실·나비(게임보다 위 — 게임이 바로 덮지 않게)
  if (input.playCue && now < input.playCue.at + PLAY_MS) {
    at(input.playCue.at + PLAY_MS);
    return out(plan("play", { activity: input.playCue.kind, instance: `play:${input.playCue.at}`, wander: true }));
  }

  // 5) 게임(호환): 게임 훅이 준 감정을 표 5.1 로
  if (input.game && now < input.game.until) {
    at(input.game.until);
    const e = emotionPlan(input.game.emotion);
    return out(plan("game", { mood: e.mood, pose: e.pose, activity: e.act, instance: `game:${input.game.emotion}` }));
  }

  // 5-1) 다른 앱에서 키를 치는 중: 같이 타이핑(졸고 있었어도 — 사용자가 일하는 중이다)
  const out_ = input.outside;
  if (out_.typing) return out(plan("outside", { activity: "typing", dwell: true, instance: "outside:typing" }));

  // 6) 졸림: 사용자가 한동안 앱도 안 쓰고 다른 앱에서 키도 안 치면(배고프거나 심심해도 결국은 잔다)
  const last = Math.max(input.lastActiveAt, out_.at);
  const idleFor = now - last;
  if (idleFor >= DEEP_SLEEP_MS) return out(plan("sleep", { mood: "sleepy", pose: "lie" }));
  if (idleFor >= SLEEPY_MS) {
    at(last + DEEP_SLEEP_MS);
    return out(plan("sleep", { mood: "sleepy", pose: "loaf" }));
  }
  at(last + SLEEPY_MS);

  // 7) 배고픔·심심(표 5.4): 배고픔 낮음은 힘없음(눈은 뜸), 놀이 낮음은 심심 — 졸림과 나눈다
  const { hunger, play } = input.needs;
  if (hunger < 10) return out(plan("weak", { pose: "loaf" }));
  if (hunger < 30) return out(plan("hungry", { pose: "sit", activity: "hungry" })); // 빈 그릇 앞에서 기다리기
  if (play < 20) return out(plan("bored", { pose: "loaf" }));

  // 8) 신남: 혼자 논다(상자에 쏙·털실·나비 중 하나)
  if (input.box) {
    const k = input.box.kind ?? "box";
    // 돌아다니는 놀이(털실·나비·선물)만 산책을 켠다. 한 번짜리(간식·기지개·벽 타기)는 한 번 하고 그친다
    return out(plan("box", { activity: k, instance: `box:${input.box.since}`, wander: ROAMING.has(k), oneShot: ONE_SHOT.has(k) }));
  }

  // 8-1) 다른 앱 따라 하기: 맨 앞 앱·음악에 맞춘 활동(그림 앱이면 그리기, 음악이 나오면 음악 듣기…)
  if (out_.activity) {
    const k = out_.activity;
    return out(plan("ambient", { activity: k, dwell: true, wander: ROAMING.has(k), instance: `ambient:${k}` }));
  }

  // 9) 기본: 서서 산책
  return out(plan("base", { wander: true }));
}
