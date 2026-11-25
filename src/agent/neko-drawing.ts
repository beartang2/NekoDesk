import { memoryApi, settingsApi } from "../api/tauri";
import { drawGift } from "./gift-draw";
import type { Memory } from "./types";
import { leaksFact, loadMind, mindMaterial, recentInterests, think } from "./neko-mind";
import { shapeBounds, validateShape, type GiftPart, type GiftShape } from "../neko/engine/gift-shape";
import { useNekoGifts } from "../neko/gifts";
import { budgetBlockReason } from "../stores/claudeBudget";
import { isClaudeActive } from "../stores/settingsStore";

/**
 * 네코의 그림: 혼자 놀다 그리기(draw)를 고르면 그리고 싶은 걸 스스로 골라 정말 그리고, 액자에 넣어 선물함에
 * 둔다. 선물함에서 '걸기'를 누르면 지금 장소 벽에 걸린다(gifts.ts 의 frame).
 *
 * 그리기는 산책 선물과 같은 길(gift-draw.ts)을 쓴다. 고르기 한 번 + 그리기·고치기 두 번 = 모델 세 번.
 * Claude 프로필일 때만, 예산이 남았을 때만, 맥·폰 합쳐 하루 1~2장(dayCap).
 */

/** 이 기기가 하루에 그려 보는 횟수(실패해도 센다 — 모델 비용을 막는 선). 장 수 상한은 dayCap */
const PER_DAY = 2;
const DAY_KEY = "neko_drawing_day";

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

/**
 * 그날 상한(1 또는 2장). 날짜로 정해 맥·폰이 따로 세도 같은 값이다(사용자: 맥·폰 합쳐서 하루 1~2장 — 기기마다 2장씩 세니
 * 한 선물함에 하루 4장까지 쌓였다). 새 동기화 키 없이.
 */
export function dayCap(day: string): number {
  let h = 0;
  for (const c of day) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 1 + (h % 2);
}

/** 그날 그린 액자 수. 선물함은 동기화되니 다른 기기가 그린 것도 센다(사용자가 치운 건 안 센다) */
export function framedOn(gifts: { at: string; frame?: true }[], day: string): number {
  return gifts.filter((g) => g.frame && new Date(g.at).toDateString() === day).length;
}

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
  // ponytail: 두 기기가 선물함이 동기화되기 전에 함께 그리면 상한을 한 장 넘을 수 있다 — 드물어서 막지 않는다
  if (count >= PER_DAY || framedOn(useNekoGifts.getState().gifts, today()) >= dayCap(today())) return null;
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

/**
 * 그릴 것 고르기: 산책 주제와 같은 생각하기(neko-mind think)·같은 재료(노트·알아본 주제·산책 기억·사용자 취향·요즘 관심)에
 * 최근에 그린 것을 더 준다 — 무엇을 그릴지는 네코가 정한다(사용자: 그릴 거리를 좁히지 말고 산책 주제와 같게). 그리는 방식(도형 몇
 * 개, 액자)만 알려 준다. 취향만 보는 건 산책과 같다(보안 검토, docs/neko-mind.md §4): 고른 것이 노트에 남고 노트는 웹을 도는 산책
 * 주제의 재료다
 */
async function pickTopic(): Promise<{ title: string; note: string } | null> {
  const all = await memoryApi.list().catch((): Memory[] => []);
  const [mind, interests] = await Promise.all([loadMind(), recentInterests(all).catch((): string[] => [])]);
  const before = useNekoGifts.getState().gifts.filter((g) => g.frame).slice(-10).map((g) => `- ${g.title}(${g.at.slice(5, 10).replace("-", "/")})`);
  const t = await think(
    "그림으로 그릴 것 하나(짧은 이름). 도형 몇 개로 그리고, 다 그리면 액자에 넣어 사용자에게 준다. say 엔 그림을 건네며 할 말",
    [...mindMaterial(mind, all, { facts: false, interests }), before.length ? `## 최근에 그린 것\n${before.join("\n")}` : ""].filter(Boolean),
    undefined,
    undefined,
    { say: { type: "string", description: "그림을 건네며 사용자에게 하는 한두 문장. 네 말투로" } },
  );
  const title = t?.pick.slice(0, 30) ?? "";
  if (!t || !title || leaksFact(title, all)) return null;
  const say = t.extra?.say;
  return { title, note: typeof say === "string" ? say.trim().slice(0, 200) : "" };
}
