import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { createNeko, type NekoController, type NekoEvents, type NekoMood } from "./engine/neko-engine";
import { useTrackpadPet } from "../hooks/useTrackpadPet";
import { useNekoStore } from "./nekoStore";
import type { NekoCmd, NekoEvt } from "./remoteNeko";
import "./NekoScreen.css";

/**
 * 화면 창(neko-screen) — 주 모니터 전체를 덮는 투명 창에서 네코가 산다(docs/neko-screen-mode.md).
 *
 * - 엔진은 앱에서 여기 하나만 돈다. 메인 창 감독이 `neko-cmd` 로 부리고, 엔진 이벤트는 `neko-evt` 로 돌려준다.
 * - 클릭은 평소 뒤로 지나간다. Rust 가 커서를 보내 주면(`neko-screen-cursor`) 여기서 hit 로 고양이
 *   위인지 보고 `neko_screen_catch` 로 알린다. 클릭 통과를 켜고 끄는 건 Rust 만 한다.
 * - 쓰다듬기(문지르기)도 그 커서로 센다 — 키 창이 아닌 창이라 웹뷰가 mousemove 를 못 받을 수 있다.
 * - 여러 모니터: 커서가 다른 모니터에 한동안 있으면(`neko-screen-away`) 그쪽으로 걸어 나간다. 끝을 넘으면
 *   Rust 가 창을 그 모니터로 옮기고(`neko-screen-moved`, 잡고 끌 때도) 여기서 세계를 옮긴다.
 * - 마당 선물은 모니터마다 선물 창(NekoDecorScreen)이 그린다. 여기 엔진은 갖고 노느라 잡은 것만 그리고 `decorHeld` 로 알린다.
 */

interface Layout { w: number; h: number; ground: number }
type Side = "left" | "right";
interface Moved { layout: Layout; shift: [number, number] }
type Perches = Parameters<NekoController["setPerches"]>[0];
/** 개발 빌드 캣타워 표시: 창마다 자리·앱·층·발판이 없는 까닭(Rust neko-screen-perch-debug) */
interface PerchDebug { win: number; owner: string; layer: number; rect: [number, number, number, number]; why: string | null }

/** 잡고 끄는 동안은 설정과 상관없이 60. 졸 때는 설정의 절반 */
const HELD_FPS = 60;
/** 놓은 뒤 떨어지는 동안은 부드럽게 */
const FALL_MS = 1500;
/** 고양이 위에 있는 동안 이 간격으로 Rust 에 다시 알린다(Rust 는 0.25초 안에 소식이 없으면 클릭을 흘린다) */
const CATCH_EVERY_MS = 100;
/** 커서가 가만있어도 고양이가 그 밑으로 걸어오거나 떠난다 — 이 간격으로 hit 를 다시 본다 */
const CHECK_EVERY_MS = 33;
/** 화면 창이 스스로 다루는 것. 메인 창 명령으로는 부르지 않는다 */
const LOCAL_ONLY: ReadonlySet<string> = new Set([
  "pause", "resume", "resize", "destroy", "setMaxFps", "setScale", "setGround", "on", "shiftWorld", "setEdges", "walkOut", "setPerches",
]);
/** 고양이 자리를 Rust 에 다시 알리는 움직임(px). 캣타워 '창 근처' 판단용이라 거칠어도 된다 */
const CAT_AT_STEP = 60;
const CLOSED = { left: false, right: false } as const;
/** 다른 모니터로 걸어 나가라고 다시 이르는 간격(하던 활동이 끝나 한가해졌을 때 이어 가게) */
const WALK_OUT_EVERY_MS = 1000;
const FORWARD: (keyof NekoEvents)[] = ["pet", "nyang", "annoyed", "grab", "drop", "activity", "error", "decorMove", "decorPlayed", "decorHeld"];
/** 마당 선물 '정리' 버튼이 저절로 닫히는 때 */
const MENU_MS = 6000;

const toMain = (e: NekoEvt) => void emitTo("main", "neko-evt", e).catch(() => {});

export function NekoScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<NekoController | null>(null);
  // 우클릭 메뉴 버튼 하나. 마당 선물이면 그 오른쪽 위에 '정리'(NekoSlot 과 같다, 누르면 메인 창이 선물함으로 치운다),
  // 고양이면 누른 자리에 '숨기기'(마당을 숨긴다 — 이 앱이 맨 앞으로 오면 다시 보인다). 다른 데 누르거나 몇 초 뒤 닫힌다
  const [menu, setMenu] = useState<{ id?: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  // 개발 빌드: 발판(초록)·벽(파랑)·창마다 빠진 까닭을 화면에 그린다
  const [debug, setDebug] = useState<{ wins: PerchDebug[]; p: Perches } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const t = setTimeout(() => setMenu(null), MENU_MS);
    return () => clearTimeout(t);
  }, [menu]);
  const { onBodyMove, onBodyLeave, setHeld, setPressed } = useTrackpadPet(() => {
    // 너무 오래 만져 짜증 나면(react 가 false) 놀이 게이지는 오르지 않는다
    if (ctrlRef.current?.react("pet")) toMain({ ev: "pet" });
  });
  const petRef = useRef({ onBodyMove, onBodyLeave, setHeld, setPressed });
  petRef.current = { onBodyMove, onBodyLeave, setHeld, setPressed };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 세계 모드(설계 §2): 세계는 창 전체 = 주 모니터. 캔버스는 고양이 둘레만 덮고 엔진이 매 프레임 옮긴다.
    // 좌표는 Rust 커서·포인터·hit 모두 창 좌표 그대로다
    const ctrl = createNeko(canvas, {
      transparent: true,
      world: true,
      scale: useNekoStore.getState().stage.screenScale,
      appearance: useNekoStore.getState().appearance,
    });
    ctrlRef.current = ctrl;

    let mood: NekoMood = "idle";
    let held = false;
    let fallTimer: ReturnType<typeof setTimeout> | undefined;
    let maxFps: number = useNekoStore.getState().stage.screenFps; // 곧 메인 창 설정값이 온다(neko-screen-fps)
    const fps = () => ctrl.setMaxFps(held ? HELD_FPS : mood === "sleepy" ? maxFps / 2 : maxFps);
    fps();

    // 커서 → 고양이 위인지
    let cursor: [number, number] | null = null;
    let over: "cat" | "other" | null = null;
    let sentAt = 0;
    let active = true;
    // 고양이·갖고 노느라 잡은 마당 선물(엔진이 그린다 — 나머지는 선물 창 몫)·메뉴 버튼 위면 클릭을 받는다
    const overMenu = (x: number, y: number) => {
      const r = menuRef.current?.getBoundingClientRect();
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    // 고양이 위인지도 같이 알린다 — 잡고 다른 모니터로 끌 때 창이 따라가는 건 고양이뿐이다(선물은 이 화면 끝에서 멈춘다)
    const check = () => {
      const now = performance.now();
      const [x, y] = cursor ?? [0, 0];
      const o = !active || !cursor ? null : ctrl.hit(x, y) ? "cat" : ctrl.hitDecor(x, y) !== null || overMenu(x, y) ? "other" : null;
      if (o === over && !(o && now - sentAt > CATCH_EVERY_MS)) return;
      over = o;
      sentAt = now;
      void invoke("neko_screen_catch", { on: o !== null, cat: o === "cat" }).catch(() => {});
    };
    // 커서가 있는 다른 모니터 쪽. 한가하면(잡혀 있지 않고 활동이 없으면) 그쪽 끝 너머로 걸어간다
    let away: Side | null = null;
    let outAt = 0;
    const followAway = () => {
      const now = performance.now();
      if (!away || held || ctrl.activity !== null || now - outAt < WALK_OUT_EVERY_MS) return;
      outAt = now;
      ctrl.walkOut(away);
    };
    // ponytail: 커서가 이 화면에 있는 동안은 늘 30Hz 로 hit 를 본다. 에너지가 문제면 고양이 둘레에 있을 때만
    // 잡힌 목덜미 자리를 Rust 에 알린다(바뀔 때만, 놓으면 null). 끌어 건너갈 때 창은 커서가 아니라 고양이가 다른 모니터에
    // 들어갈 때 옮긴다 — 빠르게 끌면 고양이가 커서보다 한참 뒤라, 커서 기준이면 고양이가 옛 화면에서 사라져 튀었다
    let heldSent: string | null = null;
    const reportHeld = () => {
      const h = ctrl.held, key = h ? `${Math.round(h[0])},${Math.round(h[1])}` : null;
      if (key === heldSent) return;
      heldSent = key;
      void invoke("neko_screen_held", { at: h }).catch(() => {});
    };
    // 캣타워(neko_perch.rs): 고양이 자리(크게 움직였을 때만)와 올라탄 창 번호를 Rust 에 — 근처면 창을 자주 읽고, 올라탄 창은 30Hz 로 따라 읽는다
    let catSent: [number, number] | null = null;
    let perchSent: number | null = null;
    const reportCat = () => {
      const r = ctrl.region, at: [number, number] = [r.x + r.w / 2, r.y + r.h * 0.7];
      const win = ctrl.perch ? Number(ctrl.perch.split(":")[0]) : null, perch = Number.isFinite(win) ? win : null;
      const moved = !catSent || Math.hypot(at[0] - catSent[0], at[1] - catSent[1]) > CAT_AT_STEP;
      if (!moved && perch === perchSent) return;
      if (moved) catSent = at;
      perchSent = perch;
      void invoke("neko_screen_cat", { at: moved ? at : null, perch }).catch(() => {});
    };
    // 창 탐험(tower)을 할 만한가를 메인 창(감독이 혼자 놀 거리를 고를 때)에 — 바뀔 때만
    let towerSent: boolean | null = null;
    const reportTower = () => {
      const ok = ctrl.towerOk;
      if (ok === towerSent) return;
      towerSent = ok;
      void emitTo("main", "neko-screen-tower", ok).catch(() => {});
    };
    const timer = setInterval(() => { reportHeld(); reportCat(); reportTower(); if (cursor) check(); else followAway(); }, CHECK_EVERY_MS);
    // 끝을 넘었다 — 커서가 아직 그쪽이면 Rust 가 창을 옮긴다(neko-screen-moved). 그새 돌아왔으면 걸어 들어온다
    const offMenu = ctrl.on("decorMenu", setMenu);
    // 고양이 우클릭: 엔진은 선물만 메뉴를 띄우고(기본 메뉴를 막음) 고양이엔 안 띄운다. 오른쪽 버튼 누름은 엔진에
    // 안 넘긴다 — 넘기면 쓰다듬기(탭)·선물 끌기로 샌다. ⌃클릭도 우클릭이다
    const isRight = (e: MouseEvent) => e.button === 2 || (e.button === 0 && e.ctrlKey);
    const onRightDown = (e: PointerEvent) => { if (isRight(e)) e.stopPropagation(); };
    const onContext = (e: MouseEvent) => {
      if (e.defaultPrevented || !ctrl.hit(e.clientX, e.clientY)) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY });
    };
    window.addEventListener("pointerdown", onRightDown, true);
    window.addEventListener("contextmenu", onContext);
    // 누른 채 움직이는 동안은 쓰다듬기가 아니다(선물을 끌어 고양이 위를 비빔). 고양이 잡기는 grab·drop 이 따로 막는다
    // 끌던 선물이 다른 모니터 위에 있나(Rust neko-screen-elsewhere). 놓을 때 엔진의 decorMove(이 화면 끝 자리) 대신
    // 그 모니터로 옮긴다. 새로 누를 때 지운다
    let elsewhere: { screen: string; x: number; y: number } | null = null;
    const onPress = () => { elsewhere = null; petRef.current.setPressed(true); };
    const onRelease = () => petRef.current.setPressed(false);
    window.addEventListener("pointerdown", onPress, true);
    window.addEventListener("pointerup", onRelease, true);
    window.addEventListener("pointercancel", onRelease, true);
    const offEdge = ctrl.on("edge", (side) => {
      void invoke<boolean>("neko_screen_cross", { side })
        .then((moved) => { if (!moved) { outAt = 0; ctrl.setEdges(CLOSED); } })
        .catch(() => ctrl.setEdges(CLOSED));
    });

    const offEngine = FORWARD.map((ev) =>
      ctrl.on(ev, (payload: unknown) => {
        // 잡고 흔드는 건 쓰다듬기가 아니다: 잡힌 동안과 떨어지는 동안(held)은 결을 세지 않는다
        if (ev === "grab") { held = true; petRef.current.setHeld(true); clearTimeout(fallTimer); fps(); }
        if (ev === "drop") fallTimer = setTimeout(() => { held = false; petRef.current.setHeld(false); fps(); }, FALL_MS);
        if (ev === "error") {
          // 엔진이 멈췄다: 클릭을 막은 채 굳지 않게 숨는다
          void invoke("neko_screen_catch", { on: false }).catch(() => {});
          void getCurrentWindow().hide().catch(() => {});
        }
        if (ev === "decorMove" && elsewhere) {
          void emitTo("main", "neko-screen-put-on", { id: (payload as { id: string }).id, ...elsewhere }).catch(() => {});
          elsewhere = null;
          return;
        }
        toMain({ ev, payload: ev === "error" ? String(payload) : payload });
      }),
    );

    // 이 창 앞으로 온 것만 듣는다. 그냥 listen 은 대상이 Any 라 다른 창(다른 모니터 선물 창) 앞 이벤트까지 받는다
    const me = getCurrentWindow();
    const offs = [
      me.listen<NekoCmd>("neko-cmd", ({ payload: { m, args } }) => {
        const fn = (ctrl as unknown as Record<string, unknown>)[m];
        if (LOCAL_ONLY.has(m) || typeof fn !== "function") return;
        (fn as (...a: unknown[]) => unknown).apply(ctrl, args);
        if (m === "setMood") { mood = args[0] as NekoMood; fps(); }
      }),
      me.listen<[number, number] | null>("neko-screen-cursor", ({ payload }) => {
        const prev = cursor;
        cursor = payload;
        check();
        // 고양이 몸 위일 때만(마당 선물 위는 아니다). 누른 채(선물 끌기)면 hook 이 거른다
        if (over === "cat" && prev && payload) petRef.current.onBodyMove(payload[0] - prev[0], payload[1] - prev[1]);
        else petRef.current.onBodyLeave();
      }),
      me.listen<boolean>("neko-screen-active", ({ payload }) => {
        active = payload;
        if (active) ctrl.resume();
        else { ctrl.pause(); cursor = null; check(); }
      }),
      me.listen<Layout>("neko-screen-layout", ({ payload }) => ctrl.setGround(payload.ground)),
      me.listen<Side | null>("neko-screen-away", ({ payload }) => {
        away = payload;
        if (!away && outAt) { outAt = 0; ctrl.setEdges(CLOSED); }
      }),
      // 창이 다른 모니터로 옮겨졌다(숨긴 채). 세계를 옮기면 엔진이 바로 한 번 그린다 — 다음 프레임에 보인다
      me.listen<Moved>("neko-screen-moved", ({ payload: { layout, shift } }) => {
        // 새 바닥은 shiftWorld 에 같이 — setGround 를 따로 부르면 dy 에 든 바닥 차이만큼 세계를 한 번 더 옮겨 움찔·튀었다
        ctrl.shiftWorld(shift[0], shift[1], layout.ground);
        ctrl.setEdges(CLOSED);
        away = null;
        outAt = 0;
        cursor = null;
        requestAnimationFrame(() => void invoke("neko_screen_reveal").catch(() => {}));
      }),
      // 캣타워 발판·벽(Rust, 바뀔 때만. partial 이면 그 창 것만)
      me.listen<Perches>("neko-screen-perches", ({ payload }) => {
        ctrl.setPerches(payload);
        if (import.meta.env.DEV) setDebug((d) => {
          const keep = <T extends { win: number }>(a: T[], b: T[]) => (payload.partial === undefined ? b : [...a.filter((o) => o.win !== payload.partial), ...b]);
          return { wins: d?.wins ?? [], p: { tops: keep(d?.p.tops ?? [], payload.tops), walls: keep(d?.p.walls ?? [], payload.walls) } };
        });
      }),
      ...(import.meta.env.DEV ? [me.listen<PerchDebug[]>("neko-screen-perch-debug", ({ payload }) => setDebug((d) => ({ wins: payload, p: d?.p ?? { tops: [], walls: [] } })))] : []),
      me.listen<number>("neko-screen-scale", ({ payload }) => ctrl.setScale(payload)),
      me.listen<number>("neko-screen-fps", ({ payload }) => { maxFps = payload; fps(); }),
      me.listen("neko-screen-ping", () => { towerSent = null; void emitTo("main", "neko-screen-ready").catch(() => {}); }),
      me.listen("neko-screen-press-out", () => setMenu(null)), // 다른 데를 눌렀다
      me.listen<{ screen: string; x: number; y: number } | null>("neko-screen-elsewhere", ({ payload }) => { elsewhere = payload; }),
    ];
    void invoke<Layout | null>("neko_screen_layout").then((l) => { if (l) ctrl.setGround(l.ground); }).catch(() => {});
    void invoke<Perches | null>("neko_screen_perches").then((p) => { if (p) ctrl.setPerches(p); }).catch(() => {});
    // 준비됐다 — 메인 창이 대리를 세우고 감독이 계획을 처음부터 보낸다
    void Promise.all(offs).then(() => emitTo("main", "neko-screen-ready")).catch(() => {});

    return () => {
      clearInterval(timer);
      clearTimeout(fallTimer);
      offEdge();
      offMenu();
      window.removeEventListener("pointerdown", onRightDown, true);
      window.removeEventListener("contextmenu", onContext);
      window.removeEventListener("pointerdown", onPress, true);
      window.removeEventListener("pointerup", onRelease, true);
      window.removeEventListener("pointercancel", onRelease, true);
      offEngine.forEach((off) => off());
      offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
      ctrl.destroy();
      ctrlRef.current = null;
    };
  }, []);

  return (
    <>
      {import.meta.env.DEV && debug && (
        <svg className="neko-screen__perch-debug" aria-hidden="true">
          {debug.wins.map((w) => (
            <g key={w.win}>
              <rect x={w.rect[0]} y={w.rect[1]} width={w.rect[2]} height={w.rect[3]} fill="none" stroke={w.why ? "#e5484d" : "#8b8d98"} strokeDasharray="6 4" />
              <text x={w.rect[0] + 4} y={w.rect[1] + 14} fill={w.why ? "#e5484d" : "#8b8d98"} fontSize="11">{`${w.owner} #${w.win} L${w.layer}${w.why ? ` — ${w.why}` : ""}`}</text>
            </g>
          ))}
          {debug.p.tops.map((t) => <line key={t.id} x1={t.x0} x2={t.x1} y1={t.y} y2={t.y} stroke="#30a46c" strokeWidth="3" />)}
          {debug.p.walls.map((w) => <line key={w.id} x1={w.x} x2={w.x} y1={w.y0} y2={w.y1} stroke="#0090ff" strokeWidth="3" />)}
        </svg>
      )}
      <canvas ref={canvasRef} className="neko-screen__canvas" tabIndex={-1} aria-hidden="true" />
      {menu && (
        <button
          ref={menuRef}
          type="button"
          className="neko-screen__tidy"
          style={{ left: menu.x + 2, top: Math.max(2, menu.y - 4) }}
          onClick={() => {
            if (menu.id) void emitTo("main", "neko-screen-put", menu.id).catch(() => {});
            else void invoke("neko_screen_hide").catch(() => {});
            setMenu(null);
          }}
        >
          {menu.id ? "정리" : "숨기기"}
        </button>
      )}
    </>
  );
}
