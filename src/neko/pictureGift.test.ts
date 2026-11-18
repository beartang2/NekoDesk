// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("../api/tauri", () => ({
  settingsApi: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  },
}));

import { IMG_MAX, shapeBounds, validateShape } from "./engine/gift-shape";
import { useNekoGifts } from "./gifts";
import { pictureShape, pictureTitle } from "./pictureGift";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeEach(() => {
  store.clear();
  useNekoGifts.setState({ gifts: [], loaded: false });
});

describe("채팅 낙서 선물", () => {
  it("제목: 부탁 말을 떼고 짧게", () => {
    expect(pictureTitle("고양이 우주비행사 그려줘")).toBe("고양이 우주비행사");
    expect(pictureTitle("귀여운 강아지 그림 그려 줘!")).toBe("귀여운 강아지");
    expect(pictureTitle("사과를 좀 그려주세요~")).toBe("사과");
    expect(pictureTitle("네코 그려줄 수 있어?")).toBe("네코");
    expect(pictureTitle("   ")).toBe("낙서 그림");
    expect(pictureTitle("아주아주 긴 이름의 무언가를 열심히 그리는 고양이와 친구들 그려줘").length).toBeLessThanOrEqual(20);
  });

  it("액자 모양: 비율에 맞춘 액자·매트 + 그림 칸, 세로 그림은 세로 액자", () => {
    const wide = pictureShape(PNG, 256, 128), tall = pictureShape(PNG, 128, 256);
    expect(wide.img).toMatchObject({ w: 18, h: 9, src: PNG });
    expect(tall.img).toMatchObject({ w: 9, h: 18 });
    const frame = tall.parts[0] as { w: number; h: number };
    expect(frame.h).toBeGreaterThan(frame.w);
    expect(shapeBounds(wide).top).toBeLessThan(0);
    expect(wide.parts).toHaveLength(2);
  });

  it("그림 칸은 검사를 통과한 data URL 만(다른 주소·너무 긴 것·스크립트는 버린다)", () => {
    const base = { parts: [{ t: "rrect", x: 0, y: -10, w: 20, h: 20, rad: 1, rot: 0, c: "brown" }] };
    expect(validateShape({ ...base, img: { x: 0, y: -10, w: 10, h: 10, src: PNG } }).img?.src).toBe(PNG);
    for (const src of ["https://example.com/a.png", "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", `data:image/png;base64,${"A".repeat(IMG_MAX)}`, 3]) {
      expect(validateShape({ ...base, img: { x: 0, y: -10, w: 10, h: 10, src } }).img).toBeUndefined();
    }
  });

  it("선물함에 넣고 저장·다시 불러와도 그림이 남는다(작은 액자)", async () => {
    useNekoGifts.getState().add({ id: "pic-1", title: "사과", body: "", shape: pictureShape(PNG, 1, 1), size: "small", frame: true });
    await new Promise((r) => setTimeout(r, 0));
    const saved = JSON.parse(store.get("neko_gifts") ?? "[]");
    expect(saved[0].shape.img.src).toBe(PNG);
    useNekoGifts.setState({ gifts: [], loaded: false });
    await useNekoGifts.getState().load();
    const g = useNekoGifts.getState().gifts[0];
    expect(g).toMatchObject({ id: "pic-1", size: "small", frame: true });
    expect(g.shape.img?.src).toBe(PNG);
    useNekoGifts.getState().place("pic-1", "auto", "sidebar"); // 걸기: 다른 액자와 같게 벽에
    expect(useNekoGifts.getState().gifts[0].placed).toMatchObject({ surface: "wall", at: "sidebar" });
  });
});
