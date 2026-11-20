/**
 * 모델 답에 섞여 오는 표시용 태그를 한 곳에서 뗀다. 채팅(useAgentLoop·App)과 선물·가구 설명(gifts·furniture)이 같이 쓴다.
 * - 생각 `<think>…</think>`: 닫힌 블록과 아직 안 닫힌 꼬리(흘러나오는 중) 모두
 * - 감정 `[[PET_STATE:happy]]`: 시스템 프롬프트가 답 끝에 붙이게 한다(agent/llm-client) — 화면·저장 글엔 안 보인다
 */

/** 감정 태그 하나(첫 번째)를 잡는다. 1번 묶음 = 감정 이름 */
export const PET_STATE_RE = /\[\[PET_STATE:(\w+)\]\]/;
const PET_STATE_ALL = /\[\[PET_STATE:\w+\]\]/g;

/** 생각 블록을 걷어 낸다. 안 닫힌 꼬리도 지워야 흘러나오는 동안 생각이 답처럼 찍혔다 사라지는 깜빡임이 없다 */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
}

/** 감정 태그만 지운다(앞뒤 다듬기는 부르는 쪽) */
export const stripPetState = (text: string): string => text.replace(PET_STATE_ALL, "");

/** 사람에게 보일 글: 생각·감정 태그를 떼고 앞뒤 빈칸·줄바꿈을 다듬는다(선물·가구 설명) */
export function cleanShownText(text: string): string {
  return stripPetState(stripThink(text)).replace(/[ \t]+$/gm, "").trim();
}
