import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";
import { setTimeZone } from "../lib/time";

/** 지금 날씨(Rust weather_now). 방·거실 창문이 같이 쓴다 */
export interface WeatherNow {
  place: string;
  label: string;
  emoji: string;
  temp: number;
  /** IANA 시간대("Asia/Seoul"). 앱의 시각 표시가 이걸 따른다(lib/time). */
  timezone: string;
  /** WMO 날씨 코드. 모르면 -1 */
  code: number;
  is_day: boolean;
  /** 오늘 해 뜨고 지는 때(유닉스 초). 없으면 null */
  sunrise: number | null;
  sunset: number | null;
}

const WEATHER_STALE_MS = 30 * 60 * 1000;
/** 받은 날씨가 이만큼 오래되도록 새로 못 받으면 커튼을 닫는다 */
const GIVE_UP_MS = 2 * 60 * 60 * 1000;

// 창문이 둘(방·거실)이어도 한 번만 받는다: 쓰는 곳이 하나라도 있으면 돌고, 다 빠지면 멈춘다
let now: WeatherNow | null = null;
let users = 0;
let stop: (() => void) | null = null;
let running = "";
const subs = new Set<() => void>();
const set = (w: WeatherNow | null) => { now = w; subs.forEach((f) => f()); };

function start(location: string) {
  if (running === location && stop) return;
  stop?.();
  running = location;
  set(null);
  if (!location) { setTimeZone(undefined); stop = () => {}; return; }
  let alive = true;
  let fetchedAt = 0;
  let okAt = 0;
  const load = () => {
    fetchedAt = Date.now();
    invoke<WeatherNow>("weather_now", { location })
      .then((w) => { if (alive) { okAt = Date.now(); set(w); setTimeZone(w.timezone); } })
      // 못 받으면 커튼을 닫는다. 다시 보다 한 번 놓친 건 넘긴다 — 받은 지 오래됐을 때만(인터넷이 오래 끊김)
      .catch(() => { if (alive && Date.now() - okAt > GIVE_UP_MS) set(null); });
  };
  load();
  // 30분짜리 타이머는 잠자는 동안 멈춰서, 밤새 자고 깨도 30분을 더 기다린다.
  // 1분마다 벽시계로 오래됐는지만 본다 — 깨고 1분 안에 새로 받는다.
  const t = setInterval(() => { if (Date.now() - fetchedAt > WEATHER_STALE_MS) load(); }, 60 * 1000);
  stop = () => { alive = false; clearInterval(t); };
}

/** 지금 날씨. 위치가 없거나 못 가져오면 null. 30분 지나면 다시 본다 */
export function useWeatherNow(): WeatherNow | null {
  const location = useSettingsStore((s) => s.weatherLocation.trim());
  useEffect(() => {
    users++;
    start(location);
    return () => {
      if (--users === 0) { stop?.(); stop = null; running = ""; }
    };
  }, [location]);
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => now);
}
