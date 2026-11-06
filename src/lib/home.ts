import { homeDir } from "@tauri-apps/api/path";

/**
 * 홈 경로(`/Users/<이름>`)를 `~` 로 바꿔 보인다 — 답·도구 기록에 사용자 이름이 찍히지 않게, Claude 로도
 * 안 나가게. 저장된 기록은 그대로다. 툴은 `~` 를 풀어 쓰니(guard::expand_tilde, exec::run_dir) 모델이
 * `~/…` 로 받아도 일이 된다.
 */
let home = "";

/** 켤 때 한 번. 못 가져오면 바꾸지 않는다. */
export function loadHome(): Promise<void> {
  return homeDir()
    .then((h) => { home = h.replace(/\/+$/, ""); })
    .catch(() => {});
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function maskHome(text: string, h = home): string {
  if (!h || !text || !text.includes(h)) return text;
  // `/Users/kim` 은 바꾸고 `/Users/kimchi` 는 두게, 뒤에 이름이 더 이어지지 않을 때만.
  return text.replace(new RegExp(`${escape(h)}(?![\\w.-])`, "g"), "~");
}
