import type { NekoActivity, NekoController } from "./engine/neko-engine";
import { MIX } from "./engine/activity-mix";
import { ACT_LABEL } from "./actLabels";
import { useNekoNeeds } from "./director/needsStore";
import { soloBlock, SOLO_KEYS } from "./director/needs";
import { ONE_SHOT } from "./director/toolActivity";
import { useNekoApp } from "./director/stores";
import { bigState } from "./presence";
import { noteMoment } from "./selfState";

/**
 * 네코가 자기 행동을 직접 고른다(0.1.32, 사용자: neko.self 는 보기만 — 행동을 고르고 하는 도구). 고를 수 있는 건 혼자 놀기 후보(SOLO_KEYS)
 * 중 지금 이 자리에서 실제로 되는 것뿐이다 — 감독의 후보 거르기(soloBlock: 놓인 가구·자유 가구 쓰임새·선물·갈 창)에 큰 상태(자는 중·
 * 산책·밥)·붙잡힘·숨김·기운을 더 본다. 고르면 감독의 '고른 활동'(chosen)으로 들어가 하던 일을 마친 뒤 그 자리에서 걸어가 하고, 시간이
 * 지나면 원래 흐름으로 돌아온다(순간이동 없음). 맥·폰 같고, 마당은 그 자리에서 되는 것만(가구가 없다).
 */

/** 고른 활동을 이어 하는 시간. 한 번짜리는 엔진이 스스로 끝내니 짧게 */
export const CHOSEN_MS = 150_000;
export const CHOSEN_ONE_SHOT_MS = 15_000;
/** 기운을 쓰는 놀이(채움의 기운이 음수)는 기운이 이만큼은 있어야 한다 */
export const ENERGY_MIN = 15;

/** 감독이 띄운 엔진(이 앱 무대 또는 마당 대리). 감독(useNekoDirector)이 켤 때 건다 */
let ctrlNow: NekoController | null = null;
export function setActController(c: NekoController | null): void {
  ctrlNow = c;
}

const BIG_WHY = { sleep: "자는 중이라 못 해", walk: "산책 나가 있어서 못 해", eat: "밥 먹는 중이라 못 해" } as const;

/** 지금 무엇이든 못 하는 까닭(되면 null) */
function stateBlock(): string | null {
  if (!ctrlNow) return "지금은 무대에 없어서 못 해";
  const big = bigState();
  if (big !== "awake") return BIG_WHY[big];
  const app = useNekoApp.getState();
  if (app.feeding) return BIG_WHY.eat;
  if (app.screenHidden) return "숨겨져 있어서 못 해";
  if (typeof document !== "undefined" && document.documentElement.dataset.holding) return "사용자가 잡고 있어서 못 해";
  return null;
}

/** 활동마다 지금 되는지와 안 되는 까닭 */
export function actOptions(): { key: NekoActivity; why: string | null }[] {
  const all = stateBlock();
  const c = ctrlNow as unknown as { furniture?: unknown; decorCount?: unknown; towerOk?: unknown } | null;
  // 마당(화면 자리)의 엔진은 대리(remoteNeko Proxy)라 모르는 칸을 물으면 배열 대신 함수를 돌려준다 — 그대로 .map 하면
  // "i.map is not a function" 으로 neko.self 가 통째로 실패했다(0.1.32, 사용자). 배열·숫자일 때만 믿는다(마당엔 가구가 없다)
  const furn = (Array.isArray(c?.furniture) ? c.furniture : []) as { kind?: unknown; uses?: unknown }[];
  const where = {
    hasGifts: typeof c?.decorCount === "number" && c.decorCount > 0, towerOk: c?.towerOk === true,
    furniture: furn.flatMap((f) => (typeof f?.kind === "string" ? [f.kind] : [])),
    furnitureUses: furn.flatMap((f) => (Array.isArray(f?.uses) ? f.uses.filter((u): u is string => typeof u === "string") : [])),
    lampWant: true,
  };
  const energy = useNekoNeeds.getState().needs.energy;
  return SOLO_KEYS.map((key) => {
    const fills = (MIX as Record<string, { fills?: { energy?: number } }>)[key]?.fills;
    const tired = (fills?.energy ?? 0) < 0 && energy < ENERGY_MIN ? `기운이 없어(기운 ${Math.round(energy)})` : null;
    return { key, why: all ?? soloBlock(key, where) ?? tired };
  });
}

const name = (k: string) => `${ACT_LABEL[k] ?? k}(${k})`;

/** 제 상태 보기(neko.self)에 싣는 줄: 지금 할 수 있는 것 */
export function actOptionsText(): string {
  const ok = actOptions().filter((o) => !o.why).map((o) => name(o.key));
  return ok.length ? ok.join(", ") : `없음(${stateBlock() ?? "이 자리에서 되는 놀이가 없어"})`;
}

/** neko.act: 고른 활동을 감독에 넘긴다. 결과 글(모델이 본다) */
export function nekoAct(raw: unknown): string {
  const key = typeof raw === "string" ? raw : "";
  const opt = actOptions().find((o) => o.key === key);
  if (!opt) return `모르는 행동: ${key || "(없음)"}. 지금 할 수 있는 것: ${actOptionsText()}`;
  if (opt.why) return `${name(key)} 못 해 — ${opt.why}. 지금 할 수 있는 것: ${actOptionsText()}`;
  useNekoApp.getState().choose(opt.key, ONE_SHOT.has(opt.key) ? CHOSEN_ONE_SHOT_MS : CHOSEN_MS);
  noteMoment(`직접 고름: ${ACT_LABEL[key] ?? key}`);
  return `고름: ${name(key)}. 하던 말을 마치면 그 자리에서 한다`;
}
