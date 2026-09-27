import { readFileSync } from "node:fs";

/**
 * 앱은 설정을 localStorage 에서 읽는다. 평가는 Node 에서 돌므로 환경변수로 채운다.
 *
 * NEKO_EVAL_URL           llama-server 주소 (기본 http://127.0.0.1:8803)
 * NEKO_EVAL_DECISION      fast(기본) | legacy — 도구 선택 방식
 * NEKO_EVAL_PROFILE_FILE  앱 설정의 "사용자 프로필"과 같은 내용을 담은 파일 (선택)
 *
 * 사용자 프로필은 시스템 프롬프트에 들어가므로, 앱과 같은 조건으로 재려면 넣어 주는 게 좋다.
 */
const store = new Map<string, string>();
store.set("nekodesk_llm_url", process.env.NEKO_EVAL_URL ?? "http://127.0.0.1:8803");

// NEKO_EVAL_DECISION=legacy 면 예전 방식(생각 먼저)으로 잰다. 두 방식 비교용.
if (process.env.NEKO_EVAL_DECISION === "legacy") store.set("nekodesk_fast_decision", "false");

const profileFile = process.env.NEKO_EVAL_PROFILE_FILE;
if (profileFile) store.set("nekodesk_user_profile", readFileSync(profileFile, "utf8"));

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
  configurable: true,
});
