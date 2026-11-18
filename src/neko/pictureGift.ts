import { primeShapeImage, validateShape, IMG_MAX, type GiftShape } from "./engine/gift-shape";
import { useNekoGifts } from "./gifts";

/**
 * 채팅 낙서를 선물함에(채팅 그림 아래 '선물함에 넣기'). 코드 실행 + neko_draw 로 그린 PNG(data URL)를 작게 줄여(긴 변 256px,
 * 투명 배경 그대로) 나무 액자에 넣고 small 액자 선물로 넣는다. 걸기·놓기·버리기·올려다보기는 네코 그림 액자와 같다.
 *
 * 그림은 선물 모양의 img(gift-shape.js)라 선물함 칸·방·거실·마당·입에 물기 모두 같은 drawShape 로 그린다.
 * 선물 하나가 통째로 저장·동기화(neko-sync gift_add)되니 수십 KB 로 묶는다 — 넘치면 더 작게 줄인다.
 */

/** 긴 변(px)을 이 순서로 줄여 보며 BUDGET 안에 들면 쓴다 */
const SIDES = [256, 224, 192, 160, 128, 96] as const;
/** data URL 길이 상한(약 45KB). 선물 100개 중 그림이 몇 개 섞여도 저장 키가 수 MB 를 넘지 않게 */
export const PICTURE_BUDGET = Math.min(60_000, IMG_MAX);
/** 그림이 들어갈 안쪽의 긴 변(칸). 매트는 +4, 나무 액자는 +8 — neko-drawing 의 액자(26×22)와 같은 두께 */
const INNER = 18;
const MIN_SIDE = 8;

/** 낙서의 가로세로 비율에 맞춘 액자 + 매트 + 그림. 바닥 y = 0, 가운데 x = 0 */
export function pictureShape(src: string, w: number, h: number): GiftShape {
  const a = w > 0 && h > 0 ? w / h : 1;
  const iw = Math.max(MIN_SIDE, a >= 1 ? INNER : INNER * a), ih = Math.max(MIN_SIDE, a >= 1 ? INNER / a : INNER);
  const fw = iw + 8, fh = ih + 8, cy = -fh / 2;
  return validateShape({
    v: 1,
    parts: [
      { t: "rrect", x: 0, y: cy, w: fw, h: fh, rad: 1.2, rot: 0, c: "brown" },
      { t: "rrect", x: 0, y: cy, w: iw + 4, h: ih + 4, rad: 0.4, rot: 0, c: "white" },
    ],
    img: { x: 0, y: cy, w: iw, h: ih, src },
  });
}

/** 그려 달라던 말에서 짧은 제목: '~ 그려 줘' 같은 부탁 말을 떼고 20자 안으로 */
export function pictureTitle(request: string): string {
  const t = request
    .replace(/[`*_#>[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*(을|를)?\s*(좀\s*)?(그려|그리)\s*(줘|주세요|줄래|줄 수 있어|봐|봐줘|봐 줘|달라고|줘요)?\s*[.!?~ㅎㅋ]*$/u, "")
    .replace(/\s*(그림|낙서)\s*$/u, "")
    .trim();
  if (!t) return "낙서 그림";
  return t.length > 20 ? `${t.slice(0, 19)}…` : t;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const im = new Image();
    im.onload = () => ok(im);
    im.onerror = () => fail(new Error("그림을 못 읽었어"));
    im.src = src;
  });
}

/** 긴 변을 SIDES 순서로 줄여 PNG data URL 이 PICTURE_BUDGET 안에 들 때까지. 원래 더 작으면 키우지 않는다 */
export async function shrinkPicture(src: string): Promise<{ url: string; w: number; h: number; canvas: HTMLCanvasElement }> {
  const im = await loadImage(src);
  const W = im.naturalWidth, H = im.naturalHeight;
  if (!W || !H) throw new Error("빈 그림이야");
  let out: { url: string; w: number; h: number; canvas: HTMLCanvasElement } | null = null;
  for (const side of SIDES) {
    const k = Math.min(1, side / Math.max(W, H)), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
    if (out && w === out.w) continue; // 원래 작은 그림: 같은 크기면 다시 안 굽는다
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("캔버스를 못 만들었어");
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(im, 0, 0, w, h); // 투명한 곳은 투명 그대로(PNG)
    out = { url: canvas.toDataURL("image/png"), w, h, canvas };
    if (out.url.length <= PICTURE_BUDGET) return out;
  }
  if (!out || out.url.length > IMG_MAX) throw new Error("그림이 너무 커서 못 넣었어");
  return out;
}

/** 같은 그림을 두 번 눌러도 하나만(원본 data URL 해시로 id) */
function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 7) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); // 7자마다: 큰 그림도 빠르게
  return `pic-${(h >>> 0).toString(36)}-${s.length.toString(36)}`;
}

/**
 * 채팅 낙서(src = data URL)를 액자에 넣어 선물함에. request = 그려 달라던 사용자 말(제목이 된다).
 * 이미 넣은 그림이면 다시 넣지 않고 { added: false } 를 돌려준다
 */
export async function addPictureGift(src: string, request = ""): Promise<{ id: string; added: boolean }> {
  const id = hashId(src);
  if (useNekoGifts.getState().gifts.some((g) => g.id === id)) return { id, added: false };
  const pic = await shrinkPicture(src);
  primeShapeImage(pic.url, pic.canvas); // 방금 만든 그림: 선물함·무대가 읽기를 안 기다리고 바로 그린다
  useNekoGifts.getState().add({
    id, title: pictureTitle(request), body: "채팅에서 같이 그린 낙서", shape: pictureShape(pic.url, pic.w, pic.h), size: "small", frame: true,
  });
  return { id, added: true };
}
