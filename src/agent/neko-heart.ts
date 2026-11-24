import { settingsApi } from "../api/tauri";

/**
 * 네코의 속마음(docs/neko-heart.md — 사용자: 최근 관심사·교양·철학·성격·가치관·정체성, 알게 된 사실은 기억으로). 동기화 설정 키
 * neko_heart2 에 둔다(맥·폰 같이, 마이그레이션 16). 0.1.30–0.1.31 의 neko_heart(옛 갈래)는 새 키가 없을 때 한 번 옮겨 오고 쓰지 않는다 —
 * 옛 버전은 모르는 갈래를 버리고 다시 써 새 갈래가 사라지기 때문이다. 여기는 데이터·검사·재료 글만 — 굳히기(모델 호출)는 heart-fold.ts.
 */

export const HEART_KEY = "neko_heart2";
/** 0.1.30–0.1.31 의 키. 옛 버전 기기는 계속 이걸 쓴다 */
const OLD_KEY = "neko_heart";
export const TRAIT_KINDS = ["interest", "culture", "philosophy", "temper", "value", "identity", "secret"] as const;
export type TraitKind = (typeof TRAIT_KINDS)[number];
export const TRAIT_NAME: Record<TraitKind, string> = {
  interest: "관심사", culture: "교양", philosophy: "철학", temper: "성격", value: "가치관", identity: "정체성", secret: "비밀",
};
/** 옛 갈래 → 새 갈래(옮겨 올 때만). 맞는 갈래는 첫 굳히기가 바로잡는다(review) */
const OLD_KIND: Record<string, TraitKind> = { like: "interest", dislike: "value", habit: "temper", fear: "temper", rule: "value", secret: "secret" };

export interface Trait {
  id: string;
  kind: TraitKind;
  /** 한 줄(LINE_MAX) */
  text: string;
  /** 처음 굳은 날(YYYY-MM-DD) */
  since: string;
  /** 마지막으로 다시 확인한 날 */
  at: string;
  /** 뒷받침한 사건 수 */
  n: number;
  /** 비밀만: 털어놓은 날. 없으면 아직 */
  told?: string;
}
export interface NekoHeart {
  v: 2;
  traits: Trait[];
  /** 이때(ISO)까지의 노트는 굳혔다 — 생각하기 재료에서 뺀다 */
  folded?: string;
  /** 마지막으로 굳힌 날(YYYY-MM-DD) — 하루 한 번, 맥·폰 같이 센다 */
  day?: string;
  /** 옛 키에서 옮겨 와 아직 한 번 훑지 않았다 — 첫 굳히기가 줄마다 갈래를 바로잡거나 기억으로 옮긴다(heart-fold) */
  review?: true;
}

export const TRAITS_MAX = 40;
export const SECRETS_MAX = 5;
export const LINE_MAX = 60;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const line = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, LINE_MAX) : "");
const isKind = (v: unknown): v is TraitKind => typeof v === "string" && (TRAIT_KINDS as readonly string[]).includes(v);

/**
 * 저장된 값 → 속마음. 모르는 갈래·망가진 줄·겹친 id 는 버리고, 상한을 넘으면 사건 수가 적은 것부터 뺀다. old = 옛 키의 값 —
 * 갈래를 OLD_KIND 로 바꾸고 review 를 붙인다(굳힌 날은 안 가져온다: 그날도 훑게)
 */
export function parseHeart(raw: string | null, old = false): NekoHeart {
  let p: unknown;
  try { p = raw ? JSON.parse(raw) : null; } catch { p = null; }
  const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const traits = (Array.isArray(o.traits) ? o.traits : []).flatMap((x): Trait[] => {
    const r = (x ?? {}) as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.slice(0, 16) : "", text = line(r.text);
    const kind = old ? OLD_KIND[String(r.kind)] : isKind(r.kind) ? r.kind : undefined;
    if (!id || seen.has(id) || !kind || !text) return [];
    seen.add(id);
    const since = typeof r.since === "string" && DAY.test(r.since) ? r.since : "";
    const at = typeof r.at === "string" && DAY.test(r.at) ? r.at : since;
    if (!since) return [];
    const n = Number.isInteger(r.n) && (r.n as number) > 0 ? (r.n as number) : 1;
    const told = kind === "secret" && typeof r.told === "string" && DAY.test(r.told) ? { told: r.told } : {};
    return [{ id, kind, text, since, at, n, ...told }];
  });
  const folded = typeof o.folded === "string" && !Number.isNaN(Date.parse(o.folded)) ? { folded: o.folded } : {};
  const day = !old && typeof o.day === "string" && DAY.test(o.day) ? { day: o.day } : {};
  const review = old || o.review === true ? { review: true as const } : {};
  return { v: 2, traits: trim(traits), ...folded, ...day, ...review };
}

/** 상한: 속마음 TRAITS_MAX, 안 털어놓은 비밀 SECRETS_MAX. 넘으면 사건 수가 적고 오래 확인 안 된 것부터 뺀다 */
function trim(traits: Trait[]): Trait[] {
  const rank = (t: Trait) => `${String(t.n).padStart(4, "0")}${t.at}`;
  const keep = new Set([...traits].sort((a, b) => rank(b).localeCompare(rank(a))).slice(0, TRAITS_MAX).map((t) => t.id));
  let secrets = 0;
  return traits.filter((t) => keep.has(t.id) && !(t.kind === "secret" && !t.told && ++secrets > SECRETS_MAX));
}

let cache: NekoHeart = { v: 2, traits: [] };
/** 마지막으로 읽거나 쓴 속마음(재료를 만드는 mindMaterial 은 동기라 이걸 본다 — loadMind 가 같이 읽는다) */
export const heartNow = (): NekoHeart => cache;

export async function loadHeart(): Promise<NekoHeart> {
  const raw = await settingsApi.get(HEART_KEY).catch(() => null);
  const old = raw == null ? await settingsApi.get(OLD_KEY).catch(() => null) : null;
  cache = raw != null ? parseHeart(raw) : old ? parseHeart(old, true) : { v: 2, traits: [] };
  return cache;
}

/** 지금 저장된 값(다른 기기에서 온 것 포함)을 읽어 이번 바꿈만 얹고 쓴다 */
export async function updateHeart(fn: (h: NekoHeart) => NekoHeart): Promise<NekoHeart> {
  const next = parseHeart(JSON.stringify(fn(await loadHeart())));
  cache = next;
  await settingsApi.set(HEART_KEY, JSON.stringify(next)).catch(() => {});
  return next;
}

/** 설정에서 속마음 한 줄 지우기(사용자 결정: 고치지는 않고 지우기만) */
export const removeTrait = (id: string) => updateHeart((h) => ({ ...h, traits: h.traits.filter((t) => t.id !== id) }));

/** 비밀을 털어놓았다(첫마디에서) */
export const markTold = (id: string, day: string) =>
  updateHeart((h) => ({ ...h, traits: h.traits.map((t) => (t.id === id && t.kind === "secret" && !t.told ? { ...t, told: day } : t)) }));

export const untoldSecrets = (h: NekoHeart): Trait[] => h.traits.filter((t) => t.kind === "secret" && !t.told);

/** 굳힌 뒤의 노트만(at 이 folded 뒤) */
export const unfolded = <T extends { at: string }>(notes: T[], h: NekoHeart = cache): T[] =>
  h.folded ? notes.filter((n) => Date.parse(n.at) > Date.parse(h.folded!)) : notes;

const mdOf = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/**
 * 재료 글 "나는 이런 고양이". secrets: all = 안 털어놓은 비밀도 내용까지(자기 마음 — 생각하기·첫마디·굳히기), told = 털어놓은 것만
 * (산책 일지·채팅 도구 — 사용자가 보거나 듣는 글). max = 사건 수 많은 순 몇 개. ids = 굳히기가 가리킬 번호를 붙인다
 */
export function heartLines(h: NekoHeart, o: { secrets: "all" | "told"; max?: number; ids?: boolean }): string {
  const shown = h.traits.filter((t) => o.secrets === "all" || t.kind !== "secret" || t.told)
    .sort((a, b) => b.n - a.n || b.at.localeCompare(a.at)).slice(0, o.max ?? TRAITS_MAX);
  return shown.map((t) => {
    const kind = t.kind === "secret" ? (t.told ? "비밀(털어놓음)" : "비밀(아직 말 안 함)") : TRAIT_NAME[t.kind];
    return `- ${o.ids ? `${t.id} ` : ""}[${kind}] ${t.text} (사건 ${t.n}번, ${mdOf(t.since)}부터${t.at !== t.since ? `, 마지막 ${mdOf(t.at)}` : ""})`;
  }).join("\n");
}
