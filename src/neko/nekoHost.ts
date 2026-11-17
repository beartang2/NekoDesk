import { useSyncExternalStore } from "react";
import { createNeko, type NekoController } from "./engine/neko-engine";
import { useNekoStore } from "./nekoStore";
import { getRemoteNeko, onRemoteNeko } from "./remoteNeko";
import { useNekoGifts } from "./gifts";
import { nekoNameOf, useSettingsStore } from "../stores/settingsStore";

/**
 * 네코는 앱에 하나다: 캔버스 하나 + 엔진 하나를 모듈에 두고, 자리(NekoSlot)가 바뀌면 캔버스만 옮긴다.
 * 그래서 사이드바 ↔ 채팅 바 아래로 옮겨도 하던 활동·자세·꼬리가 그대로 이어진다.
 */

let canvas: HTMLCanvasElement | null = null;
let ctrl: NekoController | null = null;
const subs = new Set<() => void>();

export function nekoCanvas(): HTMLCanvasElement {
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "neko-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    const label = (s = useSettingsStore.getState()) =>
      `고양이 ${nekoNameOf(s)}. 누르면 쓰다듬고, 빠르게 두 번 누르면 뛰어올라요. 누른 채로 끌면 목덜미를 잡아 들어 올려요.`;
    canvas.setAttribute("aria-label", label());
    useSettingsStore.subscribe((s) => canvas?.setAttribute("aria-label", label(s)));
  }
  return canvas;
}

/** 캔버스가 문서에 붙은 뒤(크기가 생긴 뒤) 처음 부를 때 엔진을 만든다. */
export function ensureNeko(): NekoController {
  if (!ctrl) {
    ctrl = createNeko(nekoCanvas(), { appearance: useNekoStore.getState().appearance });
    // 외형은 스토어를 따른다(설정에서 바꾸면 바로)
    useNekoStore.subscribe((s, prev) => {
      if (s.appearance !== prev.appearance) ctrl?.setAppearance(s.appearance);
    });
    // 선물함에서 바닥에 놓은 물건(docs/neko-gifts.md)
    const decor = () => ctrl?.setDecor(useNekoGifts.getState().gifts.flatMap((g) => (g.placed ? [{ id: g.id, u: g.placed.u, shape: g.shape }] : [])));
    useNekoGifts.subscribe((s, prev) => { if (s.gifts !== prev.gifts) decor(); });
    void useNekoGifts.getState().load().then(decor);
    subs.forEach((fn) => fn());
  }
  return ctrl;
}

// 모니터 화면 자리면 엔진은 화면 창에 있다(remoteNeko). 여기 엔진은 쉰다 — 다른 자리로 돌아오면 NekoSlot 이 resume
useNekoStore.subscribe((s) => { if (s.stage.placement === "screen") ctrl?.pause(); });

/** 엔진이 만들어지면 다시 그린다(그 전엔 null). 모니터 화면 자리면 화면 창 엔진의 대리(준비 전엔 null). */
export function useNekoController(): NekoController | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      const off = onRemoteNeko(fn);
      return () => { subs.delete(fn); off(); };
    },
    () => (useNekoStore.getState().stage.placement === "screen" ? getRemoteNeko() : ctrl),
  );
}
