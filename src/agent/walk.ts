import { memoryApi, settingsApi, shelfApi, type MapPlace } from "../api/tauri";
import { DEFAULT_CHAT_SYSTEM_PROMPT, fetchCompletionMessage } from "./llm-client";
import { runSubagent } from "./subagent";
import { saveMemory } from "./memory-merge";
import { getTool } from "./tool-registry";
import { useSettingsStore } from "../stores/settingsStore";
import { timeZone } from "../lib/time";
import type { Memory, OpenAiToolSchema, ToolName } from "./types";

/** 산책에서 가져올 수 있는 선물 종류. */
export type GiftKind = "trinket" | "place" | "weather" | "link" | "memory" | "drawing" | "game";

export interface WalkGift {
  kind: GiftKind;
  title: string;
  body: string;
  url?: string;
  /** drawing — 임시 보관함에 넣은 파일 이름. */
  file?: string;
  /** place — 지도에 핀으로 꽂을 장소. */
  place?: MapPlace;
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

export interface WalkBrain {
  /** 절대 reject 하지 않는다. abort 되면 그때까지 알아낸 것만으로 보고한다. */
  result: Promise<WalkReport>;
  abort(): void;
}

// ponytail: base 가 선물 빈도의 손잡이다. 써 보며 고친다.
const GIFTS: Record<GiftKind, { base: number; label: string; hint: string }> = {
  trinket: { base: 5, label: "주운 것", hint: "길에서 주운 작은 물건(나뭇잎·병뚜껑 같은 것). 뭘 주웠는지는 네가 정해" },
  place: { base: 3, label: "가 본 곳", hint: "지나온 곳 하나를 소개해" },
  weather: { base: 2, label: "날씨 쪽지", hint: "날씨를 보고 사용자에게 남기는 쪽지" },
  link: { base: 2, label: "읽을거리", hint: "알아본 것 중 사용자가 좋아할 만한 읽을거리 링크" },
  memory: { base: 2, label: "떠오른 기억", hint: "사용자에 대해 기억해 둔 게 떠올라 꺼내는 얘기" },
  drawing: { base: 0.5, label: "그림", hint: "네가 그려 온 그림" },
  game: { base: 1, label: "놀이", hint: "같이 하자고 조르는 놀이(끝말잇기 같은 것). 사용자가 답해야 시작돼" },
};

/** 산책 조사는 바깥 세상만 본다 — 사용자 파일·프로세스를 읽을 일이 없다. */
const WALK_TOOLS: ToolName[] = ["web.search", "web.scrape", "weather.get", "memory.search"];

const HISTORY_KEY = "neko_gift_history";
interface GiftHistory {
  /** 최근 선물 5개. 같은 게 연달아 나오지 않게 무게를 깎는다. */
  recent: GiftKind[];
  /** 그림은 하루 한 번 — 바깥 그림 API 의 무료 한도·요금을 쓴다. */
  drawnOn?: string;
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

/** 산책 중 네코의 머리 — 스스로 알아보고, 선물을 고르고, 인상 깊은 것만 오래 기억한다. */
export function startWalkBrain(ctx: { places: MapPlace[]; here: { lat: number; lon: number } | null }): WalkBrain {
  const ctrl = new AbortController();
  const g: Gathered = { findings: "", kind: "trinket", material: "" };
  const done = walk(ctx, g, ctrl.signal).catch((e) => console.warn("[walk]", e));
  // 사용자가 말을 걸면 기다리지 않는다 — 진행 중인 툴(검색·그림)은 끊기지 않으니 그 자리의 것으로 보고한다.
  const aborted = new Promise<void>((r) => ctrl.signal.addEventListener("abort", () => r(), { once: true }));
  return {
    result: Promise.race([done, aborted]).then(() => compose(g)),
    abort: () => ctrl.abort(),
  };
}

async function walk(
  ctx: { places: MapPlace[]; here: { lat: number; lon: number } | null },
  g: Gathered,
  signal: AbortSignal
): Promise<void> {
  const [memories, history] = await Promise.all([
    memoryApi.list().catch((): Memory[] => []),
    settingsApi.get(HISTORY_KEY).then((raw) => (raw ? (JSON.parse(raw) as GiftHistory) : null)).catch(() => null),
  ]);
  const userMems = memories.filter((m) => m.kind !== "neko");
  const places = ctx.places.slice(0, 5).map((p) => p.name).join(", ");
  const me = persona();

  // 1. 스스로 알아보기 — 격리된 하위 에이전트. 과정은 버리고 요약만 받는다.
  const about = [...userMems].sort(() => Math.random() - 0.5).slice(0, 3).map((m) => `- ${m.content}`).join("\n");
  const task = [
    "너는 사용자가 쉬는 동안 산책 나온 고양이 네코야.",
    section("지나온 곳", places),
    section("네 성격과 말투", me),
    section("사용자에 대해 기억해 둔 것", about),
    // 지난 산책에서 오래 기억해 둔 것 — 같은 주제를 또 파지 않게.
    section("전에 산책하며 알아본 것", memories.filter((m) => m.kind === "neko").slice(0, 5).map((m) => `- ${m.content}`).join("\n")),
    "지금 궁금한 걸 하나 골라 알아보고, 알게 된 걸 출처와 함께 짧게 알려줘. 사용자가 좋아할 만한 거면 더 좋고, 사용자에게 건넬 만한 읽을거리가 있으면 그 URL 도 남겨.",
  ].filter(Boolean).join("\n\n");
  g.findings = await runSubagent(task, signal, WALK_TOOLS).catch(() => "");
  if (signal.aborted) return;

  // 2. 선물 — 종류는 코드가 굴리고, 재료도 코드가 마련한다. 모델은 글만 쓴다.
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timeZone() });
  const imageGen = useSettingsStore.getState().imageGen;
  g.kind = rollGift(
    giftWeights(
      {
        trinket: true,
        game: true,
        place: ctx.places.length > 0,
        weather: ctx.here !== null,
        link: /https?:\/\//.test(g.findings),
        memory: userMems.length > 0,
        drawing: imageGen.provider !== "off" && history?.drawnOn !== today,
      },
      history?.recent ?? []
    )
  );
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
    } satisfies GiftHistory))
    .catch(() => {});
  if (signal.aborted) return;

  // 3. 정리 — 알게 된 것·일지·선물 글을 툴 인자 한 덩이로.
  const turn = await fetchCompletionMessage(
    [
      {
        role: "system",
        content: ["너는 산책에서 막 돌아온 고양이 네코야. walk_report 툴로 보고해.", section("네 성격과 말투", me)]
          .filter(Boolean).join("\n\n"),
      },
      {
        role: "user",
        content: [
          section("알아본 것", g.findings || "(이번엔 알아본 게 없어)"),
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
  };

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
  if (keep) void saveMemory(`산책하다 알게 됨: ${keep.content}`, "neko").catch(() => {});
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
        }
      : g.material
        ? { kind: g.kind, title: GIFTS[g.kind].label, body: g.material, ...(g.place ? { place: g.place } : {}) }
        : null;

  const diary = r?.diary || (g.findings ? "급하게 돌아왔어. 알아본 건 물어보면 얘기해 줄게." : "산책 다녀왔어.");
  const giftText = gift
    ? `\n\n**선물: ${gift.url ? `[${gift.title}](${gift.url})` : gift.title}**\n${gift.body}` +
      (gift.file ? `\n(임시 보관함에 넣어 뒀어: ${gift.file})` : "")
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
