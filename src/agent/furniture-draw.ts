import { fetchCompletionMessage } from "./llm-client";
import type { OpenAiToolSchema } from "./types";
import { GIFT_COLORS, drawShape, validateShape, type GiftShape } from "../neko/engine/gift-shape";
import { CAT_U, checkFurniture, type FurnUse } from "../neko/furnitureUses";
import { GIFT_SHAPE_SCHEMA, drawingHow } from "./gift-draw";

/**
 * 자유 가구 그리기(docs/neko-furniture-free.md §5): 산책에서 물어온 가구 이름·설명을 받아, 고양이와 견준 실제 크기(고양이 키 CAT_U 칸)로
 * 모양을 그리고, 이 가구가 고양이에게 내주는 자리(쓰임새)를 정해진 목록에서 그림 위 자리와 함께 고르게 한다. 선물 그리기와 같은
 * 따로 부르는 호출이라 산책·채팅 시스템 프롬프트는 늘지 않는다. 예시 물건·예시 문장은 주지 않는다(사용자: 편향되는 예시는 싫다).
 * 그린 뒤엔 고양이 실루엣과 쓰임새 표시를 얹은 그림을 보여 주고 한 번 고치게 한다. 자리는 코드가 그림 윤곽으로 검사·보정한다
 * (neko/furnitureUses — 모델이 대충 짚어도 맞게, 안 맞으면 버린다).
 */

const SHAPE = {
  ...GIFT_SHAPE_SCHEMA,
  description:
    `가구 모양. 고양이 키가 ${CAT_U}칸인 축척(가운데 x=0, 바닥 y=0, 위는 음수, 좌우 ±16, 높이 32까지). 도형 8~24개, 뒤에 적은 게 위에 ` +
    "그려진다. 입체감·그림자는 앱이 입힌다",
};

const USES = {
  type: "array",
  description: "이 가구가 고양이에게 내주는 자리. 그 가구에 맞는 것만(없으면 빈 배열), 4개까지. 좌표는 furniture_shape 와 같은 칸",
  items: {
    type: "object",
    properties: {
      u: {
        type: "string",
        enum: ["perch", "inside", "scratch", "bat"],
        description: "perch 위쪽 평평한 면에 올라앉기·식빵·자기, inside 안에 들어가 숨기, scratch 옆면에 발톱 긁기, bat 매달린 것을 앞발로 치기",
      },
      y: { type: "number", description: "perch: 면 높이(음수). bat: 매달린 것의 높이(음수)" },
      x0: { type: "number", description: "perch: 면 왼쪽 끝. inside: 입구 왼쪽 끝" },
      x1: { type: "number", description: "perch: 면 오른쪽 끝. inside: 입구 오른쪽 끝" },
      soft: { type: "boolean", description: "perch: 푹신한 면이면 true" },
      rim: { type: "number", description: "inside: 입구 테두리 높이(음수)" },
      front: {
        type: "array",
        items: { type: "integer" },
        description: "inside: 고양이가 들어갔을 때 고양이 앞에 보일 도형 번호들(furniture_shape.parts 를 0부터 센 번호)",
      },
      side: { type: "string", enum: ["left", "right"], description: "scratch: 긁을 옆면" },
      x: { type: "number", description: "bat: 매달린 것의 가로 자리" },
    },
    required: ["u"],
  },
};

const DRAW_TOOL = {
  type: "function",
  function: {
    name: "furniture_draw",
    description: "가구를 그리고 쓰임새를 고른다",
    parameters: {
      type: "object",
      properties: {
        furniture_shape: SHAPE,
        furniture_uses: USES,
        furniture_glow: { type: "string", enum: GIFT_COLORS, description: "스스로 빛을 내는 가구일 때만 빛 색. 아니면 빼" },
      },
      required: ["furniture_shape", "furniture_uses"],
    },
  },
} as OpenAiToolSchema;

const FIX_TOOL = {
  type: "function",
  function: {
    name: "furniture_fix",
    description: "고친 가구 모양과 쓰임새를 낸다",
    parameters: { type: "object", properties: { furniture_shape: SHAPE, furniture_uses: USES }, required: ["furniture_shape", "furniture_uses"] },
  },
} as OpenAiToolSchema;

const HOW = drawingHow(`- 고양이 키가 ${CAT_U}칸이다. 고양이와 견준 실제 크기로 그리고, 맨 아래가 바닥(y=0)에 닿게. 좌우 대칭인 가구는 좌표도 대칭으로.`);
const SYSTEM = "너는 고양이가 쓰는 가구를 도형 몇 개로 그리는 화가야.";

/**
 * 그린 가구를 고양이 실루엣(같은 축척, 오른쪽 끝에 연하게)·쓰임새 표시와 함께 PNG 로. 면은 선, 입구는 점선 상자와 앞 겹 테두리,
 * 긁는 옆면은 세로 막대, 매달린 것은 고리. 캔버스를 못 쓰는 곳(테스트 등)이면 null
 */
function renderWithCat(shape: GiftShape, uses: unknown, size = 256): string | null {
  try {
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const g = cv.getContext("2d");
    if (!g) return null;
    g.fillStyle = "#f4f1ea";
    g.fillRect(0, 0, size, size);
    const u = (size * 0.86) / 32, ox = size / 2, oy = size * 0.95, P = (x: number, y: number): [number, number] => [ox + x * u, oy + y * u];
    // 고양이(앉은 실루엣, 키 CAT_U): 몸·머리·귀
    g.save(); g.globalAlpha = 0.28; g.fillStyle = "#3a2c34";
    const cx = 13.5, k = CAT_U / 12;
    g.beginPath(); g.ellipse(...P(cx, -3.4 * k), 3 * k * u, 3.4 * k * u, 0, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(...P(cx, -8.6 * k), 2.3 * k * u, 2.1 * k * u, 0, 0, Math.PI * 2); g.fill();
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(...P(cx + s * 0.6 * k, -10.2 * k)); g.lineTo(...P(cx + s * 2 * k, -12 * k)); g.lineTo(...P(cx + s * 2.2 * k, -9.4 * k)); g.fill(); }
    g.restore();
    drawShape(g, shape, ox, oy, u, 6);
    g.save(); g.strokeStyle = "#e0457b"; g.fillStyle = "#e0457b"; g.lineWidth = 2;
    for (const raw of Array.isArray(uses) ? uses : []) {
      const r = (raw ?? {}) as Record<string, number | string | number[]>;
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      if (r.u === "perch") { g.beginPath(); g.moveTo(...P(n(r.x0), n(r.y))); g.lineTo(...P(n(r.x1), n(r.y))); g.stroke(); }
      else if (r.u === "inside") { g.setLineDash([4, 3]); const [a, b] = P(n(r.x0), n(r.rim)); g.strokeRect(a, b, (n(r.x1) - n(r.x0)) * u, -n(r.rim) * u); g.setLineDash([]); }
      else if (r.u === "scratch") { const x = r.side === "left" ? -15.5 : 15.5; g.fillRect(...P(x, -CAT_U * 0.9), 3, CAT_U * 0.9 * u); }
      else if (r.u === "bat") { g.beginPath(); g.arc(...P(n(r.x), n(r.y)), 5, 0, Math.PI * 2); g.stroke(); }
    }
    g.restore();
    return cv.toDataURL("image/png");
  } catch {
    return null;
  }
}

export interface DrawnFurniture {
  /** 검사를 거친 모양·쓰임새 */
  shape: GiftShape;
  uses: FurnUse[];
  /** 고치기 전 처음 모양(시험 화면에서 견줘 본다) */
  first: GiftShape;
}

/**
 * 가구 하나를 그린다. about 은 산책 보고가 붙인 한두 문장. 못 그렸거나 가구라 하기엔 너무 낮으면 null(부르는 쪽이 선물로 돌린다).
 * 모델을 두 번 부른다(그리기 + 보고 고치기).
 */
export async function drawFurniture(title: string, about = "", signal?: AbortSignal): Promise<DrawnFurniture | null> {
  const turn = await fetchCompletionMessage(
    [
      { role: "system", content: `${SYSTEM} furniture_draw 툴로 답해.` },
      { role: "user", content: [`그릴 가구: ${title}`, about && `설명: ${about}`, HOW].filter(Boolean).join("\n\n") },
    ],
    { tools: [DRAW_TOOL] },
    undefined,
    signal
  ).catch(() => null);
  const p = turn?.toolCalls.find((c) => c.name === "furniture_draw")?.params;
  if (!p?.furniture_shape || typeof p.furniture_shape !== "object") return null;
  const glow = p.furniture_glow;
  const first = validateShape({ ...p.furniture_shape, glow });
  let shape: unknown = { ...p.furniture_shape, glow }, uses: unknown = p.furniture_uses;
  const url = signal?.aborted ? null : renderWithCat(first, uses);
  if (url) {
    const fix = await fetchCompletionMessage(
      [
        { role: "system", content: `${SYSTEM} furniture_fix 툴로 답해.` },
        {
          role: "user",
          content: [
            { type: "text", text:
              `네가 '${title}'(으)로 그린 가구야. 옆의 흐린 실루엣이 같은 축척의 고양이고, 분홍 표시가 네가 고른 쓰임새 자리야` +
              "(면은 선, 입구는 점선 상자, 긁는 옆면은 막대, 매달린 것은 고리). 고양이와 견준 크기와 쓰임새 자리가 그림과 맞는지 보고 " +
              "고쳐서 furniture_shape·furniture_uses 를 다시 내. 이미 맞으면 그대로 내.\n\n" +
              `지금: ${JSON.stringify({ parts: first.parts, uses })}\n\n${HOW}` },
            { type: "image_url", image_url: { url } },
          ],
        },
      ],
      { tools: [FIX_TOOL] },
      undefined,
      signal
    ).catch(() => null);
    const f = fix?.toolCalls.find((c) => c.name === "furniture_fix")?.params;
    if (f?.furniture_shape && typeof f.furniture_shape === "object") { shape = { ...f.furniture_shape, glow }; uses = f.furniture_uses; }
  }
  // 고친 것이 망가졌으면 처음 그린 것으로
  const checked = checkFurniture(shape, uses) ?? checkFurniture({ ...p.furniture_shape, glow }, p.furniture_uses);
  return checked ? { ...checked, first } : null;
}
