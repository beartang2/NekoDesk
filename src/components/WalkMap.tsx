import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { mapApi, type MapSnapshot } from "../api/tauri";
import { useSettingsStore } from "../stores/settingsStore";
import { NekoWalker } from "../neko/NekoWalker";
import { positionAt, toMeters, walkEnd, walkStart, walkedAt, type LatLon, type Pt, type Walk } from "../lib/walk";
import "../neko/NekoCustomizeModal.css";
import "./WalkMap.css";

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

/**
 * 산책 지도. 가운데가 나(집), 네코는 산책 경로 위 지금 자리. 다녀온 산책이면 걸은 길 전체와 선물 받은 곳 핀.
 * 네코 자리(NekoSlot)가 산책 중에 띄우고, 다녀온 뒤엔 지도 버튼(LastWalkModal)으로 다시 본다. 크기는 담는 칸을 따른다.
 *
 * 지도를 못 받으면(개발 빌드의 위치·지도 권한 등) fallback 이 있으면 그걸, 없으면 동심원 위에 네코를 그린다.
 */
export function WalkMap({ walk, isDark, fallback, className = "" }: { walk: Walk | null; isDark: boolean; fallback?: ReactNode; className?: string }) {
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
  // 걸은 길(다녀온 뒤엔 선물 핀까지)이 좁은 쪽 변에도 다 들어오게. 50m 단위로 올려 자잘한 변화로 다시 그리지 않는다.
  const reach = Math.max(0, ...(walk ? walk.path : []).map(([x, y]) => Math.hypot(x, y)), pinPt ? Math.hypot(...pinPt) : 0);
  const spanM = Math.ceil(Math.max(MIN_SPAN_M, 2.4 * reach * Math.max(1, size.w / (size.h || 1))) / 50) * 50;

  // 칸 크기·테마·축척이 바뀔 때만 새로 받는다. 끌어서 크기를 바꾸는 동안은 기다린다.
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
  // 1초 뒤 자리와 견줘 걷는 중인지·어느 쪽으로 가는지. 들른 곳에 머무는 동안은 자리가 그대로다.
  const ahead = live ? px(positionAt(live.path, now + 1000)) : neko;
  const stepping = Math.hypot(ahead[0] - neko[0], ahead[1] - neko[1]) > 0.3;
  const facingLeft = stepping && ahead[0] < neko[0];
  // 걷는 중이면 지금까지 걸은 길, 다녀온 산책이면 길 전체(지도 위일 때만)
  const trail = live ? walkedAt(live.path, now).map(px) : map && walk?.onMap ? walk.path.map(([x, y]) => px([x, y])) : [];
  const stops = map && center && walk?.onMap && !walk.done ? walk.places.map((p) => ({ name: p.name, at: px(toMeters(center, p.lat, p.lon)) })) : [];
  const ring = Math.max(size.w, size.h) / 8;
  const fallbackOn = !map && fallback;

  return (
    <div ref={bodyRef} className={`walk-map ${fallbackOn ? "walk-map--fallback" : ""} ${className}`}>
      {fallbackOn ? fallback : (
        <>
          {map && <img className="walk-map__img" src={map.dataUrl} width={map.w} height={map.h} alt="" />}
          {visible && (
            <svg className="walk-map__overlay" width={size.w} height={size.h} aria-hidden="true">
              {!map && [1, 2, 3, 4].map((k) => <circle key={k} className="walk-map__ring" cx={size.w / 2} cy={size.h / 2} r={k * ring} />)}
              {trail.length > 1 && <polyline className="walk-map__trail" points={trail.join(" ")} />}
              {stops.map((s, i) => (
                <circle key={i} className="walk-map__stop" cx={s.at[0]} cy={s.at[1]} r={3.5}><title>{s.name}</title></circle>
              ))}
              {pinPt && map && (
                <circle className="walk-map__pin" cx={px(pinPt)[0]} cy={px(pinPt)[1]} r={5}><title>{walk?.pin?.name}</title></circle>
              )}
              <circle className="walk-map__me" cx={size.w / 2} cy={size.h / 2} r={4} />
            </svg>
          )}
          {visible && (
            <div className="walk-map__neko" style={{ left: neko[0], top: neko[1] }}>
              <NekoWalker size={24} walking={stepping} facingLeft={facingLeft} music={!!walk?.music} />
            </div>
          )}
          {live && <span className="walk-map__dist">{Math.round(Math.hypot(...at))}m</span>}
        </>
      )}
    </div>
  );
}

const TIME = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

/** 다녀온 산책 지도 창: 걸은 길과 선물 받은 곳 핀. 네코 자리의 지도 버튼이 띄운다. 꾸미기 창과 같은 틀. */
export function LastWalkModal({ walk, isDark, onClose }: { walk: Walk; isDark: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="neko-cz__backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="neko-cz walk-modal" role="dialog" aria-modal="true" aria-labelledby="walk-modal-title">
        <header className="neko-cz__header">
          <h2 id="walk-modal-title">지난 산책</h2>
          <button type="button" className="neko-cz__close" onClick={onClose} aria-label="닫기"><X size={14} /></button>
        </header>
        <div className="neko-cz__body">
          <p className="walk-modal__meta">
            {TIME.format(new Date(walkStart(walk)))}
            {walk.pin ? <> · <span className="walk-modal__pin-dot" aria-hidden="true" /> {walk.pin.name}에서 선물을 주웠어</> : null}
          </p>
          <WalkMap className="walk-modal__map" walk={walk} isDark={isDark} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
