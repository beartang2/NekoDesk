import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * macOS 알림으로 네코가 말을 건다 — 사용자가 다른 창에 가 있을 때만.
 *
 * 창을 보고 있는데 알림까지 뜨면 같은 말을 두 번 듣는다. `document.hasFocus()`
 * 는 이 웹뷰의 창이 키 윈도우일 때만 true 라, 다른 앱에 있거나 창이 숨겨져
 * 있으면 false 다.
 */

/** 알림 본문으로 쓸 수 있게 마크다운 흔적을 걷어내고 짧게 자른다. */
export function toNotificationBody(markdown: string, max = 160): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " (코드) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*\|?\s*:?-{3,}.*$/gm, "")
    .replace(/[*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

// 권한은 한 번만 묻는다. 거절했으면 조용히 안 보낸다.
let permission: Promise<boolean> | null = null;

function ensurePermission(): Promise<boolean> {
  permission ??= (async () => {
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  })().catch(() => false);
  return permission;
}

export async function notifyIfAway(title: string, body: string): Promise<void> {
  if (document.hasFocus() || !body) return;
  // 알림은 덤이다. 실패해도 대화 흐름을 건드리지 않는다.
  try {
    if (await ensurePermission()) sendNotification({ title, body });
  } catch {
    /* ignore */
  }
}
