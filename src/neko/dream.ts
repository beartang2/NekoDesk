import { drawGift } from "../agent/gift-draw";
import { DREAM_GAP_MS, dreamThink, loadMind, mayDream, noteDream } from "../agent/neko-mind";
import { budgetBlockReason } from "../stores/claudeBudget";
import { isClaudeActive } from "../stores/settingsStore";
import { DEEP_SLEEP_MS } from "./director/derive";
import { useNekoApp } from "./director/stores";
import type { DreamContent } from "./engine/dream-art";
import type { NekoController } from "./engine/neko-engine";
import { FURNITURE_NAME, useNekoFurniture } from "./furniture";
import { accentHex } from "./furnitureHost";
import { useNekoGifts } from "./gifts";
import { followState } from "./presence";

/**
 * 꿈(0.1.25, 사용자: 중간중간 잘 때 꿈을 꾸게). 길게 깊이 잘 때만 — 누워 잔 지(졸기 6분 뒤 깊은 잠) DREAM_AFTER_MS 가 지나고, 하루
 * 두 번까지·3시간 간격(neko-mind mayDream, 노트로 세니 맥·폰 같이). 무엇을 꿀지는 마음 생각하기(dreamThink)가 고르고, 그림은
 * 그림으로 있는 것(최근 선물·가구) 중 하나의 모양 — 거기 없으면 선물 그리기로 하나 새로 그린다. 엔진이 머리 위 꿈 말풍선으로 띄운다.
 * 생각하기 실패·시간 초과·예산 막힘이나 그림이 없으면 꿈 없이 잔다. 다른 기기가 앞이면(presence) 그쪽이 꾼다
 */
export const DREAM_AFTER_MS = 20 * 60_000;
const CHECK_MS = 60_000;
const PICS_MAX = 12;

/** 꿈에 그림으로 나올 수 있는 것: 최근 선물(액자 그림 빼고)과 가진 가구 */
export function dreamPictures(): { label: string; content: DreamContent }[] {
  const gifts = [...useNekoGifts.getState().gifts].filter((g) => !g.frame).sort((a, b) => b.at.localeCompare(a.at)).slice(0, PICS_MAX - 5)
    .map((g) => ({ label: g.body ? `${g.title} — ${g.body}` : g.title, content: { shape: g.shape } as DreamContent }));
  const accent = accentHex();
  const furn = useNekoFurniture.getState().items.map((f) => ({
    label: f.title ? `${f.title}(가구)` : `${FURNITURE_NAME[f.kind]}(가구)`,
    content: (f.shape ? { shape: f.shape } : { furniture: f.kind, ...(accent ? { accent } : {}) }) as DreamContent,
  }));
  return [...gifts, ...furn].slice(0, PICS_MAX);
}

const idleFor = () => { const a = useNekoApp.getState(); return performance.now() - Math.max(a.lastActiveAt, a.outside.at); };

/** 한 번 꿔 본다. 꿨으면 true */
export async function dreamOnce(ctrl: NekoController, signal?: AbortSignal): Promise<boolean> {
  if (!mayDream(await loadMind())) return false;
  const asked = useNekoApp.getState().lastActiveAt;
  const pics = dreamPictures();
  const d = await dreamThink(pics.map((p) => p.label), signal);
  if (!d || signal?.aborted) return false;
  let content: DreamContent | null = d.see ? pics[d.see - 1].content : null;
  if (!content && d.draw && !(isClaudeActive() && budgetBlockReason())) {
    const g = await drawGift(d.draw, "", signal).catch(() => null);
    if (g) content = { shape: g.shape };
  }
  if (!content || signal?.aborted || useNekoApp.getState().lastActiveAt !== asked) return false; // 그사이 깼다
  if (ctrl.dream(content) === false) return false; // 누워 자는 중이 아니었다. 화면 자리면 화면 창 엔진으로 넘어간다(대리 컨트롤러, 답 없음)
  await noteDream(d);
  return true;
}

/** 메인 창에서 한 번(App). away = 산책 중(그땐 안 꾼다). 해 본 뒤엔(실패해도) DREAM_GAP_MS 동안 다시 안 해 본다 — 실패마다 1분씩 다시 부르지 않게 */
export function watchDreams(ctrl: NekoController, away: () => boolean): () => void {
  let busy = false, tried = 0;
  const ac = new AbortController();
  const timer = setInterval(() => {
    if (busy || Date.now() - tried < DREAM_GAP_MS || away() || useNekoApp.getState().feeding || followState() !== null || idleFor() < DEEP_SLEEP_MS + DREAM_AFTER_MS) return;
    busy = true; tried = Date.now();
    void dreamOnce(ctrl, ac.signal).catch(() => false).finally(() => { busy = false; });
  }, CHECK_MS);
  return () => { clearInterval(timer); ac.abort(); };
}
