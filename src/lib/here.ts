import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { mapApi, settingsApi, syncApi } from "../api/tauri";
import { useSettingsStore } from "../stores/settingsStore";
import { appEvents } from "./events";
import type { LatLon } from "./walk";

/**
 * 동네: 가장 최근에 앱을 연 기기의 위치. 산책 지도(WalkMap)와 날씨가 먼저 쓴다(docs/neko-sync.md §12.4).
 *
 * 앱이 앞으로 올 때 위치를 묻고(30분 안엔 다시 안 묻는다 — 폰도 앱을 쓰는 동안만), 동기화되는 설정 neko_here 에
 * 소수 둘째 자리(약 1km)로 줄여 적는다. 기록의 (ts, device) 로 가장 늦게 적은 기기가 이긴다. 위치 권한이 없는 기기는
 * 권한 창을 띄우지 않고 적지도 않으며, 다른 기기가 적은 동네를 쓴다. 산책의 집(정확한 자리)은 hereOnce 로 따로 받는다.
 */
export const HERE_KEY = "neko_here";
export interface SharedHere extends LatLon { at: number; device: string }

const ASK_EVERY_MS = 30 * 60_000;
/** 정확한 자리를 못 받았을 때 다시 묻기까지 */
export const HERE_RETRY_MS = 10 * 60_000;
const round = (x: number) => Math.round(x * 100) / 100;

let shared: SharedHere | null = null;
/** 이 기기가 받은 정확한 자리와 받은 때 */
let mine: (LatLon & { at: number }) | null = null;
let askedAt = -Infinity;
let herePromise: Promise<LatLon | null> | null = null;
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());

function read() {
  settingsApi.get(HERE_KEY).then((raw) => {
    try {
      const v = raw ? (JSON.parse(raw) as SharedHere) : null;
      shared = v && Number.isFinite(v.lat) && Number.isFinite(v.lon) && Number.isFinite(v.at) ? v : null;
    } catch { shared = null; }
    changed();
  }).catch(() => {});
}

/** 이 기기가 자리를 받았다: 기억하고, 동네로 줄여 다른 기기에도 알린다 */
function gotHere(at: LatLon) {
  const now = Date.now();
  mine = { lat: at.lat, lon: at.lon, at: now };
  askedAt = now;
  herePromise = Promise.resolve(at);
  shared = { lat: round(at.lat), lon: round(at.lon), at: now, device: "" };
  changed();
  const value = shared;
  void syncApi.status().then((s) => s.device ?? "", () => "")
    .then((device) => settingsApi.set(HERE_KEY, JSON.stringify({ ...value, device })))
    .catch(() => {});
}

async function ask() {
  if (document.hidden || Date.now() - askedAt < ASK_EVERY_MS) return;
  askedAt = Date.now();
  // 권한 창은 띄우지 않는다: 이미 허용한 기기만 묻는다(권한은 설정의 '현재 위치'·권한 칸에서)
  if ((await invoke<string>("location_permission").catch(() => "")) !== "allowed") return;
  const at = await mapApi.here().catch(() => null);
  if (at) gotHere(at);
}

/** 앱이 앞으로 올 때마다 위치를 묻고, 다른 기기가 적은 동네를 받는다. App 이 한 번 부른다 */
export function watchHere(): () => void {
  read();
  void ask();
  const onFront = () => void ask();
  document.addEventListener("visibilitychange", onFront);
  window.addEventListener("focus", onFront);
  const off = appEvents.on("syncChanged", ({ colls }) => { if (colls.includes("setting")) read(); });
  return () => {
    document.removeEventListener("visibilitychange", onFront);
    window.removeEventListener("focus", onFront);
    off();
  };
}

/** 이 기기가 가장 최근이면 정확한 자리, 다른 기기가 더 늦게 적었으면 그 동네. 둘 다 없으면 null */
const best = (): LatLon | null => (mine && (!shared || mine.at >= shared.at) ? mine : shared);
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** 지도·날씨의 가운데 */
export const useHere = () => useSyncExternalStore(subscribe, best);

/**
 * 이 기기의 정확한 자리(산책을 떠날 때의 집). 받으면 계속 그걸 쓴다 — 15초까지 걸리고 권한을 물을 수도 있다.
 * 앱이 앞으로 올 때 새로 받으면(watchHere) 그걸로 바뀐다.
 *
 * 못 받으면 다른 기기가 적은 동네, 그것도 없으면 날씨 칸의 위치(좌표나 "대전" 같은 동네 이름)로 대신하고
 * (그것도 못 찾으면 null — 지도 없이 동심원) HERE_RETRY_MS 뒤 다시 묻는다. `tauri dev` 의 맨 실행 파일은
 * 위치 서비스가 누군지 몰라(identity unverified) 권한 창도 없이 60초 뒤 실패했다.
 */
export const hereOnce = () =>
  (herePromise ??= mapApi.here().then(
    (at) => { gotHere(at); return at; },
    () => {
      setTimeout(() => (herePromise = null), HERE_RETRY_MS);
      if (shared) return { lat: shared.lat, lon: shared.lon };
      return mapApi.weatherSpot(useSettingsStore.getState().weatherLocation).catch(() => null);
    },
  ));
