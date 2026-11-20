import { useEffect, useRef } from "react";
import { emit } from "@tauri-apps/api/event";
import { Trash2 } from "lucide-react";
import { drawFurniture, furnitureBox } from "./engine/furniture-art";
import { FURNITURE_SLOTS } from "./engine/decor-draw";
import { FURNITURE_NAME, freeSlot, useNekoFurniture, type FurnitureItem } from "./furniture";
import { PLACE_NAME } from "./gifts";
import { useNekoStore } from "./nekoStore";
import { GiftThumb } from "./NekoGiftBox";
import { accentHex } from "./furnitureHost";

/** 가구 그림(칸 크기에 맞춰). 기본 가구는 furniture-art, 물어온 가구는 모델이 그린 모양 */
export function FurnitureThumb({ item, size = 64 }: { item: FurnitureItem; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  useEffect(() => {
    const g = ref.current?.getContext("2d");
    if (!g || item.shape) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const b = furnitureBox(item.kind, 1), S = (size * 0.82) / Math.max(b.w, b.h);
    drawFurniture(g, item.kind, size / 2, size / 2 + (b.h * S) / 2, S, { accent: accentHex(), edge: 3 * dpr, shadow: null });
  }, [item.kind, item.shape, size, dpr]);
  if (item.shape) return <GiftThumb shape={item.shape} size={size} />;
  return <canvas ref={ref} width={size * dpr} height={size * dpr} style={{ width: size, height: size }} aria-hidden />;
}

/** 다른 창(메인)의 가구 스토어에 알린다 — 맥 선물함은 따로 뜬 창이다. 폰은 같은 창이라 그냥 지나간다 */
const changed = () => { void emit("neko-furniture-changed").catch(() => {}); };

const nameOf = (f: FurnitureItem) => f.title || FURNITURE_NAME[f.kind];

/**
 * 선물함의 가구 탭(docs/neko-furniture.md §10): 기본 다섯 + 산책에서 물어온 가구(최근 것 위). 지금 네코가 있는 장소를 기준으로
 * 놓기·여기로·치우기. 칸이 차면 흐리게 막고 위에 안내, 마당이면 버튼 없이 안내. 기본 가구는 못 버린다
 */
export function FurnitureTab({ onDrop }: { onDrop: (f: FurnitureItem) => void }) {
  const items = useNekoFurniture((s) => s.items);
  const here = useNekoStore((s) => s.stage.placement);
  useEffect(() => { void useNekoFurniture.getState().load(); }, []);
  const room = here === "sidebar" || here === "dock" ? here : null;
  const full = room !== null && freeSlot(items, room) === null;
  const base = items.filter((f) => f.id.startsWith("base:")), found = items.filter((f) => !f.id.startsWith("base:")).reverse();

  async function act(f: FurnitureItem) {
    if (!room) return;
    const st = useNekoFurniture.getState();
    if (f.place?.at === room) await st.unplace(f.id);
    else await st.place(f.id, room);
    changed();
  }

  return (
    <>
      <p className="settings-section__desc">
        {room
          ? full
            ? `${PLACE_NAME[room]}에는 가구를 ${FURNITURE_SLOTS[room]}개까지 놓을 수 있습니다. 다른 가구를 먼저 치우십시오.`
            : `지금 네코는 ${PLACE_NAME[room]}에 있습니다. 놓은 가구는 옮길 수 없고, ${PLACE_NAME[room]}에서 꾹 누르면(맥은 우클릭도) 치울 수 있습니다. 방은 2개, 거실은 4개까지 놓을 수 있습니다.`
          : "마당에는 가구를 놓을 수 없습니다."}
      </p>
      <ul className="neko-gifts__grid">
        {[...base, ...found].map((f) => {
          const placedHere = !!room && f.place?.at === room;
          const label = placedHere ? "치우기" : f.place ? "여기로" : "놓기";
          return (
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
              {room && (
                <button type="button" className="settings-btn neko-gifts__btn" disabled={!placedHere && full} onClick={() => void act(f)}>
                  {label}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** 물어온 가구 버리기(확인 창에서 고른 뒤). 놓여 있었으면 칸도 빈다 */
export async function dropFurniture(f: FurnitureItem) {
  await useNekoFurniture.getState().remove(f.id);
  changed();
}
