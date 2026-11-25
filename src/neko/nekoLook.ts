import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { PLACE_NAME, useNekoGifts } from "./gifts";
import { FURNITURE_NAME, useNekoFurniture } from "./furniture";
import { useNekoStore } from "./nekoStore";
import { SCREEN_LABEL } from "./remoteNeko";
import { weatherNowSnapshot } from "./weatherNow";
import { skyAt } from "./weatherWindowDraw";

/**
 * 네코가 지금 있는 곳을 살핀다(내부 도구 neko.look, 0.1.33 — 사용자: 조명 상태를 neko.self 에 넣지 말고 주변을 살피는 도구를 따로,
 * 판단에 필요한 만큼만). 방·거실은 놓인 가구(조명은 켜짐·꺼짐)·놓인 선물 수·창밖(낮·밤·날씨, 커튼이 닫혔으면 그 사실), 마당(맥)은
 * 화면에 보이는 창의 수와 네코 기준 대략 위치·크기. 마당 창은 창 탐험이 쓰는 발판·벽(Rust neko_screen_perches)에서 읽고 앱 이름·
 * 창 제목·내용은 넣지 않는다(사용자 결정). 한 줄이 실패해도 나머지 줄은 돌려준다. id 는 줄 끝 칸(도구 호출에만).
 */

async function part(make: () => string | Promise<string>, fallback: string): Promise<string> {
  try { return await make(); } catch { return fallback; }
}

// ── 방·거실 ─────────────────────────────────────────────────────────────────

function furnitureLines(at: "sidebar" | "dock"): string {
  const items = useNekoFurniture.getState().items.filter((f) => f.place?.at === at);
  if (!items.length) return "가구: 없음";
  return ["가구:", ...items.map((f) => {
    const name = f.title ? `'${f.title}'(${FURNITURE_NAME[f.kind]})` : FURNITURE_NAME[f.kind] ?? f.kind;
    return `- ${name}${f.kind === "lamp" ? ` — ${f.lamp ? "켜짐" : "꺼짐"}` : ""} | id=${f.id}`;
  })].join("\n");
}

function windowLine(): string {
  const w = weatherNowSnapshot();
  if (!w) return "창밖: 커튼이 닫혀 있다(날씨를 몰라서)";
  const { light } = skyAt(Date.now() / 1000, w.sunrise, w.sunset, w.is_day);
  const when = light >= 0.6 ? "낮" : light <= 0.4 ? "밤" : "어스름";
  return `창밖: ${when}, ${w.label} ${Math.round(w.temp)}°`;
}

const giftCount = (at: string) => useNekoGifts.getState().gifts.filter((g) => g.placed?.at === at).length;

// ── 마당 ────────────────────────────────────────────────────────────────────

interface Perches {
  tops: { win: number; x0: number; x1: number; y: number }[];
  walls: { win: number; x: number; y0: number; y1: number }[];
}
interface YardCat { cat: [number, number]; w: number; h: number; perch: number | null }

/** 화면 창에 고양이 자리·화면 크기를 묻는다(neko-look-ask → neko-look). 답이 없으면 null */
function askYard(ms = 800): Promise<YardCat | null> {
  return new Promise((ok) => {
    let off: (() => void) | null = null, done = false;
    const finish = (v: YardCat | null) => { if (done) return; done = true; clearTimeout(t); off?.(); ok(v); };
    const t = setTimeout(() => finish(null), ms);
    void listen<YardCat>("neko-look", (e) => finish(e.payload))
      .then((un) => { off = un; if (done) un(); return emitTo(SCREEN_LABEL, "neko-look-ask"); })
      .catch(() => finish(null));
  });
}

type Box = { win: number; x0: number; x1: number; y0: number; y1: number };
/** 발판(윗변)·벽(옆면) 조각을 창 번호로 묶어 대략의 사각형으로. 가려진 부분은 이미 빠져 있다 */
export function windowBoxes(p: Perches): Box[] {
  const m = new Map<number, Box>();
  const grow = (win: number, x0: number, x1: number, y0: number, y1: number) => {
    const b = m.get(win);
    if (!b) m.set(win, { win, x0, x1, y0, y1 });
    else Object.assign(b, { x0: Math.min(b.x0, x0), x1: Math.max(b.x1, x1), y0: Math.min(b.y0, y0), y1: Math.max(b.y1, y1) });
  };
  for (const t of p.tops ?? []) if ([t.x0, t.x1, t.y].every(Number.isFinite)) grow(t.win, t.x0, t.x1, t.y, t.y);
  for (const w of p.walls ?? []) if ([w.x, w.y0, w.y1].every(Number.isFinite)) grow(w.win, w.x, w.x, w.y0, w.y1);
  return [...m.values()];
}

/** 창 하나를 한 줄로: 크기 정도(화면 폭 비율)와 네코 기준 대략 위치. 고양이 자리를 모르면 화면 기준 */
export function windowLine1(b: Box, screen: { w: number; h: number }, cat: [number, number] | null, perch: number | null): string {
  const share = (b.x1 - b.x0) / Math.max(1, screen.w);
  const size = share >= 0.45 ? "큰 창" : share <= 0.2 ? "작은 창" : "중간 창";
  const cx = (b.x0 + b.x1) / 2;
  let where: string;
  if (cat) {
    const h = cat[0] >= b.x0 && cat[0] <= b.x1 ? "바로" : cx < cat[0] ? "왼쪽" : "오른쪽";
    const v = b.y0 < cat[1] - 40 ? "위" : b.y0 > cat[1] + 40 ? "아래" : "옆";
    where = `네코 ${h === "바로" ? `바로 ${v === "옆" ? "곁" : v}` : v === "옆" ? h : `${h} ${v}`}`;
  } else {
    const h = cx < screen.w / 3 ? "왼쪽" : cx > (screen.w * 2) / 3 ? "오른쪽" : "가운데";
    const v = b.y0 < screen.h / 3 ? "위" : b.y0 > (screen.h * 2) / 3 ? "아래" : "가운데";
    where = `화면 ${h === v ? "가운데" : `${h} ${v}`}`;
  }
  return `- ${size}: ${where}${perch === b.win ? "(지금 올라앉은 창)" : ""}`;
}

async function yardLines(): Promise<string> {
  const [p, me] = await Promise.all([
    invoke<Perches | null>("neko_screen_perches").catch(() => null),
    askYard(),
  ]);
  const boxes = p ? windowBoxes(p) : [];
  if (!boxes.length) return p ? "보이는 창: 없음" : "보이는 창: 알 수 없음";
  const screen = me ? { w: me.w, h: me.h } : { w: Math.max(...boxes.map((b) => b.x1)), h: Math.max(...boxes.map((b) => b.y1)) };
  const cat = me?.cat ?? null;
  const dist = (b: Box) => (cat ? Math.hypot((b.x0 + b.x1) / 2 - cat[0], b.y0 - cat[1]) : 0);
  const shown = [...boxes].sort((a, b) => dist(a) - dist(b)).slice(0, 8);
  return [`보이는 창: ${boxes.length}개${boxes.length > shown.length ? `(가까운 ${shown.length}개만)` : ""}`,
    ...shown.map((b) => windowLine1(b, screen, cat, me?.perch ?? null))].join("\n");
}

/** neko.look 결과 */
export async function lookAroundText(): Promise<string> {
  const at = useNekoStore.getState().stage.placement;
  const lines = [`있는 곳: ${PLACE_NAME[at] ?? "알 수 없음"}`];
  if (at === "screen") {
    lines.push(await part(yardLines, "보이는 창: 알 수 없음"));
  } else {
    lines.push(await part(() => furnitureLines(at), "가구: 알 수 없음"));
    lines.push(await part(windowLine, "창밖: 알 수 없음"));
  }
  lines.push(await part(() => `놓인 선물: ${giftCount(at)}개`, "놓인 선물: 알 수 없음"));
  return lines.join("\n");
}
