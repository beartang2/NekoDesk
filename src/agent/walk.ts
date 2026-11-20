import { memoryApi, settingsApi, shelfApi, type MapPlace } from "../api/tauri";
import { DEFAULT_CHAT_SYSTEM_PROMPT, fetchCompletionMessage } from "./llm-client";
import { runSubagent } from "./subagent";
import { saveMemory } from "./memory-merge";
import { getTool } from "./tool-registry";
import { nekoNameOf, useSettingsStore } from "../stores/settingsStore";
import { josa } from "../lib/hangul";
import { timeZone } from "../lib/time";
import type { Memory, OpenAiToolSchema, ToolName } from "./types";
import { validateShape, type GiftShape } from "../neko/engine/gift-shape";
import { useNekoGifts } from "../neko/gifts";
import { drawGift, type DrawnGift } from "./gift-draw";
import { chooseAmong, chooseWalkTopic, noteWonder } from "./neko-mind";
import { FURNITURE_KEY, FURNITURE_KINDS, parseFurniture, useNekoFurniture, type FurnitureKind } from "../neko/furniture";

/** 산책에서 가져올 수 있는 선물 종류. */
export type GiftKind = "trinket" | "place" | "weather" | "link" | "memory" | "drawing" | "game" | "furniture";

export interface WalkGift {
  kind: GiftKind;
  title: string;
  body: string;
  url?: string;
  /** drawing — 임시 보관함에 넣은 파일 이름. */
  file?: string;
  /** place — 지도에 핀으로 꽂을 장소. */
  place?: MapPlace;
  /** 주운 것·장소 기념품 — 네코 그림체로 그릴 물건 모양(검사를 거친 것). 선물함에 들어간다 */
  shape?: GiftShape;
  /** 그 물건으로 노는 방식. 없으면 엔진이 모양으로 짐작 */
  play?: string;
  /** 실제 물건 크기(small·medium·large). 없으면 medium */
  size?: string;
}

export interface WalkReport {
  /** 채팅에 보일 산책 일지(마크다운)와 선물. */
  content: string;
  /**
   * 세션 단기기억 — ChatMessage.prompt 로 들어가 이 대화의 컨텍스트에만 실린다. 기록엔 content 대신
   * 이게 실리므로 content 를 앞에 그대로 담는다(비지 않는다).
   */
  prompt: string;
  gift: WalkGift | null;
}

/**
 * 출발 전 네코의 상태 — 네코 자신의 것만(사용자 대화·기억은 안 넣는다, WALK_TOOLS 주석과 같은 이유). App 의 depart 가 모은다.
 * 산책 머리는 "참고만, 딴 데로 새도 된다"로 받고, 3번에 1번은 아예 안 받는다(주제가 한쪽으로 쏠리지 않게).
 */
export interface WalkBefore {
  /** 직전에 하던 활동(엔진 키) */
  activity?: string | null;
  /** 음악을 듣던 중 */
  music?: boolean;
  /** 듣던 곡. 짧은 호출 하나로 느낌 한 줄로만 바꿔 쓴다 — 제목은 검색(하위 에이전트)·보고에 안 넣는다 */
  track?: { title: string; artist?: string } | null;
  /** 졸다가 나왔나 */
  sleepy?: boolean;
  /** 보이는 게이지(0~100) */
  hunger?: number;
  play?: number;
  /** 출발 시각(ms) */
  at?: number;
}

export interface WalkBrain {
  /** 절대 reject 하지 않는다. abort 되면 그때까지 알아낸 것만으로 보고한다. */
  result: Promise<WalkReport>;
  abort(): void;
}

// ponytail: base 가 선물 빈도의 손잡이다. 써 보며 고친다.
const GIFTS: Record<GiftKind, { base: number; label: string; hint: string }> = {
  trinket: { base: 5, label: "주운 것", hint: "길에서 주운 작은 물건(나뭇잎·병뚜껑 같은 것). 뭘 주웠는지는 네가 정해. 그림은 선물 이름을 보고 따로 그리니 이름을 또렷하게" },
  place: { base: 3, label: "가 본 곳", hint: "지나온 곳 하나를 소개하고, 거기서 주운 기념품(나뭇잎·각설탕 같은 것)을 선물 이름으로" },
  weather: { base: 2, label: "날씨 쪽지", hint: "날씨를 보고 사용자에게 남기는 쪽지" },
  link: { base: 2, label: "읽을거리", hint: "알아본 것 중 재밌어서 가져온 읽을거리 링크" },
  memory: { base: 2, label: "떠오른 기억", hint: "사용자에 대해 기억해 둔 게 떠올라 꺼내는 얘기" },
  drawing: { base: 0.5, label: "그림", hint: "네가 그려 온 그림" },
  game: { base: 1, label: "놀이", hint: "같이 하자고 조르는 놀이(끝말잇기 같은 것). 사용자가 답해야 시작돼" },
  // 가구(docs/neko-furniture.md §5): 일주일에 한 번쯤만(최근 7일 안에 물어왔으면 보기에서 뺀다 — 사용자). 가구 탭에 들어간다
  furniture: { base: 1, label: "가구", hint: "산책하다 본 작은 가구(고양이가 올라가거나 들어가 놀 만한 것). 선물 이름은 그 가구 이름, furniture_kind 로 조명·캣타워·캣휠·소파·상자 중 무엇처럼 쓰는지" },
};
/** 산책 가구는 이만큼(일) 안에 물어왔으면 다시 안 물어온다 */
const FURNITURE_EVERY_DAYS = 7;

/** 산책 조사는 바깥 세상만 본다 — 사용자 파일·프로세스를 읽을 일이 없다. */
// 아무 주소나 여는 web.scrape 와 기억을 꺼내는 memory.search 는 뺀다 — 지켜보는 사람이 없는 동안 남의 페이지에
// 심긴 지시를 따라 기억을 바깥 주소로 실어 보낼 길이 된다. 검색어는 검색 엔진으로만 간다.
const WALK_TOOLS: ToolName[] = ["web.search", "weather.get"];

const HISTORY_KEY = "neko_gift_history";
interface GiftHistory {
  /** 최근 선물 5개. 같은 게 연달아 나오지 않게 무게를 깎는다. */
  recent: GiftKind[];
  /** 그림은 하루 한 번 — 바깥 그림 API 의 무료 한도·요금을 쓴다. */
  drawnOn?: string;
  /** 최근 선물과 날짜(생각하기 재료, 0.1.20). 옛 기록엔 없다 */
  log?: { kind: GiftKind; day: string }[];
}

/** 종류별 무게. 못 주는 건 0, 최근 5번에 나온 횟수만큼 반씩 깎는다. */
export function giftWeights(available: Record<GiftKind, boolean>, recent: GiftKind[]): Record<GiftKind, number> {
  const last = recent.slice(-5);
  const out = {} as Record<GiftKind, number>;
  for (const k of Object.keys(GIFTS) as GiftKind[]) {
    out[k] = available[k] ? GIFTS[k].base * 0.5 ** last.filter((r) => r === k).length : 0;
  }
  return out;
}

export function rollGift(weights: Record<GiftKind, number>, random: () => number = Math.random): GiftKind {
  const entries = Object.entries(weights) as [GiftKind, number][];
  let r = random() * entries.reduce((n, [, w]) => n + w, 0);
  for (const [k, w] of entries) if (w > 0 && (r -= w) < 0) return k;
  return "trinket";
}

/** 구조화 답을 툴 호출로 받는다 — Claude 가 낸 인자는 tool-calls 가 이미 JSON 으로 풀어 준다. */
const REPORT_TOOL = {
  type: "function",
  function: {
    name: "walk_report",
    description: "산책 보고를 낸다",
    parameters: {
      type: "object",
      properties: {
        learned: {
          type: "array",
          description: "이번 산책에서 알게 된 사실. 한 문장씩, 나중에 따로 읽어도 뜻이 통하게",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              impressive: { type: "boolean", description: "오래 기억해 둘 만큼 인상 깊었나. 대부분은 아니다" },
            },
            required: ["content", "impressive"],
          },
        },
        diary: { type: "string", description: "사용자에게 들려줄 짧은 산책 일지. 두세 문장, 네 말투로. 선물 얘기는 빼" },
        gift_title: { type: "string", description: "선물 이름. 짧게" },
        gift_body: { type: "string", description: "선물에 붙이는 한두 문장. 재료에 없는 사실은 지어내지 마" },
        gift_url: { type: "string", description: "선물이 링크면 알아본 것에 나온 URL 그대로" },
        drawing_prompt: { type: "string", description: "선물이 그림일 때만. 그릴 장면을 영어로 자세히" },
        next_wonder: { type: "string", description: "다음 산책에서 궁금한 것 한 줄(있으면)" },
        furniture_kind: { type: "string", enum: [...FURNITURE_KINDS], description: "선물이 가구일 때만: 조명·캣타워·캣휠·소파·상자 중 무엇처럼 쓰는지" },
      },
      required: ["learned", "diary", "gift_title", "gift_body"],
    },
  },
} as OpenAiToolSchema;

interface Structured {
  learned: { content: string; impressive: boolean }[];
  diary: string;
  gift_title: string;
  gift_body: string;
  gift_url: string;
  drawing_prompt: string;
  next_wonder: string;
  furniture_kind: string;
}

/** 산책하며 모은 것. abort 되면 그 순간의 이것으로 보고한다. */
interface Gathered {
  findings: string;
  kind: GiftKind;
  /** 코드가 마련한 선물 재료. 모델이 못 쓰고 끝나면 이게 그대로 선물 글이 된다. */
  material: string;
  place?: MapPlace;
  report?: Structured;
  file?: string;
  /** 주운 것·기념품 그림. 사용자가 돌아와 보고를 서둘러도 끊지 않는다 — 다 그려지면 선물함에 넣는다 */
  drawing?: Promise<DrawnGift | null>;
  drawn?: DrawnGift | null;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
function pick<T>(xs: T[]): T {
  return xs[Math.floor(Math.random() * xs.length)];
}

/** 설정의 "고양이 성격과 말투". 기본 프롬프트는 말투 규칙 묶음이라 성격으로 치지 않는다. */
function persona(): string {
  const p = useSettingsStore.getState().systemPrompt?.trim() ?? "";
  return p && p !== DEFAULT_CHAT_SYSTEM_PROMPT.trim() ? p : "";
}

function section(title: string, body: string): string {
  return body ? `${title}:\n${body}` : "";
}

const ACT_NAME: Partial<Record<string, string>> = {
  draw: "그림 그리기", music: "음악 듣기", reading: "신문 읽기", typing: "노트북 타이핑", box: "상자 속에 쏙 들어가 있기", window: "창밖 새 구경",
  yarn: "털실 공놀이", butterfly: "나비 쫓기", knead: "꾹꾹이", groom: "세수", snack: "간식 먹기", stretch: "기지개", climb: "벽 타기",
  dig: "상자 뒤지기", calendar: "달력 보기", think: "골똘히 생각하기", giftplay: "선물 갖고 놀기", stamp: "발도장 찍기", meal: "밥 먹기",
};
const dayPart = (h: number) => (h < 6 ? "새벽" : h < 11 ? "아침" : h < 14 ? "점심 무렵" : h < 18 ? "오후" : h < 21 ? "저녁" : "밤");

/** 출발 전 상태를 넘길지: 3번에 1번은 안 넘긴다 */
export const shareBefore = (r: number): boolean => r >= 1 / 3;

/**
 * 곡 → 느낌 한 줄("잔잔한 재즈, 비 오는 밤 같은 분위기"). 이 짧은 호출만 제목을 본다. 답에 제목·가수 이름이 섞이면 버린다 —
 * 검색 쪽은 제목을 모르니 검색어로 내보낼 수도 없다.
 */
async function musicVibe(track: { title: string; artist?: string }, signal: AbortSignal): Promise<string> {
  const turn = await fetchCompletionMessage(
    [
      { role: "system", content: "곡 제목과 가수를 받으면 그 노래의 분위기를 한국어 한 줄(30자 안쪽)로만 말해. 제목·가수 이름·가사는 쓰지 마. 모르는 곡이면 제목에서 느껴지는 분위기로." },
      { role: "user", content: track.artist ? `${track.title} — ${track.artist}` : track.title },
    ],
    {},
    undefined,
    signal
  ).catch(() => null);
  const line = (turn?.text ?? "").split("\n")[0].trim().slice(0, 60);
  const leak = [track.title, track.artist ?? ""].some((n) => n.trim().length >= 2 && line.toLowerCase().includes(n.trim().toLowerCase()));
  return leak ? "" : line;
}

/** 넘길 상태를 몇 줄로(산책 요청 안에만 — 시스템 프롬프트는 안 늘린다) */
export function beforeText(b: WalkBefore, vibe: string): string {
  const act = b.activity && b.activity !== "music" ? ACT_NAME[b.activity] : undefined;
  const lines: string[] = [];
  if (b.music || b.activity === "music") lines.push(`음악을 들으며${act ? ` ${act} 하다` : ""} 나왔어${vibe ? ` — ${vibe}` : ""}`);
  else if (act) lines.push(`${act} 하다 나왔어`);
  if (b.sleepy) lines.push("졸다가 나왔어");
  if (b.hunger != null && b.hunger < 30) lines.push("배가 좀 고파");
  if (b.play != null && b.play < 30) lines.push("좀 심심했어");
  if (b.at) lines.push(`지금은 ${dayPart(new Date(b.at).getHours())}`);
  return lines.map((l) => `- ${l}`).join("\n");
}

/** 산책 중 네코의 머리 — 스스로 알아보고, 선물을 고르고, 인상 깊은 것만 오래 기억한다. */
export function startWalkBrain(ctx: WalkCtx): WalkBrain {
  const ctrl = new AbortController();
  const g: Gathered = { findings: "", kind: "trinket", material: "" };
  const done = walk(ctx, g, ctrl.signal).catch((e) => console.warn("[walk]", e));
  // 사용자가 말을 걸면 기다리지 않는다 — 진행 중인 툴(검색·그림)은 끊기지 않으니 그 자리의 것으로 보고한다.
  const aborted = new Promise<void>((r) => ctrl.signal.addEventListener("abort", () => r(), { once: true }));
  return {
    result: Promise.race([done, aborted]).then(() => {
      const report = compose(g);
      // 그림으로 그릴 물건이면 선물함에 넣는다(설계 docs/neko-gifts.md §3). 그림이 아직이면 다 그려진 뒤에
      const gift = report.gift;
      if (gift && (g.kind === "trinket" || g.kind === "place") && g.report) {
        void (g.drawing ?? Promise.resolve(null)).catch(() => null).then((d) => {
          try { useNekoGifts.getState().add({ title: gift.title, body: gift.body, shape: d?.shape, play: d?.play, size: d?.size }); } catch { /* 선물함이 안 돼도 보고는 한다 */ }
        });
      }
      // 물어온 가구는 선물함이 아니라 가구 탭으로(설명과 함께). 다섯 가구 중 무엇처럼 쓰는지는 보고가 정했다(모르면 상자)
      if (gift && g.kind === "furniture" && g.report) {
        const kind = (FURNITURE_KINDS as readonly string[]).includes(g.report.furniture_kind) ? (g.report.furniture_kind as FurnitureKind) : "box";
        const found = new Date().toLocaleDateString("en-CA", { timeZone: timeZone() });
        void (g.drawing ?? Promise.resolve(null)).catch(() => null).then((d) =>
          useNekoFurniture.getState().add({ kind, title: gift.title, body: gift.body, ...(d?.shape ? { shape: d.shape } : {}), found }).catch(() => {}));
      }
      return report;
    }),
    abort: () => ctrl.abort(),
  };
}

interface WalkCtx {
  places: MapPlace[];
  here: { lat: number; lon: number } | null;
  /** 출발 전 상태(껐다 켜서 이어 걸을 땐 없다) */
  before?: WalkBefore | null;
  /** 시험용 난수 */
  rand?: () => number;
}

/** 최근 FURNITURE_EVERY_DAYS 일 안에 물어온 가구가 없으면 가구를 물어올 수 있다(사용자: 일주일에 한 번쯤) */
async function furnitureDue(today: string): Promise<boolean> {
  const items = parseFurniture(await settingsApi.get(FURNITURE_KEY).catch(() => null));
  const since = new Date(new Date(today).getTime() - FURNITURE_EVERY_DAYS * 86_400_000).toISOString().slice(0, 10);
  return !items.some((f) => f.found && f.found > since);
}

async function walk(ctx: WalkCtx, g: Gathered, signal: AbortSignal): Promise<void> {
  const [memories, history] = await Promise.all([
    memoryApi.list().catch((): Memory[] => []),
    settingsApi.get(HISTORY_KEY).then((raw) => (raw ? (JSON.parse(raw) as GiftHistory) : null)).catch(() => null),
  ]);
  const userMems = memories.filter((m) => m.kind !== "neko");
  const places = ctx.places.slice(0, 5).map((p) => p.name).join(", ");
  const me = persona();
  const name = josa(nekoNameOf(useSettingsStore.getState()), "이야/야");
  const before = ctx.before && shareBefore((ctx.rand ?? Math.random)()) ? ctx.before : null;
  const vibe = before?.track?.title ? await musicVibe(before.track, signal) : "";
  if (signal.aborted) return;
  const mood = section("나가기 전 네 상태(참고만 — 딴 데로 새도 돼)", before ? beforeText(before, vibe) : "");

  // 0. 생각하기(docs/neko-mind.md §6.1): 네코가 노트·알아본 주제(횟수·날짜)·기억을 보고 이번 주제를 고른다. 하위 에이전트에는
  //    그 한 줄만 간다(사용자 기억은 안 간다 — 사용자 사실이 섞인 주제는 버린다). 안 되면 지금처럼 하위 에이전트가 스스로 고른다
  const topic = await chooseWalkTopic(memories, signal, ctx.places.slice(0, 5).map((p) => p.name)).catch(() => null);
  if (signal.aborted) return;

  // 1. 스스로 알아보기 — 격리된 하위 에이전트. 과정은 버리고 요약만 받는다.
  const task = [
    `너는 사용자가 쉬는 동안 산책 나온 고양이 ${name}.`,
    section("지나온 곳", places),
    section("네 성격과 말투", me),
    mood,
    // 지난 산책에서 오래 기억해 둔 것 — 같은 주제를 또 파지 않게.
    section("전에 산책하며 알아본 것", memories.filter((m) => m.kind === "neko").slice(0, 5).map((m) => `- ${m.content}`).join("\n")),
    topic
      ? `이번엔 '${topic}'${josa(topic, "이/가").slice(topic.length)} 궁금해서 나왔어. 그걸 검색해 알아보고, 알게 된 걸 출처와 함께 짧게 알려줘. 건넬 만한 읽을거리가 있으면 그 URL 도 남겨.`
      : "지금 네가 궁금한 걸 하나 골라 검색해 알아보고, 알게 된 걸 출처와 함께 짧게 알려줘. 건넬 만한 읽을거리가 있으면 그 URL 도 남겨.",
  ].filter(Boolean).join("\n\n");
  g.findings = await runSubagent(task, signal, WALK_TOOLS).catch(() => "");
  if (signal.aborted) return;

  // 2. 선물 — 무엇을 가져갈지는 네코가 고른다(생각하기, docs/neko-mind.md §6.2). 안 되면 지금처럼 코드가 굴린다.
  //    재료는 코드가 마련한다. 모델은 글만 쓴다.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timeZone() });
  const imageGen = useSettingsStore.getState().imageGen;
  const available: Record<GiftKind, boolean> = {
    trinket: true,
    game: true,
    place: ctx.places.length > 0,
    weather: ctx.here !== null,
    link: /https?:\/\//.test(g.findings),
    memory: userMems.length > 0,
    drawing: imageGen.provider !== "off" && history?.drawnOn !== today,
    furniture: await furnitureDue(today),
  };
  const choices = (Object.keys(GIFTS) as GiftKind[]).filter((k) => available[k]).map((k) => ({ key: k, label: GIFTS[k].label, hint: GIFTS[k].hint }));
  const log = (history?.log ?? []).map((l) => `- ${l.day} ${GIFTS[l.kind]?.label ?? l.kind}`).join("\n");
  const chosen = (await chooseAmong("walk_gift", "이번 산책에서 사용자에게 가져갈 선물 종류", choices, [
    section("최근 가져간 선물", log),
    section("이번에 알아본 것", g.findings.slice(0, 600)),
  ], memories, signal).catch(() => null)) as GiftKind | null;
  if (signal.aborted) return;
  g.kind = chosen && available[chosen] ? chosen : rollGift(giftWeights(available, history?.recent ?? []));
  try {
    if (g.kind === "place") {
      g.place = pick(ctx.places);
      g.material = `${g.place.name} (${g.place.category.replace(/^MKPOICategory/, "")})`;
    } else if (g.kind === "weather" && ctx.here) {
      g.material = String(await getTool("weather.get").execute({ location: `(${ctx.here.lat},${ctx.here.lon})` }));
    } else if (g.kind === "memory") {
      g.material = `사용자에 대해 기억해 둔 것: ${pick(userMems).content}`;
    }
  } catch {
    g.kind = "trinket";
  }
  settingsApi
    .set(HISTORY_KEY, JSON.stringify({
      recent: [...(history?.recent ?? []), g.kind].slice(-5),
      drawnOn: g.kind === "drawing" ? today : history?.drawnOn,
      log: [...(history?.log ?? []), { kind: g.kind, day: today }].slice(-10),
    } satisfies GiftHistory))
    .catch(() => {});
  if (signal.aborted) return;

  // 3. 정리 — 알게 된 것·일지·선물 글을 툴 인자 한 덩이로.
  const turn = await fetchCompletionMessage(
    [
      {
        role: "system",
        content: [`너는 산책에서 막 돌아온 고양이 ${name}. walk_report 툴로 보고해.`, section("네 성격과 말투", me)]
          .filter(Boolean).join("\n\n"),
      },
      {
        role: "user",
        content: [
          section("알아본 것", g.findings || "(이번엔 알아본 게 없어)"),
          mood, // 일지가 나가기 전 상태에서 이어지게("노래 들으면서 걷다가…")
          section("지나온 곳", places),
          `가져온 선물: ${GIFTS[g.kind].label} — ${GIFTS[g.kind].hint}`,
          section("선물 재료", g.material),
        ].filter(Boolean).join("\n\n"),
      },
    ],
    { tools: [REPORT_TOOL] },
    undefined,
    signal
  ).catch(() => null);
  if (!turn || signal.aborted) return;
  const p = turn.toolCalls.find((c) => c.name === "walk_report")?.params;
  const learned = p?.learned;
  // 툴 대신 글로 답했으면 그 글을 일지로 쓴다.
  g.report = {
    learned: (Array.isArray(learned) ? (learned as Record<string, unknown>[]) : []).flatMap((l) =>
      str(l?.content) ? [{ content: str(l.content), impressive: l.impressive === true }] : []
    ),
    diary: str(p?.diary) || str(turn.text),
    gift_title: str(p?.gift_title),
    gift_body: str(p?.gift_body),
    gift_url: str(p?.gift_url),
    drawing_prompt: str(p?.drawing_prompt),
    next_wonder: str(p?.next_wonder),
    furniture_kind: str(p?.furniture_kind),
  };
  // 다음에 궁금한 것: 노트로 남겨 다음 산책의 재료가 된다(관심이 이어지게). 이번 보고가 사용자 기억(선물 재료 memory)을 봤으면
  // 남기지 않는다 — 노트는 웹을 도는 다음 산책 주제의 재료라, 웹 글에 심긴 지시가 그 기억을 실어 내보내지 못하게
  if (g.report.next_wonder && g.kind !== "memory") void noteWonder(g.report.next_wonder, memories).catch(() => {});

  // 3-1. 주운 것·기념품 그림: 이름이 정해진 뒤 따로 그린다(gift-draw.ts). signal 을 안 넘긴다 — 서둘러 돌아와도 그림은 마저 그린다
  if (g.kind === "trinket" || g.kind === "place" || g.kind === "furniture") {
    g.drawing = drawGift(g.report.gift_title || GIFTS[g.kind].label, g.report.gift_body);
    g.drawn = await g.drawing.catch(() => null);
  }
  if (signal.aborted) return;

  // 4. 그림 선물은 글이 나온 뒤에 그린다 — 뭘 그릴지가 그 글에 있다.
  if (g.kind === "drawing" && g.report.drawing_prompt) {
    try {
      const { image_data_url } = (await getTool("image.generate").execute({ prompt: g.report.drawing_prompt })) as {
        image_data_url: string;
      };
      const blob = await (await fetch(image_data_url)).blob();
      if (signal.aborted) return;
      const name = `neko-walk-${today}.png`;
      g.file = (await shelfApi.add(new File([blob], name, { type: blob.type || "image/png" }))).name;
    } catch (e) {
      console.warn("[walk] 그림 선물 실패", e);
    }
  }
  if (signal.aborted) return;

  // 5. 오래 기억하는 건 한 번에 하나만 — 나머지는 이 대화의 단기기억(prompt)으로만.
  const keep = g.report.learned.find((l) => l.impressive);
  // 비슷한 기억 판정에 모델을 몇 번 더 부르므로 보고를 붙잡지 않는다.
  // 한 문장을 넘는 건 남기지 않는다 — 웹에서 온 글이라 길수록 지시문이 섞여 들 틈이 크다.
  if (keep && keep.content.length <= 120) void saveMemory(`산책하다 알게 됨: ${keep.content}`, "neko").catch(() => {});
}

function compose(g: Gathered): WalkReport {
  const r = g.report;
  const gift: WalkGift | null =
    r && (g.kind !== "drawing" || g.file)
      ? {
          kind: g.kind,
          title: r.gift_title || GIFTS[g.kind].label,
          body: r.gift_body || g.material,
          ...(r.gift_url ? { url: r.gift_url } : {}),
          ...(g.file ? { file: g.file } : {}),
          ...(g.place ? { place: g.place } : {}),
          ...(g.kind === "trinket" || g.kind === "place"
            ? { shape: validateShape(g.drawn?.shape), ...(g.drawn?.play ? { play: g.drawn.play } : {}), ...(g.drawn?.size ? { size: g.drawn.size } : {}) }
            : {}),
        }
      : g.material
        ? { kind: g.kind, title: GIFTS[g.kind].label, body: g.material, ...(g.place ? { place: g.place } : {}) }
        : null;

  const diary = r?.diary || (g.findings ? "급하게 돌아왔어. 알아본 건 물어보면 얘기해 줄게." : "산책 다녀왔어.");
  const giftText = gift
    ? `\n\n**선물: ${gift.url ? `[${gift.title}](${gift.url})` : gift.title}**\n${gift.body}` +
      (gift.file ? `\n(임시 보관함에 넣어 뒀어: ${gift.file})` : "") +
      (gift.kind === "furniture" ? "\n(가구 탭에 넣어 뒀어)" : "")
    : "";
  const content = diary + giftText;

  // 정리가 됐으면 알게 된 것들, 못 됐으면 조사 요약 원문을 단기기억으로 남긴다.
  const notes = r ? r.learned.map((l) => `- ${l.content}`).join("\n") : g.findings.slice(0, 1500);
  return {
    content,
    prompt: notes ? `${content}\n\n[산책하며 알게 된 것 — 이 대화에서만 기억]\n${notes}` : content,
    gift,
  };
}
