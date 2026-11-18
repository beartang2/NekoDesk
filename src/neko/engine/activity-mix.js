/**
 * 활동 겹치기(설계 docs/neko-activity-mix.md 1부). 엔진과 감독이 같이 쓰는 순수 모듈 — 엔진 상태를 안 쓴다.
 *
 * 활동마다 몸의 어디를 쓰는지 선언한다. 차지함(hold) = 그 부위 값은 이 활동이 정한다, 얹음(ride) = 비어 있으면 자기 값을 쓰고
 * 다른 쪽이 차지하면 양보하며 overlay 의 차이만 더한다. 주 활동이 없을 땐 기본 상태(base:stand·sit·loaf·lie)가 아래쪽이 된다.
 */

export const PARTS = ["body", "move", "paws", "head", "ears", "mouth", "tail"];
const PART_NAME = { body: "몸", move: "이동", paws: "앞발", head: "머리", ears: "귀", mouth: "입", tail: "꼬리" };

/** 엔진이 읽는 pose() 키 → 부위(§1.3). 여기 없는 키가 pose() 에 생기면 QA 가 실패한다 */
export const POSE_PART = {
  sit: "body", loaf: "body", tilt: "body", dy: "body", sq: "body", pos: "body", bend: "body", bendW: "body",
  feet: "paws", feetW: "paws", reach: "paws", pawFront: "paws", pawBeans: "paws",
  head: "head", tt: "head", look: "head", expr: "head", lid: "head",
  ear: "ears",
  tail: "tail",
};
/** overlay 가 더할 수 있는 키. 엔진은 값을 다 정한 뒤에 더한다(tail 은 꼬리 끝 각도, 도) */
export const ADD_KEYS = ["tt", "ear", "sq", "tilt", "dy", "tail"];

const words = (s) => (s ? s.split(" ") : []);
/** 보통 활동: 귀는 얹음(표정을 조금 보태는 정도라 헤드폰에 양보한다) */
const act = (hold, stance, slots = "") => ({ hold: words(hold), ride: ["ears"], stance, slots: words(slots) });

export const MIX = {
  draw: act("body paws head tail", "sit", "floor"),
  music: {
    hold: ["ears"],                   // 헤드폰이 귀를 누른다
    ride: ["head", "tail", "body"],   // 고개 까딱·꼬리 박자·몸 통통
    stance: "sit",                    // 주 활동일 때는 앉아서 듣는다
    role: "both",
    slots: ["head"],
    with: "음악 들으며",
    notWith: ["base:lie"],            // 누워 깊이 잘 때는 벗는다
  },
  butterfly: act("body move paws head tail", "move", "air"),
  snack: act("body head mouth", "stand", "floor"),
  stretch: act("body paws head tail", "stand"),
  typing: act("body paws head tail", "sit", "floor"),
  reading: act("body paws head tail", "sit", "floor"),
  stamp: act("body paws head tail", "sit", "floor"),
  groom: act("body paws head mouth tail", "sit"),
  knead: act("body paws head tail", "stand", "floor"),
  yarn: act("body move paws head tail", "move", "floor"),
  giftplay: act("body move paws head mouth tail", "move", "decor"),
  box: act("body paws head tail", "loaf", "floor"),
  window: act("body head tail", "sit", "wall"),
  think: act("body paws head tail", "sit"),
  wait: act("body paws head tail", "sit"),
  meal: act("body head mouth", "stand", "floor"),
  hungry: act("body paws head tail", "sit", "floor"),
  dig: act("body paws head tail", "stand", "floor"),
  calendar: act("body paws head tail", "sit", "floor"),
  erase: act("body paws head tail", "sit", "floor"),
  climb: act("body move paws head tail", "move", "wall"),
  // 기본 상태: 활동이 없을 때 고양이가 하는 일. 잡힘·점프 같은 잠깐 상태는 서기로 본다
  "base:stand": { hold: ["body", "move"], ride: ["head", "ears", "tail"], stance: "move" },
  "base:sit": { hold: ["body"], ride: ["head", "ears", "tail"], stance: "sit" },
  "base:loaf": { hold: ["body"], ride: ["head", "ears", "tail"], stance: "loaf" },
  "base:lie": { hold: ["body", "head"], ride: ["ears", "tail"], stance: "lie" },
};

/** 선언이 없는 활동은 전부 차지한다(지금처럼 혼자) */
const ALL = Object.freeze({ hold: PARTS, ride: [], stance: "stand", slots: [] });

/** 감독의 계획 자세(stand·sit·loaf·lie) → 기본 상태 키 */
export const baseOf = (pose) => `base:${pose}`;

/** look(key) 는 엔진이 넘기는 선언 찾기(defineActivity 의 spec.mix). 없으면 MIX, 그것도 없으면 전부 차지함 */
const declOf = (key, look) => (look && look(key)) || MIX[key] || ALL;

/**
 * 같이 할 수 있나. on = 주 활동 키(없으면 기본 상태 키), side = 곁들임. 처음 걸리는 이유를 돌려준다(§1.5).
 * @returns {{ ok: boolean, why: string }}
 */
export function mixable(on, side, look) {
  if (!on || !side) return { ok: false, why: "없음" };
  if (on === side) return { ok: false, why: "같은 활동" };
  const a = declOf(on, look), b = declOf(side, look);
  if (b.role !== "both") return { ok: false, why: "곁들임 아님" };
  if ((a.notWith || []).includes(side) || (b.notWith || []).includes(on)) return { ok: false, why: "같이 안 함" };
  const both = a.hold.filter((p) => b.hold.includes(p));
  if (both.length) return { ok: false, why: `부위: ${both.map((p) => PART_NAME[p]).join("·")}` };
  if (b.needs && !b.needs.includes(a.stance || "stand")) return { ok: false, why: "자세" };
  const slot = (a.slots || []).find((s) => (b.slots || []).includes(s));
  if (slot) return { ok: false, why: `소품 자리: ${slot}` };
  return { ok: true, why: "" };
}

/**
 * 자세 합치기(§1.6). 부위마다 차지한 쪽 값을 쓰고, 아무도 차지하지 않은 부위는 아래쪽(onPose) 값을 쓴다(없으면 엔진 기본값).
 * 곁들임의 overlay 차이는 add 에 모은다 — 엔진이 값을 다 정한 뒤 더한다.
 * onPose 는 기본 상태거나 아직 활동 자세가 아니면 null 이다.
 */
export function mergePose(on, side, onPose, sidePose, sideAdd, look) {
  const b = declOf(side, look), out = { ...(onPose || {}) };
  for (const k of Object.keys(out)) if (b.hold.includes(POSE_PART[k])) delete out[k]; // 곁들임이 차지한 부위는 비운다
  if (sidePose) for (const k of Object.keys(sidePose)) if (b.hold.includes(POSE_PART[k])) out[k] = sidePose[k];
  const add = { ...(out.add || {}) };
  if (sideAdd) for (const k of ADD_KEYS) if (sideAdd[k]) add[k] = (add[k] || 0) + sideAdd[k];
  out.add = add;
  return out;
}

/** 시험·문서용: 아래쪽(활동 + 기본 상태) × 곁들임(활동)의 가능·불가 표 한 줄씩 */
export function mixTable(look) {
  const acts = Object.keys(MIX).filter((k) => !k.startsWith("base:"));
  const lines = [];
  for (const on of Object.keys(MIX)) for (const side of acts) {
    if (on === side) continue;
    const r = mixable(on, side, look);
    if (r.ok || declOf(side, look).role === "both") lines.push(`${on} + ${side}: ${r.ok ? "가능" : `불가(${r.why})`}`);
  }
  return lines;
}
