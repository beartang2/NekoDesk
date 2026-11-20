import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { Plus, Trash2 } from "lucide-react";
import { drawFurniture, furnitureBox } from "./engine/furniture-art";
import { FURNITURE_SLOTS, furnitureSlots } from "./engine/decor-draw";
import { stageS } from "./engine/stage-scale";
import { roomWindows } from "./engine/room-window";
import { FURNITURE_NAME, useNekoFurniture, type FurnitureItem } from "./furniture";
import { useNekoStore } from "./nekoStore";
import { FloorBand, WallPattern } from "./Wallpaper";
import "./NekoRoom.css"; // 벽·바닥 색(방과 같다)
import { PLACE_NAME } from "./gifts";
import { IS_PHONE } from "../lib/platform";
import type { PlaceAsk } from "./PlacePicker";
import { GiftThumb } from "./NekoGiftBox";
import { useAccent, useLamps } from "./furnitureHost";

/** 가구 그림(칸 크기에 맞춰). 기본 가구는 furniture-art, 물어온 가구는 모델이 그린 모양 */
export function FurnitureThumb({ item, size = 64 }: { item: FurnitureItem; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(window.devicePixelRatio || 1, 2), accent = useAccent();
  useEffect(() => {
    const g = ref.current?.getContext("2d");
    if (!g || item.shape) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const b = furnitureBox(item.kind, 1), S = (size * 0.82) / Math.max(b.w, b.h);
    drawFurniture(g, item.kind, size / 2, size / 2 + (b.h * S) / 2, S, { accent, edge: 3 * dpr, shadow: null });
  }, [item.kind, item.shape, size, dpr, accent]);
  if (item.shape) return <GiftThumb shape={item.shape} size={size} />;
  return <canvas ref={ref} width={size * dpr} height={size * dpr} style={{ width: size, height: size }} aria-hidden />;
}

/** 다른 창(메인)의 가구 스토어에 알린다 — 맥 선물함은 따로 뜬 창이다. 폰은 같은 창이라 그냥 지나간다 */
const changed = () => { void emit("neko-furniture-changed").catch(() => {}); };

const nameOf = (f: FurnitureItem) => f.title || FURNITURE_NAME[f.kind];

/** 가구를 놓을 수 있는 자리(맥·폰 같다). 마당에는 놓지 않는다 */
const ROOMS = ["sidebar", "dock"] as const;
type Room = (typeof ROOMS)[number];

/**
 * 놓기·옮기기 → '어디에 놓을까요?'(자리) → '어느 칸에 놓을까요?'(칸, 사용자). 자리마다 놓인 수(1/2)를 보이고, 빈 칸이 없으면 흐리게
 * 못 고른다. 놓인 자리도 다른 칸이 비어 있으면 고를 수 있다(같은 자리 안에서 칸 옮기기)
 */
export function askFurniturePlace(f: FurnitureItem, items: FurnitureItem[]): PlaceAsk {
  return {
    title: nameOf(f),
    question: f.place ? "어디로 옮길까요?" : "어디에 놓을까요?",
    choices: ROOMS.map((at) => {
      const here = f.place?.at === at, max = FURNITURE_SLOTS[at];
      const others = items.filter((x) => x.id !== f.id && x.place?.at === at).length, used = others + (here ? 1 : 0);
      const full = others >= max - (here ? 1 : 0);
      return { at, off: full, note: here ? `놓여 있음 · ${used}/${max}` : full ? `${used}/${max} 꽉 참` : `${used}/${max}` };
    }),
    then: {
      question: f.place ? "어느 칸으로 옮길까요?" : "어느 칸에 놓을까요?",
      body: (at, done) => <FurnitureSlots f={f} at={at as Room} done={done} />,
    },
  };
}

/**
 * 칸 고르기 그림의 무대 크기: 높이는 설정 값, 폭은 폰이면 이 화면. 맥 거실은 창 폭을 몰라(선물함은 따로 뜬 창) 760 으로 어림한다 —
 * 칸은 폭을 똑같이 나눈 자리라 순서·모양은 같고, 실제 창 폭(1000 남짓)으로 그리면 그림이 너무 납작해 칸을 누르기 어렵다
 */
function previewStage(at: Room) {
  const st = useNekoStore.getState().stage, vw = window.innerWidth, vh = window.innerHeight;
  if (at === "sidebar") return { W: IS_PHONE ? Math.round(vw * 0.86) : 280, H: st.sidebarH };
  if (IS_PHONE && vw > vh) return { W: vw, H: vh }; // 가로 화면: 거실이 화면을 채운다
  return { W: IS_PHONE ? vw : 760, H: st.dockH };
}

/**
 * 칸 고르기(사용자 선택 A): 그 자리(방·거실)를 작게 그리고 칸마다 누를 상자를 얹는다. 빈 칸은 점선 테두리, 가구가 있는 칸은
 * 그 가구가 보이고 흐리게 못 고른다(지금 이 가구가 있는 칸은 '지금 자리'). 자유 위치는 없다 — 칸 구조는 docs/neko-furniture.md 그대로
 */
function FurnitureSlots({ f, at, done }: { f: FurnitureItem; at: Room; done: () => void }) {
  const items = useNekoFurniture((s) => s.items);
  const accent = useAccent(), lamps = useLamps();
  const boxRef = useRef<HTMLDivElement>(null), cvRef = useRef<HTMLCanvasElement>(null);
  const [bw, setBw] = useState(0);
  useLayoutEffect(() => {
    const fit = () => setBw(boxRef.current?.clientWidth ?? 0);
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const { W, H } = previewStage(at), floorY = H - 6, S = stageS(W, floorY, at), seam = floorY - 18 * S;
  const k = bw ? Math.min(bw / W, (window.innerHeight < 500 ? 120 : 170) / H) : 0, pw = W * k, ph = H * k;
  const slots = furnitureSlots(at, W);
  const owner = (i: number) => items.find((x) => x.place?.at === at && x.place.slot === i) ?? null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  useEffect(() => {
    const cv = cvRef.current, g = cv?.getContext("2d");
    if (!cv || !g || !k) return;
    cv.width = Math.round(pw * dpr); cv.height = Math.round(ph * dpr);
    g.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    slots.forEach((s, i) => {
      const o = owner(i);
      if (o) drawFurniture(g, o.kind, s.x, floorY, S, { slotW: s.w, accent, on: !!lamps[o.id], edge: 3 * dpr, layer: "all" });
    });
  });
  const pick = (i: number) => { void useNekoFurniture.getState().place(f.id, at, i).then(changed); done(); };
  const top = Math.max(4 * S, floorY - 2.1 * 100 * S); // 가장 큰 가구(캣휠 2.0)가 들어가는 높이
  return (
    <div ref={boxRef} className="slot-pick">
      <div className="slot-pick__stage" style={{ width: pw, height: ph }}>
        {k > 0 && (
          <svg width={pw} height={ph} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            <rect className="neko-room__wall" x={0} y={0} width={W} height={seam} />
            <WallPattern place={at} w={W} wallH={seam} />
            <FloorBand w={W} h={H} seam={seam} S={S} />
            {roomWindows(at, W, H).map((r, i) => <rect key={i} className="slot-pick__window" x={r.x} y={r.y} width={r.w} height={r.h} rx={2 * S} />)}
          </svg>
        )}
        <canvas ref={cvRef} className="slot-pick__cv" style={{ width: pw, height: ph }} aria-hidden="true" />
        {slots.map((s, i) => {
          const o = owner(i), mine = o?.id === f.id;
          return (
            <button
              key={i}
              type="button"
              className={`slot-pick__slot${o ? " slot-pick__slot--taken" : ""}${mine ? " slot-pick__slot--mine" : ""}`}
              style={{ left: (s.x - s.w / 2) * k + 3, width: Math.max(0, s.w * k - 6), top: top * k, height: (floorY - top) * k + 3 }}
              disabled={!!o}
              aria-label={`왼쪽에서 ${i + 1}번째 칸${o ? (mine ? " · 지금 자리" : ` · ${nameOf(o)} 있음`) : ""}`}
              onClick={() => pick(i)}
            >
              {mine ? <span className="slot-pick__tag">지금 자리</span> : !o && <Plus size={16} strokeWidth={2.2} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 선물함의 가구 탭(docs/neko-furniture.md §10): 기본 다섯 + 산책에서 물어온 가구(최근 것 위). 놓기·옮기기는 자리를 고르고
 * (onAsk → PlacePicker, 네코가 어디 있든), 치우기는 바로. 기본 가구는 못 버린다
 */
export function FurnitureTab({ onDrop, onAsk }: { onDrop: (f: FurnitureItem) => void; onAsk: (ask: PlaceAsk) => void }) {
  const items = useNekoFurniture((s) => s.items);
  useEffect(() => { void useNekoFurniture.getState().load(); }, []);
  const base = items.filter((f) => f.id.startsWith("base:")), found = items.filter((f) => !f.id.startsWith("base:")).reverse();
  const unplace = (f: FurnitureItem) => void useNekoFurniture.getState().unplace(f.id).then(changed);

  return (
    <>
      <p className="settings-section__desc">
        놓기를 누르면 놓을 자리와 칸을 고릅니다. 방은 {FURNITURE_SLOTS.sidebar}개, 거실은 {FURNITURE_SLOTS.dock}개까지 놓을 수 있습니다.
        {IS_PHONE ? " 놓인 가구는 그 자리에서 꾹 누르면 치울 수 있습니다." : " 마당에는 놓을 수 없습니다. 놓인 가구는 그 자리에서 우클릭하면 치울 수 있습니다."}
      </p>
      <ul className="neko-gifts__grid">
        {[...base, ...found].map((f) => (
          <li
            key={f.id}
            className={`neko-gifts__item${f.place ? " neko-gifts__item--placed" : ""}`}
            title={`${f.body ? `${f.body}\n` : ""}${f.found ? `${f.found}에 물어 옴` : "기본 가구"}${f.place ? ` · ${PLACE_NAME[f.place.at]}에 놓여 있음` : ""}`}
          >
            {!f.id.startsWith("base:") && (
              <button type="button" className="neko-gifts__drop" aria-label={`${nameOf(f)} 버리기`} title="버리기" onClick={() => onDrop(f)}>
                <Trash2 size={12} />
              </button>
            )}
            <FurnitureThumb item={f} size={64} />
            <span className="neko-gifts__title">{nameOf(f)}</span>
            {f.body && <span className="neko-gifts__body">{f.body}</span>}
            <div className="neko-gifts__btns">
              <button type="button" className="settings-btn neko-gifts__btn" onClick={() => onAsk(askFurniturePlace(f, items))}>
                {f.place ? "옮기기" : "놓기"}
              </button>
              {f.place && <button type="button" className="settings-btn neko-gifts__btn" onClick={() => unplace(f)}>치우기</button>}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** 물어온 가구 버리기(확인 창에서 고른 뒤). 놓여 있었으면 칸도 빈다 */
export async function dropFurniture(f: FurnitureItem) {
  await useNekoFurniture.getState().remove(f.id);
  changed();
}
