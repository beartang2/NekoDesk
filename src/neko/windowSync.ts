import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { NekoAppearance } from "./engine/neko-engine";
import { useNekoStore, type NekoStageSettings } from "./nekoStore";
import { useNekoGifts, type NekoGift } from "./gifts";

/**
 * 메인 창과 따로 뜬 네코 창(꾸미기·선물함)이 네코 외형·자리와 선물함을 같이 본다. 스토어는 창마다 따로라,
 * 한쪽에서 바뀌면 값을 통째로 알리고 다른 창은 받은 값으로 덮는다(저장은 바꾼 창이 이미 했다 — 받은 창은 저장하지 않는다).
 * 받은 값으로 덮는 동안은 다시 알리지 않는다.
 */
type Msg<T> = { from: string; v: T };

let started = false;

export function startNekoWindowSync() {
  if (started) return;
  started = true;
  const me = getCurrentWindow().label;
  let applying = false;
  const send = <T>(ev: string, v: T) => { if (!applying) void emit(ev, { from: me, v } satisfies Msg<T>).catch(() => {}); };
  const on = <T>(ev: string, apply: (v: T) => void) =>
    void listen<Msg<T>>(ev, ({ payload }) => {
      if (payload.from === me) return;
      applying = true;
      try { apply(payload.v); } finally { applying = false; }
    }).catch(() => {});

  useNekoStore.subscribe((s, p) => {
    if (s.appearance !== p.appearance) send("neko-sync-appearance", s.appearance);
    if (s.stage !== p.stage) send("neko-sync-stage", s.stage);
  });
  useNekoGifts.subscribe((s, p) => { if (s.gifts !== p.gifts) send("neko-sync-gifts", s.gifts); });

  on<NekoAppearance>("neko-sync-appearance", (appearance) => useNekoStore.setState({ appearance }));
  on<NekoStageSettings>("neko-sync-stage", (stage) => useNekoStore.setState({ stage }));
  on<NekoGift[]>("neko-sync-gifts", (gifts) => useNekoGifts.setState({ gifts }));
}
