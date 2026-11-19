import { MIX, type NekoFills } from "../engine/activity-mix";
import type { NekoActivity } from "../engine/neko-engine";

/**
 * 숨은 게이지 넷과 욕구로 혼자 놀 거리 고르기(설계 docs/neko-activity-mix.md 2부). 순수 함수만 — 저장·틱은 needsStore.
 *
 * 기운·호기심·청결·애정, 모두 0~100. 저절로 줄고(§2.2), 활동이 채운다(MIX 의 fills, §2.3). 혼자 놀 때 무엇을 할지는
 * 모자란 욕구를 채우는 활동일수록 점수가 높고, 점수에 비례한 확률로 뽑는다(§2.4). 언제 놀지는 감독 타이머 그대로다.
 */

export type Needs = NekoFills;
export const NEED_KEYS = ["energy", "curiosity", "clean", "affection"] as const;
export type NeedKey = (typeof NEED_KEYS)[number];

export const START: Needs = { energy: 70, curiosity: 70, clean: 70, affection: 70 };
/** 애정이 이보다 낮으면 커서를 따라온다(사용자 확정: 따라오기는 애정이 낮을 때만) */
export const CHASE_BELOW = 40;
/** 대화·쓰다듬기가 이만큼 없으면 애정이 준다 */
export const LONELY_MS = 10 * 60_000;
/** 쓰다듬기 애정은 10분에 이만큼까지 */
export const PET_AFFECTION = 3;
export const PET_CAP = 15;
export const PET_WINDOW_MS = 10 * 60_000;
/** 활동 한 번(약 3분)의 채움을 1분마다 나눠 넣는다 */
export const FILL_MINUTES = 3;

/** awake 깨어 있음 · dozing 식빵 졸기 · sleeping 누워 자기 · off 앱이 꺼져 있었음(잔 것으로 본다) */
export type DecayHow = "awake" | "dozing" | "sleeping" | "off";

/** 시간당 변화(§2.2). 애정은 외로울 때만 준다 */
const PER_HOUR: Record<DecayHow, Needs> = {
  awake: { energy: -4, curiosity: -10, clean: -4, affection: -8 },
  dozing: { energy: 20, curiosity: -10, clean: -4, affection: -8 },
  sleeping: { energy: 40, curiosity: -10, clean: -4, affection: -8 },
  off: { energy: 40, curiosity: -10, clean: -4, affection: -8 },
};
/** 꺼져 있던 동안의 바닥: 오래 꺼 두었다 켜도 너무 굶주린 채 시작하지 않게. 깨어 있을 땐 0까지 */
const OFF_FLOOR: Needs = { energy: 0, curiosity: 30, clean: 40, affection: 30 };

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/** ms 동안 저절로 바뀐 값. lonely 가 아니면 애정은 그대로(꺼져 있던 동안은 늘 외롭다) */
export function decay(s: Needs, ms: number, how: DecayHow, lonely = true): Needs {
  const h = Math.max(0, ms) / 3_600_000, rate = PER_HOUR[how], out = { ...s };
  for (const k of NEED_KEYS) {
    if (k === "affection" && how !== "off" && !lonely) continue;
    const d = rate[k] * h;
    if (how === "off" && d < 0) out[k] = s[k] < OFF_FLOOR[k] ? s[k] : Math.max(OFF_FLOOR[k], s[k] + d);
    else out[k] = clamp(s[k] + d);
  }
  return out;
}

/** 활동의 채움. minutes 동안 했으면 fills × minutes / 3(한 번 = 약 3분) */
export function applyFill(s: Needs, fills: Partial<Needs> | undefined, minutes = FILL_MINUTES): Needs {
  if (!fills) return s;
  const out = { ...s };
  for (const k of NEED_KEYS) out[k] = clamp(s[k] + ((fills[k] ?? 0) * minutes) / FILL_MINUTES);
  return out;
}

/** 사건 하나(쓰다듬기·보내기·밥·산책)의 더하기 */
export function add(s: Needs, d: Partial<Needs>): Needs {
  const out = { ...s };
  for (const k of NEED_KEYS) out[k] = clamp(s[k] + (d[k] ?? 0));
  return out;
}

export const fillsOf = (key: string | null | undefined): Partial<Needs> | undefined =>
  key ? (MIX as Record<string, { fills?: Needs }>)[key]?.fills : undefined;

/**
 * 점수(§2.4): 모자란 욕구를 채우는 활동일수록 가파르게 오른다. 기운은 넘치면 쓰는 놀이, 바닥이면 쉬는 놀이.
 * play = 보이는 놀이 게이지(0–100, 낮을수록 심심함). 기운을 쓰는 놀이(털실·나비·선물…)가 심심함을 채우는 것으로 본다 —
 * 심심하면 뛰노는 놀이, 놀이가 차 있으면 다른 걸(그루밍·창밖·꾹꾹이…) 한다. 같은 '모자란 걸 채운다' 틀이다
 */
export function score(s: Needs, fills: Partial<Needs> | undefined, play?: number): number {
  const u = (v: number) => ((100 - v) / 100) ** 2;
  const e = (50 - s.energy) / 50;
  const f = fills ?? {};
  const fun = Math.max(0, -(f.energy ?? 0)); // 기운을 쓰는 만큼 노는 놀이
  const want = (f.curiosity ?? 0) * u(s.curiosity) + (f.clean ?? 0) * u(s.clean) + (f.affection ?? 0) * u(s.affection)
    + (Number.isFinite(play) ? fun * (u(play!) - 0.25) : 0); // 놀이 50 이면 그대로, 낮으면 더, 차 있으면 덜
  return Math.max(0.1, 1 + 0.15 * want + 0.06 * (f.energy ?? 0) * e);
}

/** 혼자 놀기 후보(MIX 의 solo). 놓인 선물로 노는 giftplay 는 선물이 있을 때만, 창 탐험 tower 는 갈 창이 있을 때만(ctrl.towerOk) */
export const SOLO_KEYS = Object.entries(MIX as Record<string, { solo?: boolean }>).filter(([, d]) => d.solo).map(([k]) => k as NekoActivity);

/** last = 직전 혼자 놀기, recent = 그 앞의 것들(연달아 같은 걸 안 하게), play = 보이는 놀이 게이지 */
export interface SoloWhere { last: NekoActivity | null; recent?: NekoActivity[]; hasGifts: boolean; towerOk?: boolean; play?: number }

/**
 * 후보마다 확률(합 1). 최근에 한 것(직전·그 앞)은 빼고, 선물 놀이는 놓인 선물이 있을 때만, 갈 창이 없으면 tower 는 뺀다
 * (고르면 바로 끝나 깜빡인다). 선물 놀이에 덤(×2)을 주지 않는다 — 덤 때문에 선물만 건드렸다(0.1.19, 사용자)
 */
export function soloOdds(s: Needs, o: SoloWhere): { key: NekoActivity; p: number }[] {
  const recent = new Set([o.last, ...(o.recent ?? [])]);
  const w = SOLO_KEYS
    .filter((k) => !recent.has(k) && (k !== "giftplay" || o.hasGifts) && (k !== "tower" || !!o.towerOk))
    .map((key) => ({ key, w: score(s, fillsOf(key), o.play) }));
  const sum = w.reduce((a, b) => a + b.w, 0) || 1;
  return w.map(({ key, w: x }) => ({ key, p: x / sum }));
}

/** 점수에 비례한 확률로 혼자 놀 거리 하나 */
export function pickByNeeds(s: Needs, o: SoloWhere, r = Math.random()): NekoActivity {
  const odds = soloOdds(s, o);
  let acc = 0;
  for (const { key, p } of odds) {
    acc += p;
    if (r < acc) return key;
  }
  return odds[odds.length - 1].key;
}
