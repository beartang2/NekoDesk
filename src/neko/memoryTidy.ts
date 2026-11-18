import { settingsApi } from "../api/tauri";
import { tidyMemories } from "../agent/memory-tidy";
import { walkEnd, type Walk } from "../lib/walk";
import { budgetBlockReason } from "../stores/claudeBudget";
import { isClaudeActive, useSettingsStore } from "../stores/settingsStore";
import { SLEEPY_MS } from "./director/derive";
import { useNekoApp } from "./director/stores";

/**
 * 쉴 때 기억 정리의 때(정리 자체는 agent/memory-tidy.ts). 네코가 졸기 시작하고(SLEEPY_MS) 조금 더 지나면
 * 하루 한 번 돈다. 도는 동안 네코는 밥을 먹는다 — 깨우지 않고(앱을 쓰는 중으로 치지 않는다).
 * Claude 프로필일 때만, 설정이 켜져 있고 예산이 남았고 산책 중(보고를 기다리는 중 포함)이 아닐 때만.
 * App.tsx 밖에 둔다 — 산책 출발 조건과 따로 고칠 수 있게.
 */

/** 졸기 시작하고 이만큼 더 지나서. 잠깐 자리를 비운 것엔 돌지 않게 */
const AFTER_DOZE_MS = 60_000;
/** 마지막으로 정리한 날(로컬 날짜) */
const DAY_KEY = "neko_memory_tidy_day";
/** App.tsx 의 WALK_KEY 와 같다 */
const WALK_KEY = "neko_walk";

const today = () => new Date().toDateString();

/** 지금 정리해도 되는가. 안 되면 그 이유 */
export async function tidyBlock(): Promise<string | null> {
  if (!useSettingsStore.getState().memoryTidy) return "꺼 둠";
  if (!isClaudeActive()) return "Claude 프로필이 아님";
  if (budgetBlockReason()) return "예산을 다 씀";
  if (useNekoApp.getState().feeding) return "밥 먹는 중";
  if ((await settingsApi.get(DAY_KEY).catch(() => null)) === today()) return "오늘 이미 함";
  const raw = await settingsApi.get(WALK_KEY).catch(() => null);
  const w = raw ? (JSON.parse(raw) as Walk) : null;
  if (w?.path?.length && !w.done) return Date.now() < walkEnd(w) ? "산책 중" : "산책 보고를 기다리는 중";
  return null;
}

let running = false;
async function run(): Promise<void> {
  if (running || (await tidyBlock().catch(() => "확인 실패"))) return;
  running = true;
  // 실패해도 오늘은 다시 안 한다(같은 실패로 매번 비용을 쓰지 않게)
  await settingsApi.set(DAY_KEY, today()).catch(() => {});
  useNekoApp.getState().setFeeding(true, false);
  try {
    await tidyMemories();
  } catch {
    // 정리는 다음 날 다시. 기억은 그대로다
  } finally {
    running = false;
    useNekoApp.getState().setFeeding(false);
  }
}

let started = false;
/** 메인 창에서 한 번. 앱을 쓸 때마다(lastActiveAt) 졸 시각을 다시 잡는다 */
export function startMemoryTidy(): void {
  if (started) return;
  started = true;
  let t: ReturnType<typeof setTimeout> | undefined;
  const arm = (at: number) => {
    clearTimeout(t);
    t = setTimeout(() => void run(), at + SLEEPY_MS + AFTER_DOZE_MS - performance.now());
  };
  arm(useNekoApp.getState().lastActiveAt);
  useNekoApp.subscribe((s, p) => { if (s.lastActiveAt !== p.lastActiveAt) arm(s.lastActiveAt); });
}
