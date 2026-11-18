import { listen } from "@tauri-apps/api/event";
import { SYNC_CHANGED, type SyncChanged } from "../api/tauri";
import { hydrateSessions, pruneOldSessions } from "../stores/sessionStore";
import { hydrateSyncedSettings, useSettingsStore } from "../stores/settingsStore";
import { useNekoStore } from "../neko/nekoStore";
import { useNekoGifts } from "../neko/gifts";

/**
 * 메인 창: 세션 목록·같이 쓰는 설정을 DB 에서 읽고, 동기화가 다른 기기에서 받아 온 것(sync-changed)으로 스토어를
 * 다시 읽는다(docs/neko-sync.md §2.6). 열린 세션의 메시지는 App 이 따로 다시 읽는다. 동기화가 꺼져 있으면 이벤트가
 * 안 오고, 켤 때 한 번 읽기만 한다.
 */
export function startSync(): void {
  void hydrateSyncedSettings();
  void hydrateSessions().catch(() => {});
  void listen<SyncChanged>(SYNC_CHANGED, ({ payload }) => {
    if (payload.colls.includes("session") || payload.sessions.length) void hydrateSessions().catch(() => {});
    if (payload.colls.includes("setting")) {
      void hydrateSyncedSettings();
      void useNekoStore.getState().load();
    }
    if (payload.colls.includes("gift")) void useNekoGifts.getState().reload();
    // 켜져 있으면 오래된 대화 지우기는 이번 실행에서 한 번 다 맞춘 뒤에야 돈다(백엔드가 그 전엔 빈 목록)
    if (payload.first) void pruneOldSessions(useSettingsStore.getState().sessionRetention).catch(() => {});
  });
}
