import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { syncWindowTheme } from "../lib/window-theme";
import { SIDES, TRAIL, blobs, fadeEdges, flowEdges, hideEdges, type Point } from "./edge-flow";
import "./CaptureOverlay.css";

/** 테두리에 붙은 뒤 빛나 있는 시간, 스러지는 시간. 캡처 막처럼 3.6초에 한 번 숨 쉰다. */
const HOLD_MS = 5200;
const FADE_MS = 1400;

interface GlowAt {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 일정 알림 때 뜨는 빛 창(glow.rs). 캡처 막의 가장자리 빛을 커서에서 퍼뜨려 테두리에 붙이고, 잠깐
 * 숨 쉬다 스러지면 창을 숨긴다. 클릭은 창을 지나 뒤로 간다.
 */
export function GlowAlert() {
  const [play, setPlay] = useState<(GlowAt & { id: number }) | null>(null);
  const band = useRef<HTMLDivElement>(null);
  const swarm = useRef<HTMLDivElement>(null);
  const blobEls = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    // 막 만든 창은 Rust 가 보낸 glow-alert 를 못 들었을 수 있다. 열리자마자 한 번 가져간다.
    const take = () => {
      invoke<GlowAt | null>("glow_take")
        .then((at) => {
          if (!at) return;
          syncWindowTheme(false);
          setPlay({ ...at, id: performance.now() });
        })
        .catch(() => {});
    };
    take();
    const unlisten = listen("glow-alert", take, { target: getCurrentWindow().label });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useLayoutEffect(() => {
    if (!play) {
      hideEdges(band.current);
      return;
    }
    const at: Point = [play.x, play.y];
    flowEdges(band.current, swarm.current, blobEls.current, blobs(play.w, play.h), "in", at, play.w, play.h);
    const fade = window.setTimeout(() => fadeEdges(band.current, FADE_MS), HOLD_MS);
    const done = window.setTimeout(() => {
      getCurrentWindow().hide().catch(() => {});
      setPlay(null);
    }, HOLD_MS + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(done);
    };
  }, [play]);

  const layout = play ? blobs(play.w, play.h) : [];
  // 캡처 막과 같은 틀(.cap[data-revealed]) 안에 둔다. 그 밖의 .cap__ambient 는 투명하다.
  return (
    <div className="cap" data-revealed aria-hidden>
    <div className="cap__ambient">
      <div className="cap__glow">
        <div className="cap__band" ref={band}>
          {SIDES.map((side) => (
            <div key={side} className={`cap__edge cap__edge--${side}`} />
          ))}
        </div>
        <div className="cap__swarm" ref={swarm}>
          {layout.flatMap((b, i) =>
            Array.from({ length: TRAIL }, (_, k) => (
              <div
                key={`${i}-${k}`}
                ref={(el) => {
                  blobEls.current[i * TRAIL + k] = el;
                }}
                className="cap__edge cap__blob"
                style={{ left: b.x - b.w / 2, top: b.y - b.h / 2, width: b.w, height: b.h }}
              />
            ))
          )}
        </div>
      </div>
    </div>
    </div>
  );
}
