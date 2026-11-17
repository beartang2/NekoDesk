import { useEffect, useRef } from "react";
import type { CatEmotion } from "../agent/types";
import { appEvents } from "../lib/events";
import type { NekoActivity } from "./engine/neko-engine";
import { emotionPlan } from "./emotionMap";
import { useNekoController } from "./nekoHost";

/**
 * 앱 상태 → 네코(P1 호환 레이어). 지금 앱의 표시 감정을 그대로 받아 기분·자세·활동·반응으로 옮기고,
 * 밥 주기·놀아주기 신호(appEvents "nekoCue")에 맞는 활동을 시킨다. 도구별 활동·결과 반응은 감독(P2).
 */
export function useNekoBridge({ emotion, isDark, onPet }: { emotion: CatEmotion; isDark: boolean; onPet: () => void }) {
  const ctrl = useNekoController();
  const prevEmotion = useRef<CatEmotion | null>(null);
  /** 감정이 시킨 활동(감정이 바뀌면 이것만 끝낸다. 밥·놀이처럼 스스로 끝나는 활동은 건드리지 않음) */
  const emotionAct = useRef<NekoActivity | null>(null);
  const playToggle = useRef(false);
  const onPetRef = useRef(onPet);
  onPetRef.current = onPet;

  useEffect(() => { ctrl?.setTheme({ dark: isDark }); }, [ctrl, isDark]);

  // 탭으로 쓰다듬기·'냥' → 놀이 게이지(예전 스프라이트 고양이의 onPet 과 같음)
  useEffect(() => {
    if (!ctrl) return;
    const offs = [ctrl.on("pet", () => onPetRef.current()), ctrl.on("nyang", () => onPetRef.current())];
    return () => offs.forEach((f) => f());
  }, [ctrl]);

  useEffect(() => {
    if (!ctrl || prevEmotion.current === emotion) return;
    const first = prevEmotion.current === null;
    prevEmotion.current = emotion;
    const plan = emotionPlan(emotion);
    ctrl.setMood(plan.mood);
    ctrl.setPose(plan.pose);
    if (plan.act) {
      ctrl.act(plan.act);
      emotionAct.current = plan.act;
    } else if (emotionAct.current && ctrl.activity === emotionAct.current) {
      ctrl.act(null);
      emotionAct.current = null;
    }
    if (plan.react && !first) ctrl.react(plan.react);
  }, [ctrl, emotion]);

  // 밥 주기 = 간식 먹기, 놀아주기 = 털실·나비 번갈아
  useEffect(() => {
    if (!ctrl) return;
    return appEvents.on("nekoCue", (cue) => {
      if (cue.kind === "feed") ctrl.act("snack");
      else {
        playToggle.current = !playToggle.current;
        ctrl.act(playToggle.current ? "yarn" : "butterfly");
      }
      emotionAct.current = null; // 감정 변화로 끊지 않는다(스스로 끝남)
    });
  }, [ctrl]);
}
