import type { CatEmotion } from "../agent/types";
import type { NekoActivity, NekoMood, NekoPose, NekoReaction } from "./engine/neko-engine";

/**
 * 호환 레이어: 감정(CatEmotion 9개)을 v26 네코의 기분·자세·활동·반응으로 읽는다(설계 표 5.1).
 * P2 부터는 게임 훅의 onEmotionChange 와 반응에만 쓴다(에이전트는 감독이 세션 상태로 정한다).
 */
export interface NekoEmotionPlan {
  mood: NekoMood;
  pose: NekoPose;
  /** 이 감정이 시키는 활동(null 이면 감정이 시킨 활동을 끝낸다) */
  act: NekoActivity | null;
  /** 이 감정으로 바뀌는 순간 한 번 하는 반응(꼬리 언어 등) */
  react?: NekoReaction;
}

export function emotionPlan(e: CatEmotion): NekoEmotionPlan {
  switch (e) {
    case "curious": return { mood: "curious", pose: "sit", act: null }; // 생각 중: 앉아서 꼬리 살랑살랑
    case "working": return { mood: "idle", pose: "sit", act: "think" }; // 게임에서 고양이가 추리·생각하는 차례: 골똘히
    case "happy": return { mood: "happy", pose: "stand", act: null, react: "cheer" }; // 꼬리 떨기
    case "proud": return { mood: "happy", pose: "sit", act: null, react: "proud" }; // 꼬리 세우기
    case "sleepy": return { mood: "sleepy", pose: "lie", act: null };
    case "sad": return { mood: "idle", pose: "sit", act: null, react: "down" }; // 꼬리 내리기
    case "error": return { mood: "idle", pose: "stand", act: null, react: "sulk" }; // 꼬리 탁탁
    case "cozy": return { mood: "idle", pose: "stand", act: "box" };
    case "idle":
    default: return { mood: "idle", pose: "stand", act: null };
  }
}
