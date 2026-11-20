import { fetchCompletionMessage } from "./llm-client";
import type { OpenAiToolSchema } from "./types";
import { GIFT_COLORS, drawShape, shapeBounds, validateShape, type GiftShape } from "../neko/engine/gift-shape";
import { PLAYS } from "../neko/gifts";

/**
 * 선물 그리기: 물건 이름을 받아 네코 그림체로 그릴 모양(도형 목록)을 모델에게 받는다. 설계 docs/neko-gifts.md §2.
 *
 * 그림체(입체감·그림자·색)는 엔진(gift-shape.js)이 입히고, 여기선 모양만 받는다. 엔진은 잘 적힌 모양이면
 * 무엇이든 알아보게 그린다 — 약한 고리는 모양을 적는 쪽이라, 그 일만 하는 호출을 따로 두고(산책 보고에 끼워 받으면
 * 일지·선물 글에 밀려 동그라미 몇 개로 끝나기 쉬웠다) 그리는 법만 준다. 본보기 그림(도토리·단풍잎·열쇠)은 0.1.25 에
 * 뺐다 — 선물이 그쪽으로 쏠릴 수 있다(사용자: 편향되는 예시는 싫다). 그린 뒤엔 실제로 그려진 모습을 한 번 보여 주고 고치게 한다.
 *
 * 산책(walk.ts)과 선물 시험(GiftLab)이 같은 길을 쓴다.
 */

/** 선물 모양 스키마. 그림체는 앱이 입히고 모델은 모양만 */
const GIFT_SHAPE_SCHEMA = {
  type: "object",
  description:
    "물건 모양. 32칸(가운데 x=0, 바닥 y=0, 위는 음수, 좌우 ±16). 도형 8~20개, 뒤에 적은 게 위에 그려진다. " +
    "입체감·그림자는 앱이 입힌다",
  properties: {
    parts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          t: { type: "string", enum: ["circle", "ellipse", "rrect", "poly", "line", "dot"] },
          x: { type: "number" }, y: { type: "number" }, r: { type: "number", description: "circle 반지름, dot 크기(0.3~2)" },
          rx: { type: "number" }, ry: { type: "number" }, w: { type: "number", description: "rrect 폭, line 굵기(0.3~4)" }, h: { type: "number" },
          rad: { type: "number" }, rot: { type: "number", description: "라디안" },
          pts: { type: "array", items: { type: "array", items: { type: "number" } }, description: "poly(3~24)·line(2~12) 점 [x,y]" },
          round: { type: "number", description: "poly 꼭짓점 둥글기. 0 이면 뾰족(기본 1.2)" },
          c: { type: "string", enum: GIFT_COLORS },
        },
        required: ["t", "c"],
      },
    },
  },
  required: ["parts"],
};

const DRAW_TOOL = {
  type: "function",
  function: {
    name: "gift_draw",
    description: "물건을 그린다",
    parameters: {
      type: "object",
      properties: {
        gift_shape: GIFT_SHAPE_SCHEMA,
        gift_size: {
          type: "string",
          enum: ["small", "medium", "large"],
          description: "실제 물건 크기. small 손끝에 올라가는 것, medium 손바닥에 드는 것, large 그보다 크지만 고양이보다 작은 것",
        },
        gift_play: {
          type: "string",
          enum: PLAYS,
          description: "고양이가 그걸로 노는 방식. roll 굴리기(동근 것)·bat 앞발로 톡·sniff 냄새 맡기·sit_on 위에 앉기(납작한 것)·carry 물고 옮기기",
        },
        gift_glow: { type: "string", enum: GIFT_COLORS, description: "스스로 빛을 내는 물건일 때만 빛 색. 아니면 빼" },
      },
      required: ["gift_shape"],
    },
  },
} as OpenAiToolSchema;

const FIX_TOOL = {
  type: "function",
  function: {
    name: "gift_shape_fix",
    description: "고친 물건 모양을 낸다",
    parameters: { type: "object", properties: { gift_shape: GIFT_SHAPE_SCHEMA }, required: ["gift_shape"] },
  },
} as OpenAiToolSchema;

const HOW = [
  "그리는 법:",
  "- 먼저 그 물건을 한눈에 알아보게 하는 것 두세 가지를 정해.",
  "- 큰 덩어리부터 적고 그 위에 특징을 얹어. 실루엣은 poly 로 정확히(뾰족한 데는 round 0), 결·주름·꼭지는 가는 line 으로.",
  "- 그늘·무늬는 같은 색의 .dark, 밝은 데는 .light. 색은 두세 가지만.",
  "- 긴 쪽이 20~28칸이 되게 크게 그리고, 맨 아래가 바닥(y=0)에 닿게. 좌우 대칭인 물건은 좌표도 대칭으로.",
  "- 글자·숫자는 못 그린다. 그 물건이 놓인 바닥·배경도 그리지 마.",
].join("\n");

export interface DrawnGift {
  /** 검사를 거친 최종 모양 */
  shape: GiftShape;
  /** 고치기 전 처음 그림(시험 화면에서 견줘 본다). 안 고쳤으면 shape 와 같다 */
  first: GiftShape;
  size?: string;
  play?: string;
}

/** 모양을 실제로 그려 PNG 로. 캔버스를 못 쓰는 곳(테스트 등)이면 null */
function renderShape(shape: GiftShape, size = 256): string | null {
  try {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#f4f1ea"; // 앱 무대와 같은 바탕
    ctx.fillRect(0, 0, size, size);
    const b = shapeBounds(shape), u = (size * 0.78) / Math.max(b.w, b.h);
    drawShape(ctx, shape, size / 2 - ((b.x0 + b.x1) / 2) * u, size / 2 + (b.h * u) / 2, u, 6);
    return cv.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** 그린 선물을 보여 주고 알아보기 어려우면 고친 모양을 받는다. 못 하면 null(처음 모양 그대로 쓴다) */
async function refineShape(title: string, shape: GiftShape, signal?: AbortSignal): Promise<unknown | null> {
  const url = renderShape(shape);
  if (!url) return null;
  const turn = await fetchCompletionMessage(
    [
      { role: "system", content: "너는 작은 물건을 도형 몇 개로 그리는 화가야. gift_shape_fix 툴로 답해." },
      {
        role: "user",
        content: [
          { type: "text", text:
            `네가 '${title}'(으)로 그린 그림이야. 처음 보는 사람이 바로 '${title}'인 걸 알아볼까? ` +
            "알아보기 어려운 데(실루엣·특징 선·색·비율)를 고쳐 gift_shape 를 다시 내. 이미 잘 알아보이면 그대로 내.\n\n" +
            `지금 모양: ${JSON.stringify({ parts: shape.parts })}\n\n${HOW}` },
          { type: "image_url", image_url: { url } },
        ],
      },
    ],
    { tools: [FIX_TOOL] },
    undefined,
    signal
  ).catch(() => null);
  const fixed = turn?.toolCalls.find((c) => c.name === "gift_shape_fix")?.params?.gift_shape;
  return fixed && typeof fixed === "object" ? fixed : null;
}

/**
 * 물건 하나를 그린다. about 은 그 물건에 붙은 한두 문장(색·생김새 단서). 못 그리면 null.
 * 모델을 두 번 부른다(그리기 + 보고 고치기).
 */
export async function drawGift(title: string, about = "", signal?: AbortSignal): Promise<DrawnGift | null> {
  const turn = await fetchCompletionMessage(
    [
      { role: "system", content: "너는 작은 물건을 도형 몇 개로 그리는 화가야. gift_draw 툴로 답해." },
      {
        role: "user",
        content: [`그릴 물건: ${title}`, about && `설명: ${about}`, HOW]
          .filter(Boolean).join("\n\n"),
      },
    ],
    { tools: [DRAW_TOOL] },
    undefined,
    signal
  ).catch(() => null);
  const p = turn?.toolCalls.find((c) => c.name === "gift_draw")?.params;
  if (!p?.gift_shape || typeof p.gift_shape !== "object") return null;
  // 빛(glow)은 모양 칸에 붙인다. 고치기(gift_shape_fix)는 도형만 다시 내니 고친 모양에도 다시 붙인다
  const glow = p.gift_glow;
  const first = validateShape({ ...p.gift_shape, glow });
  const fixed = signal?.aborted ? null : await refineShape(title, first, signal);
  return {
    first,
    shape: fixed ? validateShape({ ...fixed, glow }) : first,
    ...(typeof p.gift_size === "string" ? { size: p.gift_size } : {}),
    ...(typeof p.gift_play === "string" ? { play: p.gift_play } : {}),
  };
}
