import { memoryApi, settingsApi } from "../api/tauri";
import { drawGift } from "./gift-draw";
import { DEFAULT_CHAT_SYSTEM_PROMPT, fetchCompletionMessage } from "./llm-client";
import type { Memory, OpenAiToolSchema } from "./types";
import { noteChose, recentNotesText } from "./neko-mind";
import { shapeBounds, validateShape, type GiftPart, type GiftShape } from "../neko/engine/gift-shape";
import { useNekoGifts } from "../neko/gifts";
import { budgetBlockReason } from "../stores/claudeBudget";
import { isClaudeActive, nekoNameOf, useSettingsStore } from "../stores/settingsStore";

/**
 * 네코의 그림: 혼자 놀다 그리기(draw)를 고르면 그리고 싶은 걸 스스로 골라 정말 그리고, 액자에 넣어 선물함에
 * 둔다. 선물함에서 '걸기'를 누르면 지금 장소 벽에 걸린다(gifts.ts 의 frame).
 *
 * 그리기는 산책 선물과 같은 길(gift-draw.ts)을 쓴다. 고르기 한 번 + 그리기·고치기 두 번 = 모델 세 번.
 * Claude 프로필일 때만, 예산이 남았을 때만, 하루 두 장까지.
 */

/** 하루에 그리는 장 수 */
const PER_DAY = 2;
const DAY_KEY = "neko_drawing_day";

const TOPIC_TOOL = {
  type: "function",
  function: {
    name: "neko_drawing",
    description: "그릴 것을 고른다",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "그릴 것. 짧은 이름(예: 비 오는 날 우산, 노란 튤립)" },
        note: { type: "string", description: "그림을 건네며 사용자에게 하는 한두 문장. 네 말투로" },
        why: { type: "string", description: "이걸 고른 까닭 한 줄(네 노트에 남는다)" },
      },
      required: ["title", "note"],
    },
  },
} as OpenAiToolSchema;

// ── 액자 ──────────────────────────────────────────────────────────────────────
// 칸은 32×32, 가운데 x = 0, 바닥 y = 0(위가 음수). 액자 바닥이 칸 바닥이다
const FRAME = { w: 26, h: 22 };
const MAT = { w: 22, h: 18 };
/** 그림이 들어갈 안쪽(매트 안 여백 2) */
const INNER = { w: 18, h: 14 };
/** 그림 도형 수 상한(액자 둘 + 그림 22 = 엔진 상한 24) */
const MAX_DRAWN = 22;

/** 그림을 액자에 넣는다: 나무 액자 + 흰 매트 위에 그림을 줄여 가운데로 */
export function framed(drawing: GiftShape): GiftShape {
  const b = shapeBounds(drawing);
  const k = Math.min(INNER.w / b.w, INNER.h / b.h);
  const cx = (b.x0 + b.x1) / 2, cy = -b.h / 2, CY = -FRAME.h / 2;
  const X = (x: number) => (x - cx) * k, Y = (y: number) => (y - cy) * k + CY;
  const pts = (ps: [number, number][]) => ps.map(([x, y]) => [X(x), Y(y)] as [number, number]);
  const fit = (p: GiftPart): GiftPart => {
    switch (p.t) {
      case "circle": return { ...p, x: X(p.x), y: Y(p.y), r: p.r * k };
      case "dot": return { ...p, x: X(p.x), y: Y(p.y), r: p.r * k };
      case "ellipse": return { ...p, x: X(p.x), y: Y(p.y), rx: p.rx * k, ry: p.ry * k };
      case "rrect": return { ...p, x: X(p.x), y: Y(p.y), w: p.w * k, h: p.h * k, rad: p.rad * k };
      case "poly": return { ...p, pts: pts(p.pts), round: p.round * k };
      case "line": return { ...p, pts: pts(p.pts), w: p.w * k };
    }
  };
  return validateShape({
    v: 1,
    parts: [
      { t: "rrect", x: 0, y: CY, w: FRAME.w, h: FRAME.h, rad: 1.2, rot: 0, c: "brown" },
      { t: "rrect", x: 0, y: CY, w: MAT.w, h: MAT.h, rad: 0.4, rot: 0, c: "white" },
      ...drawing.parts.slice(0, MAX_DRAWN).map(fit),
    ],
  });
}

// ── 그리기 ────────────────────────────────────────────────────────────────────

const today = () => new Date().toDateString();

async function drawnToday(): Promise<number> {
  const raw = (await settingsApi.get(DAY_KEY).catch(() => null)) ?? "";
  const [day, n] = raw.split("|");
  return day === today() ? Number(n) || 0 : 0;
}

let busy = false;

/**
 * 그릴 수 있으면 하나 그려 선물함에 넣고 그 이름을 돌려준다. 못 그렸거나 그릴 때가 아니면 null.
 * 감독이 혼자 놀기로 '그리기'를 골랐을 때 부른다(useNekoDirector).
 */
export async function maybeDraw(): Promise<string | null> {
  if (busy || !isClaudeActive() || budgetBlockReason()) return null;
  const count = await drawnToday();
  if (count >= PER_DAY) return null;
  busy = true;
  try {
    await settingsApi.set(DAY_KEY, `${today()}|${count + 1}`).catch(() => {});
    const topic = await pickTopic();
    if (!topic) return null;
    const drawn = await drawGift(topic.title, topic.note);
    if (!drawn) return null;
    useNekoGifts.getState().add({ title: topic.title, body: topic.note, shape: framed(drawn.shape), size: "small", frame: true });
    return topic.title;
  } catch {
    return null;
  } finally {
    busy = false;
  }
}

async function pickTopic(): Promise<{ title: string; note: string } | null> {
  const s = useSettingsStore.getState();
  const name = nekoNameOf(s);
  const persona = s.systemPrompt?.trim() && s.systemPrompt.trim() !== DEFAULT_CHAT_SYSTEM_PROMPT.trim() ? s.systemPrompt.trim() : "";
  // 사용자가 좋아할 만한 걸 고르게 사용자 기억 몇 개, 겹치지 않게 전에 그린 것
  const all = await memoryApi.list().catch((): Memory[] => []);
  // 취향만(보안 검토, docs/neko-mind.md §4): 고른 것·까닭이 노트에 남고 노트는 웹을 도는 산책 주제의 재료라, 사용자 사실(이름·장소·일정)은 안 보인다
  const memories = all.filter((m) => m.kind === "preference").slice(0, 8).map((m) => `- ${m.content}`);
  // 전에 그린 것(날짜와 함께)과 내 노트(docs/neko-mind.md §6.2): 고르는 건 네코다 — 규칙 대신 재료
  const before = useNekoGifts.getState().gifts.filter((g) => g.frame).slice(-10).map((g) => `${g.title}(${g.at.slice(5, 10).replace("-", "/")})`);
  const notes = await recentNotesText().catch(() => "");
  const turn = await fetchCompletionMessage(
    [
      { role: "system", content: [`너는 고양이 ${name}. neko_drawing 툴로 답해.`, persona && `네 성격과 말투:\n${persona}`].filter(Boolean).join("\n\n") },
      {
        role: "user",
        content: [
          "혼자 놀다가 그림을 그리고 싶어졌어. 그리고 싶은 것 하나를 골라. 도형 몇 개로 그릴 수 있는 작은 물건·동물·꽃·음식·풍경 조각이 좋아. 다 그리면 액자에 넣어 사용자에게 줄 거야.",
          memories.length ? `사용자에 대해 아는 것(참고만):\n${memories.join("\n")}` : "",
          before.length ? `전에 그린 것: ${before.join(", ")}` : "",
          notes ? `내 노트(요즘 궁금한 것·하고 싶은 것·고른 것):\n${notes}` : "",
        ].filter(Boolean).join("\n\n"),
      },
    ],
    { tools: [TOPIC_TOOL] },
  );
  const p = turn.toolCalls.find((c) => c.name === "neko_drawing")?.params;
  const title = typeof p?.title === "string" ? p.title.trim().slice(0, 30) : "";
  const note = typeof p?.note === "string" ? p.note.trim().slice(0, 200) : "";
  if (title) void noteChose("drawing", title, typeof p?.why === "string" ? p.why : "", all).catch(() => {});
  return title ? { title, note } : null;
}
