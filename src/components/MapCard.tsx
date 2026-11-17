import { useEffect, useRef, useState } from "react";
import { Map as MapIcon } from "lucide-react";
import { mapApi, type MapSnapshot } from "../api/tauri";
import { useSettingsStore } from "../stores/settingsStore";
import { NekoPortrait } from "../neko/NekoPortrait";
import { positionAt, toMeters, walkEnd, walkedAt, type LatLon, type Pt, type Walk } from "../lib/walk";
import "./MapCard.css";

/**
 * 이번 앱 세션의 내 위치. 받으면 계속 그걸 쓴다 — 15초까지 걸리고 권한을 물을 수도 있어서 매번 묻지 않는다.
 * 산책을 떠날 때(App)도 이걸 쓴다.
 *
 * 못 받으면 날씨 칸의 위치(좌표나 "대전" 같은 동네 이름)로 대신하고(그것도 못 찾으면 지도 없이 동심원),
 * HERE_RETRY_MS 뒤 다시 묻는다 — 권한을 켜거나 위치가 잡히면 진짜 자리로 옮겨 간다. `tauri dev` 의 맨
 * 실행 파일은 위치 서비스가 누군지 몰라(identity unverified) 권한 창도 없이 60초 뒤 실패했다.
 */
const HERE_RETRY_MS = 10 * 60_000;
let herePromise: Promise<LatLon | null> | null = null;
export const hereOnce = () =>
  (herePromise ??= mapApi.here().catch(() => {
    setTimeout(() => (herePromise = null), HERE_RETRY_MS);
    return mapApi.weatherSpot(useSettingsStore.getState().weatherLocation).catch(() => null);
  }));

/** 이보다 가까이는 당기지 않는다 — 동네가 안 보인다. */
const MIN_SPAN_M = 400;

/** 산책 지도. 가운데가 나(집), 네코는 산책 경로 위 지금 자리. 다녀오면 선물 받은 곳에 핀. */
export function MapCard({ walk, isDark }: { walk: Walk | null; isDark: boolean }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [here, setHere] = useState<LatLon | null>(null);
  const [snap, setSnap] = useState<(MapSnapshot & { w: number; h: number }) | null>(null);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 숨은 카드(자리가 모자라 RightPanel 이 접음)는 위치를 묻지 않는다 — 실제로 보일 때 처음 묻는다.
  const visible = size.w > 0 && size.h > 0;
  // 받은 위치는 같은 객체라 다시 불러도 그대로다. 대신 쓴 좌표였으면 그사이 진짜 위치로 바뀐다.
  useEffect(() => {
    if (!visible) return;
    const look = () => void hereOnce().then(setHere);
    look();
    const id = setInterval(look, HERE_RETRY_MS);
    return () => clearInterval(id);
  }, [visible]);

  // 지금 걷는 중인 산책. 다녀와서 보고를 기다리는 동안은 이미 집이다.
  const live = walk && !walk.done && now < walkEnd(walk) ? walk : null;
  const walking = !!live;
  useEffect(() => {
    if (!walking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [walking]);

  // 산책 경로는 집 기준이라 실제 길로 걸었으면 그 집이 가운데다.
  const center = walk?.onMap && walk.home ? walk.home : here;
  const pinPt = center && walk?.done && walk.pin ? toMeters(center, walk.pin.lat, walk.pin.lon) : null;
  // 산책 범위(다녀온 뒤엔 선물 핀)가 좁은 쪽 변에도 다 들어오게. 50m 단위로 올려 자잘한 변화로 다시 그리지 않는다.
  const reach = Math.max(0, ...(walk && !walk.done ? walk.path : []).map(([x, y]) => Math.hypot(x, y)), pinPt ? Math.hypot(...pinPt) : 0);
  const spanM = Math.ceil(Math.max(MIN_SPAN_M, 2.4 * reach * Math.max(1, size.w / (size.h || 1))) / 50) * 50;

  // 카드 크기·테마·축척이 바뀔 때만 새로 받는다. 끌어서 크기를 바꾸는 동안은 기다린다.
  useEffect(() => {
    if (!center || !visible) return;
    let current = true;
    const { w, h } = size;
    const id = setTimeout(() => {
      mapApi
        .snapshot({ lat: center.lat, lon: center.lon, spanM, width: w, height: h, dark: isDark })
        .then((s) => current && setSnap({ ...s, w, h }))
        .catch(() => current && setSnap(null));
    }, 400);
    return () => {
      current = false;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.lat, center?.lon, spanM, size.w, size.h, isDark, visible]);

  // 대체 경로(실제 길이 아님)를 걷는 동안은 지도 위에 그리면 건물을 뚫고 다닌다 — 동심원만.
  const map = snap && center && !(live && !live.onMap) ? snap : null;
  const mpp = map ? map.metersPerPx : spanM / (size.w || 1);
  const px = ([x, y]: Pt): Pt => [size.w / 2 + x / mpp, size.h / 2 - y / mpp];

  const at = live ? positionAt(live.path, now) : ([0, 0] as Pt);
  const neko = px(at);
  const trail = live ? walkedAt(live.path, now).map(px) : [];
  const stops = map && center && walk?.onMap && !walk.done ? walk.places.map((p) => ({ name: p.name, at: px(toMeters(center, p.lat, p.lon)) })) : [];
  const ring = Math.max(size.w, size.h) / 8;

  return (
    <div className="panel-card panel-card--map">
      <div className="panel-card__header">
        <span className="draw-header-title"><MapIcon size={10} strokeWidth={2} /> 지도</span>
        {live && <span className="map-card__dist">{Math.round(Math.hypot(...at))}m</span>}
      </div>
      <div ref={bodyRef} className="map-card__body">
        {map && <img className="map-card__img" src={map.dataUrl} width={map.w} height={map.h} alt="" />}
        {visible && (
          <svg className="map-card__overlay" width={size.w} height={size.h} aria-hidden="true">
            {!map && [1, 2, 3, 4].map((k) => <circle key={k} className="map-card__ring" cx={size.w / 2} cy={size.h / 2} r={k * ring} />)}
            {trail.length > 1 && <polyline className="map-card__trail" points={trail.join(" ")} />}
            {stops.map((s, i) => (
              <circle key={i} className="map-card__stop" cx={s.at[0]} cy={s.at[1]} r={3.5}><title>{s.name}</title></circle>
            ))}
            {pinPt && map && (
              <circle className="map-card__pin" cx={px(pinPt)[0]} cy={px(pinPt)[1]} r={5}><title>{walk?.pin?.name}</title></circle>
            )}
            <circle className="map-card__me" cx={size.w / 2} cy={size.h / 2} r={4} />
          </svg>
        )}
        {visible && (
          <div className="map-card__neko" style={{ left: neko[0], top: neko[1] }}>
            <NekoPortrait size={24} />
          </div>
        )}
      </div>
    </div>
  );
}
