import { useSyncExternalStore } from "react";
import { createNeko, type NekoController } from "./engine/neko-engine";
import { useNekoStore } from "./nekoStore";
import { getRemoteNeko, onRemoteNeko } from "./remoteNeko";
import { decorItems, useNekoGifts } from "./gifts";
import { onWeatherNow, weatherNowSnapshot } from "./weatherNow";
import { setHolding } from "./holding";
import { nekoNameOf, useSettingsStore } from "../stores/settingsStore";
import { stageS } from "./engine/stage-scale";
import { startFurnitureHost } from "./furnitureHost";
import { useNekoApp } from "./director/stores";

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

let wallCanvas: HTMLCanvasElement | null = null;
/** 벽에 건 선물만 그리는 층(엔진 setWallCanvas). 자리(NekoSlot)가 정지 가구 층 밑에 붙인다 — 액자가 가구 위에 걸려 보이지 않게(사용자) */
export function nekoWallCanvas(): HTMLCanvasElement {
  if (!wallCanvas) {
    wallCanvas = document.createElement("canvas");
    wallCanvas.className = "neko-canvas neko-canvas--wall";
    wallCanvas.setAttribute("aria-hidden", "true");
  }
  return wallCanvas;
}

/** 캔버스가 문서에 붙은 뒤(크기가 생긴 뒤) 처음 부를 때 엔진을 만든다. */
export function ensureNeko(): NekoController {
  if (!ctrl) {
    ctrl = createNeko(nekoCanvas(), { appearance: useNekoStore.getState().appearance });
    ctrl.setWallCanvas(nekoWallCanvas());
    ctrl.setToys(true); // 낚싯대 바구니(같이 놀기)
    // 가구: 놓인 것을 엔진에 넘기고, 조명 켜짐·활동 중 잡은 가구를 받는다(furnitureHost)
    startFurnitureHost(ctrl);
    // 무대 배율은 stage-scale 한 곳: 폰은 고양이·선물을 70% 로, 맥 거실은 기본 높이부터 멈춘다. 무대 크기·장소가 바뀔 때마다 넘긴다
    {
      const cv = nekoCanvas();
      const fit = () => { if (cv.clientWidth && cv.clientHeight) ctrl?.setScale(stageS(cv.clientWidth, cv.clientHeight - 6, useNekoStore.getState().stage.placement)); };
      new ResizeObserver(fit).observe(cv);
      useNekoStore.subscribe((s, prev) => { if (s.stage.placement !== prev.stage.placement) fit(); });
    }
    // 외형은 스토어를 따른다(설정에서 바꾸면 바로)
    useNekoStore.subscribe((s, prev) => {
      if (s.appearance !== prev.appearance) ctrl?.setAppearance(s.appearance);
    });
    // 선물함에서 지금 장소(방·거실)에 놓은 물건(docs/neko-gifts.md). 마당은 화면 창 엔진이 그린다(remoteNeko)
    const decor = () => ctrl?.setDecor(decorItems(useNekoGifts.getState().gifts, useNekoStore.getState().stage.placement));
    useNekoStore.subscribe((s, prev) => { if (s.stage.placement !== prev.stage.placement) decor(); });
    // 무대에서 끌어 옮기면 선물함에 적는다(우클릭 '정리'는 자리 쪽 버튼이 한다 — NekoSlot)
    ctrl.on("decorMove", ({ id, ...spot }) => useNekoGifts.getState().place(id, spot));
    ctrl.on("decorPlayed", ({ id, at }) => useNekoGifts.getState().played(id, at));
    ctrl.on("hold", setHolding); // 잡은 동안 폰 가장자리 손짓을 막는다
    // 무대에서 같이 놀기(던진 장난감·낚싯대): 감독 놀아주기로 넘긴다 — 놀 수 있으면 감독이 chase·wand 를 시킨다
    ctrl.on("play", ({ kind }) => useNekoApp.getState().play(kind));
    useNekoGifts.subscribe((s, prev) => { if (s.gifts !== prev.gifts) decor(); });
    void useNekoGifts.getState().load().then(decor);
    // 방·거실 벽의 날씨 창문: '창밖 구경'이 그 아래로 간다. 날씨가 없으면 커튼이 닫혀 있다(WeatherWindow)
    const roomWin = () => { const p = useNekoStore.getState().stage.placement; ctrl?.setRoomWindow(p === "screen" ? null : p, !!weatherNowSnapshot()); };
    useNekoStore.subscribe((s, prev) => { if (s.stage.placement !== prev.stage.placement) roomWin(); });
    onWeatherNow(roomWin);
    roomWin();
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
