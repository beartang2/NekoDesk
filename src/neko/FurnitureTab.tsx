import { useEffect, useRef } from "react";
import { emit } from "@tauri-apps/api/event";
import { Trash2 } from "lucide-react";
import { drawFurniture, furnitureBox } from "./engine/furniture-art";
import { FURNITURE_SLOTS } from "./engine/decor-draw";
import { FURNITURE_NAME, freeSlot, useNekoFurniture, type FurnitureItem } from "./furniture";
import { PLACE_NAME } from "./gifts";
import { IS_PHONE } from "../lib/platform";
import type { PlaceAsk } from "./PlacePicker";
import { GiftThumb } from "./NekoGiftBox";
import { useAccent } from "./furnitureHost";

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

/** 놓기·옮기기 → '어디에 놓을까요?'. 지금 놓인 자리와 꽉 찬 자리(방 2개·거실 4개)는 흐리게 못 고른다 */
export function askFurniturePlace(f: FurnitureItem, items: FurnitureItem[]): PlaceAsk {
  return {
    title: nameOf(f),
    question: f.place ? "어디로 옮길까요?" : "어디에 놓을까요?",
    choices: ROOMS.map((at) => {
      if (f.place?.at === at) return { at, note: "놓여 있음", off: true };
      const used = items.filter((x) => x.place?.at === at).length, max = FURNITURE_SLOTS[at];
      return freeSlot(items, at, f.id) === null ? { at, note: `${used}/${max} 꽉 참`, off: true } : { at, note: `${used}/${max}` };
    }),
    pick: (at) => void useNekoFurniture.getState().place(f.id, at).then(changed),
  };
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
        놓기를 누르면 놓을 자리를 고릅니다. 방은 {FURNITURE_SLOTS.sidebar}개, 거실은 {FURNITURE_SLOTS.dock}개까지 놓을 수 있습니다.
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
