import type { NekoActivity, NekoController, NekoGiftPlay } from "./engine/neko-engine";
import { MIX } from "./engine/activity-mix";
import { ACT_LABEL, GIFT_HOWS, PLACE_KEYS } from "./actLabels";
import { useNekoNeeds } from "./director/needsStore";
import { soloBlock, SOLO_KEYS } from "./director/needs";
import { ONE_SHOT } from "./director/toolActivity";
import { useNekoApp } from "./director/stores";
import { bigState } from "./presence";
import { noteMoment } from "./selfState";
import { PLACE_NAME, useNekoGifts, type NekoGift } from "./gifts";
import { useNekoStore, type NekoPlacement } from "./nekoStore";
import { FURNITURE_NAME, useNekoFurniture } from "./furniture";
import { errandNow, startErrand } from "./nekoErrand";
import { IS_PHONE } from "../lib/platform";
import { josa, roParticle } from "../lib/hangul";

/**
 * 네코가 자기 행동을 직접 한다(0.1.32 고르기 → 0.1.33 시키는 일, 사용자: 시키는 행동 실행). 모델이 사용자 말을 이해하고 이 도구를
 * 부른다 — 코드는 말을 낱말로 가르지 않고(키워드 라우팅 없음) 되는지·왜 안 되는지만 본다. 할 수 있는 것:
 *
 * - 혼자 놀기(act): 혼자 놀기 후보(SOLO_KEYS) 중 지금 이 자리에서 되는 것. 감독의 '고른 활동'으로 들어가 하던 일을 마친 뒤 한다.
 *   상자 가구가 없으면 상자 놀이는 임시 상자를 가져와 들어간다 — 결과 글에 그 사실을 적는다(사용자 결정)
 * - 다른 장소로 가기(go): 방·거실·마당(폰은 마당이 없다). 걸어 나가 반대쪽에서 걸어 들어온다(neko/nekoErrand)
 * - 선물 다루기(gift + how): 놓인 선물 하나로 냄새 맡기·치기·굴리기·위에 앉기·물기는 지금 자리에 있는 것만, bring 은 물고 다른
 *   장소로 옮기거나(지금 자리 선물) 다른 자리 선물을 물어 온다. 없는 물건을 새로 만들지는 않는다(그건 산책 선물 몫)
 * - 가구에서 놀기(furniture + act): 이 자리에 놓인 가구 하나와 그 가구가 내주는 놀이
 *
 * 대상은 이름 맞추기가 아니라 neko.self 가 보이는 목록의 id 로 고른다. 목록은 이름·자리를 앞에, id 는 줄 끝 따로 떨어진 칸에 둔다 —
 * id 는 도구 호출에만 쓰고 사용자에게 말하지 않는다(사용자). 자는 중·산책·밥·잡힘·숨김이면 아무것도 못 한다. 맥·폰 같다.
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

/**
 * 지금 무대의 가구(엔진). 마당(화면 자리)의 엔진은 대리(remoteNeko Proxy)라 모르는 칸을 물으면 배열 대신 함수를 돌려준다 —
 * 그대로 .map 하면 "i.map is not a function" 으로 neko.self 가 통째로 실패했다(0.1.32, 사용자). 배열일 때만 믿는다(마당엔 가구가 없다)
 */
function stageFurniture(): { id: string; kind: string; uses: string[] }[] {
  const c = ctrlNow as unknown as { furniture?: unknown } | null;
  const list = (Array.isArray(c?.furniture) ? c.furniture : []) as { id?: unknown; kind?: unknown; uses?: unknown }[];
  return list.flatMap((f) => (typeof f?.kind === "string"
    ? [{ id: String(f.id ?? ""), kind: f.kind, uses: Array.isArray(f.uses) ? f.uses.filter((u): u is string => typeof u === "string") : [] }]
    : []));
}

/**
 * 조명 놀이는 켜기·끄기 구분 없이 앞발로 한 번 톡이다 — 결과에 지금 상태와 바뀔 상태를 적는다(사용자: 조명을 끄라 했는데 켜졌는지
 * 몰라 지어냈다). 켜짐은 가구 항목의 lamp 칸(맥·폰 같이, furniture.ts)
 */
function lampNote(key: string): string {
  if (key !== "lamp") return "";
  const l = useNekoFurniture.getState().items.find((f) => f.kind === "lamp" && f.place?.at === here());
  return l ? (l.lamp ? " — 켜진 조명을 끄러 간다(한 번 톡)" : " — 꺼진 조명을 켜러 간다(한 번 톡)") : "";
}

/** 상자 가구 없이 상자 놀이: 엔진이 임시 상자를 가져와 들어간다(사용자 결정 — 막지 않고 결과에 사실을 적는다) */
const tempBox = (key: string) => key === "box" && !stageFurniture().some((f) => f.kind === "box");

/** 활동마다 지금 되는지와 안 되는 까닭 */
export function actOptions(): { key: NekoActivity; why: string | null }[] {
  const all = stateBlock();
  const c = ctrlNow as unknown as { decorCount?: unknown; towerOk?: unknown } | null;
  const furn = stageFurniture();
  const where = {
    hasGifts: typeof c?.decorCount === "number" && c.decorCount > 0, towerOk: c?.towerOk === true,
    furniture: furn.map((f) => f.kind), furnitureUses: furn.flatMap((f) => f.uses), lampWant: true,
  };
  const energy = useNekoNeeds.getState().needs.energy;
  return SOLO_KEYS.map((key) => {
    const fills = (MIX as Record<string, { fills?: { energy?: number } }>)[key]?.fills;
    const tired = (fills?.energy ?? 0) < 0 && energy < ENERGY_MIN ? `기운이 없어(기운 ${Math.round(energy)})` : null;
    return { key, why: all ?? (tempBox(key) ? null : soloBlock(key, where)) ?? tired };
  });
}

const name = (k: string) => `${ACT_LABEL[k] ?? k}(${k})`;

// ── 장소·선물·가구 ────────────────────────────────────────────────────────────

const PLACE_OF: Record<string, NekoPlacement> = { room: "sidebar", living: "dock", yard: "screen" };
const KEY_OF: Record<NekoPlacement, string> = { sidebar: "room", dock: "living", screen: "yard" };
/** 이 기기에서 갈 수 있는 곳(폰은 마당이 없다) */
const placesOk = (): NekoPlacement[] => (IS_PHONE ? ["sidebar", "dock"] : ["sidebar", "dock", "screen"]);
const here = (): NekoPlacement => useNekoStore.getState().stage.placement;
const placeTo = (p: NekoPlacement) => `${PLACE_NAME[p]}${roParticle(PLACE_NAME[p])}`;

const HOW_PLAY: Record<string, NekoGiftPlay> = { sniff: "sniff", bat: "bat", roll: "roll", sit_on: "sit_on", bite: "carry" };
const HOW_NAME: Record<string, string> = { sniff: "냄새 맡기", bat: "치기", roll: "굴리기", sit_on: "위에 앉기", bite: "물기", bring: "물어 옮기기" };
const SURFACE_NAME: Record<string, string> = { floor: "바닥", wall: "벽", furniture: "가구 위" };
const mdOf = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()}`; };
const giftName = (g: NekoGift) => `'${g.title.slice(0, 30)}'`;
/** 따옴표 친 이름 + 조사(조사는 이름 글자로 고른다 — 따옴표에 붙이면 '(을)를' 이 된다) */
const giftJ = (g: NekoGift, pair: Parameters<typeof josa>[1]) => { const t = g.title.slice(0, 30); return `'${t}'${josa(t, pair).slice(t.length)}`; };
/** 놓인 선물(이 기기에서 갈 수 있는 곳의 것)만 — 선물함에 넣어 둔 건 다룰 수 없다 */
const placedGifts = () => useNekoGifts.getState().gifts.filter((g) => g.placed && placesOk().includes(g.placed.at));

/** 자유 가구 쓰임새 → 그 놀이 */
const USE_ACT: Record<string, NekoActivity> = { perch: "fperch", inside: "fhide", scratch: "fscratch", bat: "fbat" };
const BASE_ACTS = new Set<string>(["lamp", "cattower", "wheel", "sofa", "box", "table"]);
function furnActs(f: { kind: string; uses: string[] }): NekoActivity[] {
  if (f.kind === "free") return f.uses.flatMap((u) => (USE_ACT[u] ? [USE_ACT[u]] : []));
  return BASE_ACTS.has(f.kind) ? [f.kind as NekoActivity] : [];
}
function furnName(f: { id: string; kind: string }): string {
  const item = useNekoFurniture.getState().items.find((x) => x.id === f.id);
  return item?.title ? `'${item.title}'` : FURNITURE_NAME[f.kind as keyof typeof FURNITURE_NAME] ?? f.kind;
}

/** 제 상태 보기(neko.self)에 싣는 글: 지금 할 수 있는 것. 이름·자리가 앞, id 는 줄 끝 칸(도구 호출에만) */
export function actOptionsText(): string {
  const block = stateBlock();
  const ok = actOptions().filter((o) => !o.why).map((o) => name(o.key));
  const first = ok.length ? ok.join(", ") : `없음(${block ?? "이 자리에서 되는 놀이가 없어"})`;
  if (block) return first;
  const lines = [first];
  const go = placesOk().filter((p) => p !== here()).map((p) => `${PLACE_NAME[p]}(${KEY_OF[p]})`);
  if (go.length) lines.push(`갈 수 있는 곳(go): ${go.join(", ")}`);
  const gifts = placedGifts();
  if (gifts.length) {
    lines.push(`놓인 선물(gift + how: ${GIFT_HOWS.join("·")} — 다른 자리 선물은 bring 만):`);
    for (const g of gifts.slice(0, 20)) {
      lines.push(`- ${giftName(g)} — ${PLACE_NAME[g.placed!.at]} ${SURFACE_NAME[g.placed!.surface] ?? ""}, ${mdOf(g.at)} 받음 | id=${g.id}`);
    }
  }
  const furn = stageFurniture().filter((f) => furnActs(f).length);
  if (furn.length) {
    lines.push("이 자리 가구(furniture + act):");
    for (const f of furn) lines.push(`- ${furnName(f)} — ${furnActs(f).join("·")} | id=${f.id}`);
  }
  return lines.join("\n");
}

// ── 하기 ─────────────────────────────────────────────────────────────────────

function chooseNow(key: NekoActivity): void {
  useNekoApp.getState().choose(key, ONE_SHOT.has(key) ? CHOSEN_ONE_SHOT_MS : CHOSEN_MS);
}

function playAct(key: string): string {
  const opt = actOptions().find((o) => o.key === key);
  if (!opt) return `모르는 행동: ${key || "(없음)"}. 지금 할 수 있는 것: ${actOptionsText()}`;
  if (opt.why) return `${name(key)} 못 해 — ${opt.why}. 지금 할 수 있는 것: ${actOptionsText()}`;
  const temp = tempBox(key);
  chooseNow(opt.key);
  noteMoment(`직접 고름: ${ACT_LABEL[key] ?? key}${temp ? "(임시 상자)" : ""}`);
  return `고름: ${name(key)}${temp ? " — 이 자리에 가구 상자가 없어 임시 상자를 가져와 들어간다" : lampNote(key)}. 하던 말을 마치면 그 자리에서 한다`;
}

function goTo(key: string): string {
  const to = PLACE_OF[key];
  if (!to) return `모르는 곳: ${key}. 갈 수 있는 곳: ${PLACE_KEYS.join(", ")}`;
  if (!placesOk().includes(to)) return `${josa(PLACE_NAME[to], "은/는")} 이 기기에 없어`;
  const from = here();
  if (to === from) return `이미 ${PLACE_NAME[to]}에 있어`;
  void startErrand({ kind: "go", to }, () => ctrlNow, `${placeTo(to)} 가기`);
  noteMoment(`직접 고름: ${placeTo(to)} 가기`);
  return `간다: ${PLACE_NAME[from]} → ${PLACE_NAME[to]}. 하던 말을 마치면 걸어 나가 ${placeTo(to)} 걸어 들어간다`;
}

function giftDo(id: string, how: string, toKey: string): string {
  const g = useNekoGifts.getState().gifts.find((x) => x.id === id);
  if (!g) return "그 선물이 없어(목록에 없는 id). 놓인 선물은 neko.self 에 나온다";
  const nm = giftName(g);
  if (!g.placed) return `${giftJ(g, "은/는")} 선물함에 넣어 둬서 놓여 있지 않아`;
  const at = g.placed.at, cur = here();
  if (!placesOk().includes(at)) return `${giftJ(g, "은/는")} ${PLACE_NAME[at]}에 있는데 이 기기엔 ${josa(PLACE_NAME[at], "이/가")} 없어`;
  if (how === "bring") {
    const to = toKey ? PLACE_OF[toKey] : undefined;
    if (toKey && !to) return `모르는 곳: ${toKey}. 옮길 수 있는 곳: ${PLACE_KEYS.join(", ")}`;
    if (at === cur) {
      if (!to || to === cur) return `${giftJ(g, "은/는")} 이미 여기(${PLACE_NAME[cur]})에 있어. 옮길 곳(to)을 골라`;
      if (!placesOk().includes(to)) return `${josa(PLACE_NAME[to], "은/는")} 이 기기에 없어`;
      void startErrand({ kind: "fetchTo", gift: g, to }, () => ctrlNow, `${giftJ(g, "을/를")} ${placeTo(to)} 옮기기`);
      noteMoment(`직접 고름: ${giftJ(g, "을/를")} 물고 ${placeTo(to)}`);
      return `한다: ${giftJ(g, "을/를")} 물고 ${placeTo(to)} 옮긴다. 하던 말을 마치면 한다`;
    }
    if (to && to !== cur) return `${giftJ(g, "은/는")} ${PLACE_NAME[at]}에 있어. 다른 자리 선물은 지금 있는 곳(${PLACE_NAME[cur]})${roParticle(PLACE_NAME[cur])}만 물어 올 수 있어`;
    void startErrand({ kind: "fetchHere", gift: g }, () => ctrlNow, `${giftJ(g, "을/를")} 물어 오기`);
    noteMoment(`직접 고름: ${PLACE_NAME[at]}에서 ${giftJ(g, "을/를")} 물어 옴`);
    return `한다: ${PLACE_NAME[at]}에 있는 ${giftJ(g, "을/를")} 가지러 나갔다가 물고 ${placeTo(cur)} 돌아온다. 하던 말을 마치면 한다`;
  }
  const play = HOW_PLAY[how];
  if (!play) return `모르는 방식: ${how || "(없음)"}. 할 수 있는 것: ${GIFT_HOWS.join(", ")}`;
  if (at !== cur) return `${giftJ(g, "은/는")} ${PLACE_NAME[at]}에 있어(지금은 ${PLACE_NAME[cur]}). 그리로 가거나(go) 물어 오게(how bring) 해`;
  ctrlNow!.aim({ gift: g.id, play });
  useNekoApp.getState().choose("giftplay", CHOSEN_MS);
  noteMoment(`직접 고름: ${nm} ${HOW_NAME[how]}`);
  return `고름: ${nm} ${HOW_NAME[how]}. 하던 말을 마치면 그 선물로 간다(크기·기운이 안 맞으면 맞는 방식으로 논다)`;
}

function furnitureDo(id: string, act: string): string {
  const f = stageFurniture().find((x) => x.id === id);
  if (!f) return `그 가구가 이 자리(${PLACE_NAME[here()]})에 없어. 이 자리 가구는 neko.self 에 나온다`;
  const acts = furnActs(f), key = act || (acts.length === 1 ? acts[0] : "");
  if (!acts.includes(key as NekoActivity)) return `${furnName(f)}에선 ${acts.map(name).join(", ") || "할 수 있는 놀이가 없어"}`;
  const opt = actOptions().find((o) => o.key === key);
  if (opt?.why) return `${name(key)} 못 해 — ${opt.why}`;
  if (f.kind === "free") ctrlNow!.aim({ fid: f.id });
  chooseNow(key as NekoActivity);
  noteMoment(`직접 고름: ${furnName(f)}에서 ${ACT_LABEL[key] ?? key}`);
  return `고름: ${furnName(f)}에서 ${name(key)}${lampNote(key)}. 하던 말을 마치면 한다`;
}

/** neko.act: 결과 글(모델이 본다). 옛 부르기(활동 키 글)도 받는다 */
export function nekoAct(raw: unknown): string {
  const p = (typeof raw === "string" ? { act: raw } : raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
  const busy = errandNow();
  if (busy) return `아직 하던 심부름(${busy})을 하는 중이라 못 해`;
  const block = stateBlock();
  if (block && (str("go") || str("gift") || str("furniture"))) return `못 해 — ${block}`;
  if (str("go")) return goTo(str("go"));
  if (str("gift")) return giftDo(str("gift"), str("how"), str("to"));
  if (str("furniture")) return furnitureDo(str("furniture"), str("act"));
  return playAct(str("act"));
}
