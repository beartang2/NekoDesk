/**
 * 말랑 네코 엔진 타입. 구현은 neko-engine.js (v26 시안을 감싼 것, 설계: docs/neko-v26-integration.md).
 */

/** "custom" 이면 color(RGB)로 털 색 묶음을 만든다 */
import type { GiftShape } from "./gift-shape";

/** 입에 무는 물건(docs/neko-gifts.md §6). 이미지는 호스트가 다 불러온 것을 넘긴다 */
export type NekoCarryItem =
  | { id: string; kind: "shape"; shape: unknown }
  | { id: string; kind: "image"; image: ImageBitmap | HTMLImageElement };
/** 엔진이 들고 있는 꼴(모양은 검사를 거친 것) */
export type NekoCarried =
  | { id: string; kind: "shape"; shape: GiftShape }
  | { id: string; kind: "image"; image: ImageBitmap | HTMLImageElement };

/** 무대에 놓은 자리(무대 크기와 무관한 비율) */
export type NekoDecorSpot = { surface: "floor"; u: number } | { surface: "wall"; u: number; v: number };

export type NekoCoat = "black" | "cheese" | "gray" | "cream" | "white" | "custom";
export type NekoPattern = "white" | "calico" | "tabby" | "point";
export type NekoEye = "yellow" | "white" | "green" | "blue";
export type NekoFur = "short" | "medium" | "long";
export type NekoEar = "pointy" | "round" | "fold";
export type NekoTail = "long" | "fluffy" | "bob";
export type NekoBuild = "slim" | "normal" | "chubby";
export type NekoLegs = "short" | "normal" | "long";

export interface NekoAppearance {
  coat: NekoCoat;
  /** coat 가 "custom" 일 때 쓰는 털 색(#rrggbb) */
  color: string;
  patterns: NekoPattern[];
  /** 무늬 씨앗(같은 씨앗이면 같은 무늬) */
  seed: number;
  eye: NekoEye;
  fur: NekoFur;
  ear: NekoEar;
  tail: NekoTail;
  build: NekoBuild;
  legs: NekoLegs;
  /** 말랑함 0..1 */
  soft: number;
}

export type NekoMood = "idle" | "happy" | "sleepy" | "curious";
export type NekoPose = "stand" | "sit" | "loaf" | "lie";
export type NekoActivity =
  | "draw" | "music" | "butterfly" | "snack" | "stretch" | "typing" | "reading"
  | "stamp" | "groom" | "knead" | "yarn" | "box" | "window" | "climb"
  // P3: 감독이 에이전트 단계·앱 상황에 맞춰 고른다
  | "think" | "wait" | "meal" | "hungry" | "dig" | "calendar" | "erase"
  // 놓아 둔 선물 갖고 놀기(docs/neko-gifts.md §5)
  | "giftplay";

/** 선물 노는 방식. 없으면 엔진이 모양으로 짐작한다 */
export type NekoGiftPlay = "roll" | "bat" | "sniff" | "sit_on" | "carry";
export type NekoTailSign =
  | "level" | "up" | "question" | "quiver" | "sway" | "down" | "puff" | "angry" | "thump";
export type NekoReaction = "pet" | "nyang" | "startle" | "greet" | "cheer" | "proud" | "sulk" | "down";

export interface NekoEvents {
  /** 탭으로 쓰다듬었고 고양이가 좋아함 */
  pet: void;
  /** 탭으로 쓰다듬었지만 너무 만져 짜증 남(놀이 게이지를 올리지 않는다) */
  annoyed: void;
  nyang: void;
  grab: void;
  drop: void;
  /** 활동이 바뀌었을 때(끝나면 null) */
  activity: NekoActivity | null;
  /** 상태 이름(접근성 라벨 등) */
  label: string;
  error: unknown;
  /** 입에 문 목록이 바뀜 */
  carry: NekoCarried[];
  /** 문 물건 위에서 누름(무대 px). 끌어내기는 호스트가 시작한다 */
  carryPress: { x: number; y: number; pointerId: number };
  /** 놓아 둔 물건을 끌어 옮김 */
  decorMove: { id: string } & NekoDecorSpot;
  /** 놓아 둔 물건을 우클릭함: (x, y) = 그 물건 오른쪽 위(무대 px). 호스트가 거기에 '정리' 버튼을 띄운다 */
  decorMenu: { id: string; x: number; y: number };
}

export interface NekoOptions {
  /** 기본 true: 배경 없이 바닥선·그림자만 */
  transparent?: boolean;
  /**
   * 화면 모드(docs/neko-screen-mode.md §2): 세계 = 창 전체(innerWidth·innerHeight), 캔버스는 고양이 둘레
   * 600×440 단위만 덮고 엔진이 매 프레임 style.transform 으로 옮긴다. 포인터·hit 는 세계 좌표(clientX·clientY).
   * 호스트는 캔버스를 position: fixed/absolute; left: 0; top: 0 으로 둔다. 배경은 늘 투명
   */
  world?: boolean;
  /** 크기 고정(0.35~1.4). 없으면 무대 크기로 정한다 */
  scale?: number;
  /** 기본 "height": 무대 높이로 크기를 정한다 */
  scaleMode?: "height" | "stage";
  maxDpr?: number;
  dark?: boolean;
  /** 산책(무작위로 걷기·점프). 기본 true */
  wander?: boolean;
  appearance?: Partial<NekoAppearance>;
}

export interface NekoController {
  setAppearance(a: Partial<NekoAppearance>): void;
  getAppearance(): NekoAppearance;
  /** 무늬를 다시 뽑고 새 씨앗을 돌려준다 */
  reroll(): number;

  setMood(m: NekoMood): void;
  setPose(p: NekoPose): void;
  /** 활동 시작(같은 활동이면 이어 감). null 이면 끝냄 */
  act(key: NekoActivity | null): void;
  readonly activity: NekoActivity | null;
  /** 꼬리 언어를 잠깐(초) */
  tail(sign: NekoTailSign, sec?: number): void;
  /** "pet" 은 기분 좋게 받으면 true, 너무 만져 짜증 났으면 false(웃지 않고 피함). 나머지는 true */
  react(kind: NekoReaction): boolean;
  setNeeds(n: { hunger?: number; play?: number }): void;
  setWander(on: boolean): void;
  setRig(on: boolean): void;

  setTheme(t: { dark: boolean }): void;
  /** 0 이면 제한 없음 */
  setMaxFps(fps: number): void;
  resize(): void;
  pause(): void;
  resume(): void;
  destroy(): void;
  hit(x: number, y: number): boolean;
  /** 크기 고정(0.35~1.4). null 이면 무대 크기로 */
  setScale(s: number | null): void;
  /** 바닥(세계 y). 화면 모드에선 visibleFrame 바닥. null 이면 무대 아래쪽 */
  setGround(y: number | null): void;
  /** 지금 그리는 영역(세계 좌표). 화면 모드에선 고양이 둘레, 아니면 무대 전체 */
  readonly region: { x: number; y: number; w: number; h: number };
  /** 입에 문다. 같은 id 면 바꾼다. 여럿이면 최대 3장이 겹쳐 보인다 */
  carry(items: NekoCarryItem | NekoCarryItem[]): void;
  /** 입에서 뺀다(id 없으면 전부). 뺀 것을 돌려준다 */
  drop(id?: string): NekoCarried[];
  carried(): NekoCarried[];
  /**
   * 무대에 놓아 둔 물건(선물). 바닥: u = 양끝 여백을 뺀 무대 폭 비율 0~1. 벽: u 와 v = 바닥 위 쓸 수 있는 높이 비율 0~1.
   * 새로 놓인 것만 '뿅' 하고 나온다. 잡고 끌면 decorMove, 우클릭하면 decorMenu(저장·버튼은 호스트)
   */
  setDecor(items: ({ id: string; shape: unknown; play?: NekoGiftPlay } & NekoDecorSpot)[]): void;
  /** 놓아 둔 물건 수(감독이 '선물 갖고 놀기'를 고를지 볼 때) */
  readonly decorCount: number;
  /** 이 점(무대 px)이 놓아 둔 물건 위면 그 id */
  hitDecor(x: number, y: number): string | null;
  /** 무대 px 의 한 점(물건 가운데)을 자리로. 선물함에서 끌어 놓을 때 */
  decorSpotAt(x: number, y: number, shape: unknown): NekoDecorSpot;
  readonly carrying: boolean;
  /** 이 점(무대 px, hit 와 같은 좌표)이 문 물건 위면 "bundle" */
  hitCarry(x: number, y: number): "bundle" | null;
  /** 문 물건이 그려진 사각형(무대 px). 안 물었으면 null */
  carryRect(): { x: number; y: number; w: number; h: number } | null;
  on<K extends keyof NekoEvents>(ev: K, fn: (payload: NekoEvents[K]) => void): () => void;
  jump(): void;
  /** 몸을 콕 누른다: 눌렸다가 말랑함(soft)만큼 출렁이며 돌아온다. str 0~1.5 (기본 1) */
  boing(str?: number): void;
  walkTo(x: number): void;
}

export function createNeko(canvas: HTMLCanvasElement, options?: NekoOptions): NekoController;
