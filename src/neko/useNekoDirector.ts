import { useEffect, useRef } from "react";
import type { NekoActivity } from "./engine/neko-engine";
import { ONE_SHOT } from "./director/toolActivity";
import { maybeDraw } from "../agent/neko-drawing";
import { appEvents } from "../lib/events";
import { DEEP_SLEEP_MS, deriveNeko, SLEEPY_MS } from "./director/derive";
import { CHASE_BELOW, pickByNeeds } from "./director/needs";
import { useNekoNeeds } from "./director/needsStore";
import { createScheduler, realClock, type Scheduler } from "./director/scheduler";
import { onNekoSignal, useNekoApp, useNekoSessions } from "./director/stores";
import type { DirectorInput } from "./director/types";
import { emotionPlan } from "./emotionMap";
import { useNekoController } from "./nekoHost";

/**
 * 감독을 앱에 연결한다(설계 docs/neko-p2-director.md). 예전 useNekoBridge 와 App 의 displayEmotion·상자·졸림 타이머를 대신한다.
 *
 * - 입력: 활성 세션의 네코 상태(useNekoSessions) + 앱 상황(useNekoApp) + 배고픔·놀이 + 상자
 * - 스토어는 selector 훅 대신 subscribe 로만 본다(신호가 와도 App 이 다시 그려지지 않게)
 * - 계획은 deriveNeko, 적용은 스케줄러
 */

/**
 * 신남: 놀이 ≥ 40 이고 쉬는 중이면 45초~2분 뒤 혼자 논다. 한 번 고르면 2~4분(한 번짜리는 20초) 이어 하거나 3번
 * 쓰다듬으면 그만 — 금방금방 바꾸면 산만해 보인다. 무엇을 할지는 숨은 게이지 점수에 비례한 확률로(director/needs.ts,
 * docs/neko-activity-mix.md 2부). 방금 한 것은 안 고르고, 놓아 둔 선물이 있으면 선물 놀이도 고른다.
 */
const BOX_PLAY_MIN = 40;
const BOX_AFTER_MS = [45_000, 120_000] as const;
const BOX_STAY_MS = [120_000, 240_000] as const;
const BOX_STAY_ONE_SHOT_MS = 20_000;
const BOX_EXIT_PETS = 3;
/** 숨은 게이지 갱신 간격 */
const NEEDS_TICK_MS = 60_000;
/** 키 입력·클릭·스크롤을 '앱을 쓰는 중'으로 세는 간격 */
const ACTIVE_THROTTLE_MS = 3000;

export function useNekoDirector({ activeId, isDark, needs, onPet }: {
  activeId: string;
  isDark: boolean;
  needs: { hunger: number; play: number };
  onPet: () => void;
}) {
  const ctrl = useNekoController();
  const onPetRef = useRef(onPet);
  onPetRef.current = onPet;
  const activeRef = useRef(activeId);
  const needsRef = useRef(needs);
  needsRef.current = needs;
  const schRef = useRef<Scheduler | null>(null);
  const syncBoxRef = useRef<() => void>(() => {});

  useEffect(() => { ctrl?.setTheme({ dark: isDark }); }, [ctrl, isDark]);

  useEffect(() => {
    ctrl?.setNeeds({ hunger: needs.hunger, play: needs.play });
    syncBoxRef.current();
    schRef.current?.update();
  }, [ctrl, needs.hunger, needs.play]);

  useEffect(() => {
    if (!ctrl) return;
    let box: DirectorInput["box"] = null;
    let lastSolo: NekoActivity | null = null;
    let boxPetBase = 0;
    let boxTimer: ReturnType<typeof setTimeout> | null = null;
    let boxExitTimer: ReturnType<typeof setTimeout> | null = null;

    const input = (): DirectorInput => {
      const app = useNekoApp.getState();
      return {
        session: useNekoSessions.getState().get(activeRef.current),
        feeding: app.feeding, fedAt: app.fedAt, playCue: app.playCue, game: app.game,
        needs: needsRef.current, lastActiveAt: app.lastActiveAt, outside: app.outside, box, hidden: app.screenHidden,
      };
    };
    const sch = createScheduler(ctrl, realClock, (now) => deriveNeko(input(), now));
    schRef.current = sch;

    const leaveBox = () => {
      if (boxExitTimer) { clearTimeout(boxExitTimer); boxExitTimer = null; }
      if (box) { box = null; sch.update(); }
    };
    const syncBox = () => {
      const app = useNekoApp.getState();
      const s = useNekoSessions.getState().get(activeRef.current);
      const now = performance.now();
      const resting = (s.phase === "idle" || s.phase === "result") && !app.feeding && !app.game
        && !(app.playCue && now < app.playCue.at + 6000);
      if (!resting || needsRef.current.play < BOX_PLAY_MIN) {
        if (boxTimer) { clearTimeout(boxTimer); boxTimer = null; }
        leaveBox();
        return;
      }
      if (box && app.pets - boxPetBase >= BOX_EXIT_PETS) { leaveBox(); return; }
      if (!box && !boxTimer) {
        const wait = BOX_AFTER_MS[0] + Math.random() * (BOX_AFTER_MS[1] - BOX_AFTER_MS[0]);
        boxTimer = setTimeout(() => {
          boxTimer = null;
          // 놓아 둔 선물이 있으면 그걸 갖고 노는 것도 고른다(docs/neko-gifts.md §5)
          // 창 탐험은 화면 모드에서 갈 창이 있을 때만(엔진 towerOk — 대리는 화면 창이 알린 값)
          const c = ctrl as { decorCount?: number; towerOk?: boolean };
          const kind = pickByNeeds(useNekoNeeds.getState().needs, { last: lastSolo, hasGifts: !!c.decorCount, towerOk: c.towerOk === true });
          lastSolo = kind;
          box = { since: performance.now(), kind };
          // 그리기면 정말 그린다(하루 두 장, Claude 일 때만). 다 그려 액자를 선물함에 넣으면 꼬리 세우기
          if (kind === "draw") void maybeDraw().then((title) => { if (title) sch.react([{ type: "react", kind: "proud" }]); });
          boxPetBase = useNekoApp.getState().pets;
          const stay = ONE_SHOT.has(kind) ? BOX_STAY_ONE_SHOT_MS : BOX_STAY_MS[0] + Math.random() * (BOX_STAY_MS[1] - BOX_STAY_MS[0]);
          boxExitTimer = setTimeout(leaveBox, stay);
          sch.update();
        }, wait);
      }
    };
    syncBoxRef.current = syncBox;

    const offs = [
      useNekoSessions.subscribe((s, p) => {
        const id = activeRef.current;
        if (s.sessions[id] !== p.sessions[id]) { syncBox(); sch.update(); }
      }),
      useNekoApp.subscribe((s, p) => {
        if (p.feeding && !s.feeding) sch.react([{ type: "react", kind: "cheer", gate: "result" }]); // 다 먹었다
        if (s.fedAt !== null && s.fedAt !== p.fedAt) useNekoNeeds.getState().fed(); // 먹고 나면 조금 꼬질
        if (s.pets > p.pets) useNekoNeeds.getState().petted(); // 탭·문지르기 모두 App handlePet → notePet
        if (s.game && s.game !== p.game) { // 같은 감정이 다시 와도(연달아 맞힘, 산책에서 돌아옴) 반응한다
          const r = emotionPlan(s.game.emotion).react;
          if (r) sch.react([{ type: "react", kind: r }]);
        }
        syncBox();
        sch.update();
      }),
      onNekoSignal((id, reactions, signal) => {
        if (signal.type === "run_start") useNekoNeeds.getState().messaged(); // 사용자가 보냈다 → 애정
        if (id === activeRef.current) {
          if (reactions.length) sch.react(reactions);
          return;
        }
        // 뒤에서 돌던 다른 세션이 끝남: 지금 쉬는 중이면 귀 쫑긋 + 꼬리 세우기로 알린다
        if (signal.type === "done") {
          const a = useNekoSessions.getState().get(activeRef.current).phase;
          if (a === "idle" || a === "result") sch.react([{ type: "react", kind: "greet" }]);
        }
      }),
      // 탭으로 쓰다듬기·'냥' → 놀이 게이지(App 의 handlePet)
      ctrl.on("pet", () => onPetRef.current()),
      ctrl.on("nyang", () => onPetRef.current()),
      // 새 대화·파일 첨부: 꼬리 물음표
      appEvents.on("nekoHint", (h) => sch.react([{ type: "tail", sign: "question", sec: h.kind === "attach" ? 1.8 : 2.5 }])),
    ];

    // 키 입력·클릭·스크롤도 '앱을 쓰는 중'(5분 뒤 잠들고, 돌아오면 깬다)
    let lastMark = 0;
    const onActive = () => {
      const now = performance.now();
      if (now - lastMark < ACTIVE_THROTTLE_MS) return;
      lastMark = now;
      useNekoApp.getState().markActive();
    };
    const winEvents = ["keydown", "pointerdown", "wheel"] as const;
    winEvents.forEach((e) => window.addEventListener(e, onActive, { passive: true, capture: true }));

    if (import.meta.env.DEV) {
      (window as unknown as { __nekoDirector?: unknown }).__nekoDirector = {
        signal: (signal: Parameters<ReturnType<typeof useNekoSessions.getState>["dispatch"]>[1], id?: string) =>
          useNekoSessions.getState().dispatch(id ?? activeRef.current, signal),
        active: () => activeRef.current,
        log: () => sch.log(),
        layer: () => sch.layer,
        app: useNekoApp,
      };
    }

    syncBox();
    sch.update();
    // ── 숨은 게이지(docs/neko-activity-mix.md §2.6·§2.7) ──
    void useNekoNeeds.getState().load();
    // 한 번짜리(간식·기지개·벽 타기)는 끝날 때 채움을 한 번에. 이어지는 활동은 1분 틱이 나눠 넣는다
    let shown: NekoActivity | null = ctrl.activity;
    offs.push(ctrl.on("activity", (a) => {
      if (shown && shown !== a && ONE_SHOT.has(shown)) useNekoNeeds.getState().oneShotDone(shown);
      shown = a;
    }));
    const needsTimer = setInterval(() => {
      const app = useNekoApp.getState();
      const idleFor = performance.now() - Math.max(app.lastActiveAt, app.outside.at);
      const how = idleFor >= DEEP_SLEEP_MS ? "sleeping" : idleFor >= SLEEPY_MS ? "dozing" : "awake";
      const doing = [ctrl.activity, ctrl.side].filter((k) => k && !ONE_SHOT.has(k));
      useNekoNeeds.getState().tick(NEEDS_TICK_MS, how, doing);
    }, NEEDS_TICK_MS);
    // 커서 따라오기는 애정이 낮을 때만(사용자 확정)
    let chase: boolean | null = null;
    const syncChase = () => {
      const on = useNekoNeeds.getState().needs.affection < CHASE_BELOW;
      if (on !== chase) { chase = on; ctrl.setChase(on); }
    };
    syncChase();
    offs.push(useNekoNeeds.subscribe(syncChase));

    return () => {
      offs.forEach((f) => f());
      clearInterval(needsTimer);
      winEvents.forEach((e) => window.removeEventListener(e, onActive, { capture: true }));
      if (boxTimer) clearTimeout(boxTimer);
      if (boxExitTimer) clearTimeout(boxExitTimer);
      syncBoxRef.current = () => {};
      sch.dispose();
      schRef.current = null;
    };
  }, [ctrl]);

  // 세션 전환: 머무름·쌓인 반응을 버리고 바로 새 세션의 계획
  useEffect(() => {
    if (activeRef.current === activeId) return;
    activeRef.current = activeId;
    syncBoxRef.current();
    schRef.current?.resetSession();
  }, [activeId]);
}
