/**
 * 말랑 네코 엔진 타입. 구현은 neko-engine.js (v26 시안을 감싼 것, 설계: docs/neko-v26-integration.md).
 */

/** "custom" 이면 color(RGB)로 털 색 묶음을 만든다 */
import type { GiftShape } from "./gift-shape";

/** 입에 무는 물건(docs/neko-gifts.md §6). 이미지는 호스트가 다 불러온 것을 넘긴다 */
/** 물건의 실제 크기(그리는 크기 배율). 없으면 medium */
export type NekoGiftSize = "small" | "medium" | "large";

export type NekoCarryItem =
  | { id: string; kind: "shape"; shape: unknown; size?: NekoGiftSize }
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
  | "giftplay"
  // 창 탐험(캣타워, 화면 모드)
  | "tower"
  // 쳐다보기: 애정이 낮을 때(docs/neko-activity-mix.md §2.3)
  | "gaze";

/** 선물 노는 방식. 없으면 엔진이 모양으로 짐작한다 */
export type NekoGiftPlay = "roll" | "bat" | "sniff" | "sit_on" | "carry"
  // 큰 물건 전용(작거나 중간 크기면 냄새 맡기로): 발톱 긁기 · 기대어 자기 · 뒤에 숨기. 큰 걸 물고 옮기기·굴리기는 이 중 하나로
  | "scratch" | "lean" | "hide";
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
  /** 곁들임이 바뀌었을 때(끝나거나 거절되면 null). 주 활동·기본 상태와 안 맞게 되면 엔진이 스스로 끝낸다 */
  side: NekoActivity | null;
  /** 상태 이름(접근성 라벨 등) */
  label: string;
  error: unknown;
  /** 입에 문 목록이 바뀜 */
  carry: NekoCarried[];
  /** 문 물건 위에서 누름(무대 px). 끌어내기는 호스트가 시작한다 */
  carryPress: { x: number; y: number; pointerId: number };
  /** 화면 모드: 열린 가장자리(setEdges·walkOut)에서 고양이 가운데가 세계 밖으로 나간 순간 한 번 */
  edge: "left" | "right";
  /** 놓아 둔 물건 하나와 한 판 놀았음(at = Date.now()). 호스트가 저장해 setDecor 의 lastPlayed 로 돌려주면 껐다 켜도 오래 안 논 것부터 */
  decorPlayed: { id: string; at: number };
  /** 놓아 둔 물건을 끌어 옮김 */
  decorMove: { id: string } & NekoDecorSpot;
  /** 놓아 둔 물건을 우클릭하거나 터치로 꾹 누름: (x, y) = 그 물건 오른쪽 위(무대 px). 호스트가 거기에 '정리' 버튼을 띄운다 */
  decorMenu: { id: string; x: number; y: number };
  /**
   * 화면 모드(world)만: 엔진이 지금 그리는 선물 id 전부(입에 묾·뒤에 숨기·굴림·옮김·흔들림·끌기). 바뀔 때만, 처음엔 없음.
   * 나머지는 선물 창이 그린다 — 선물 창은 이 id 를 빼고 그린다. 빠진 id 는 엔진이 0.3초 더 그려 바꿔 그리는 틈을 메운다
   */
  decorHeld: string[];
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
  /** 프레임 상한(기본 30, 0 이면 화면 주사율). 졸거나 누워 있을 땐 15, 잡고 끄는 동안 60 은 엔진이 알아서 */
  maxFps?: number;
  dark?: boolean;
  /** 산책(무작위로 걷기·점프). 기본 true */
  wander?: boolean;
  /** 정지 그림을 찍는 엔진(지도 위 네코·초상): 떠다니는 음표를 안 띄운다 */
  still?: boolean;
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
  /**
   * 곁들임(docs/neko-activity-mix.md): 주 활동 위에, 주 활동이 없으면 기본 상태(서기·걷기·앉기·식빵) 위에 얹는다.
   * 지금 도는 것과 안 맞으면(activity-mix.js 의 mixable) 거절하고 false. null 이면 끝냄.
   * 주 활동이 끝나도 곁들임은 남는다. act(지금 곁들임) 이면 곁들임이 주 활동으로 옮겨 탄다(소품이 다시 안 뜬다)
   */
  mix(key: NekoActivity | null): boolean;
  /** 쉬는 동안 커서 따라오기(기본 켬). 2단계 감독은 애정이 낮을 때만 켠다 */
  setChase(on: boolean): void;
  readonly side: NekoActivity | null;
  /** 꼬리 언어를 잠깐(초) */
  tail(sign: NekoTailSign, sec?: number): void;
  /** "pet" 은 기분 좋게 받으면 true, 너무 만져 짜증 났으면 false(웃지 않고 피함). 나머지는 true */
  react(kind: NekoReaction): boolean;
  setNeeds(n: { hunger?: number; play?: number }): void;
  setWander(on: boolean): void;
  setRig(on: boolean): void;

  setTheme(t: { dark: boolean }): void;
  /** 0 이면 제한 없음 */
  /** 프레임 상한(0 이면 화면 주사율). 졸 때 15·잡힐 때 60 은 엔진이 알아서 바꾼다 — 호스트는 사용자 설정값만 넘긴다 */
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
  /**
   * 화면 모드 여러 모니터(docs/neko-screen-mode.md 3단계): 세계에 놓인 모든 것(고양이·궤적·잡은 손·나비·소품·효과)을
   * (dx, dy) 세계 px 만큼 옮긴다. 속도·방향은 그대로. 호스트 순서: shiftWorld(dx, dy, 새 바닥) → setEdges.
   * ground: 새 모니터 바닥. dy 에 바닥 차이가 이미 들어 있어 바닥만 바꾼다(따로 setGround 하면 바닥 차이만큼 한 번 더 옮겨 튄다)
   */
  shiftWorld(dx: number, dy: number, ground?: number): void;
  /** 열린 쪽은 벽이 아니다: walkTo·walkOut 으로만 넘어간다(산책·마우스 따라가기는 안 넘음). 기본 둘 다 닫힘. 닫힌 쪽 밖이면 걸어 들어온다 */
  setEdges(e: { left: boolean; right: boolean }): void;
  /** 그쪽을 열고 가장자리 너머(몸이 다 넘어가는 만큼)로 걸어간다. 넘어가는 순간 "edge" */
  walkOut(side: "left" | "right"): void;
  /**
   * 산책 중(화면 모드 마당): 고양이를 감추고 그 자리 바닥에 나무 팻말(발자국·화살표)을 꽂는다. 그동안 고양이는 움직이지
   * 않고 hit·hitCarry 는 거짓이라 클릭은 뒤로 지나간다(마당 선물은 그대로). false 면 팻말을 거두고 그 자리에서 다시 보인다
   */
  setAway(on: boolean, o?: { music?: boolean }): void;
  readonly away: boolean;
  /** 지금 그리는 영역(세계 좌표). 화면 모드에선 고양이 둘레, 아니면 무대 전체 */
  readonly region: { x: number; y: number; w: number; h: number };
  /** 잡혀 있을 때 목덜미 자리(세계 좌표), 아니면 null. 화면 모드에선 커서가 창 밖이면 묶지 않고 따라가니, 호스트가 이 점이 다른 모니터에 닿을 때 창을 옮긴다 */
  readonly held: [number, number] | null;
  /**
   * 캣타워(화면 모드): 다른 창들의 윗변(발판)과 옆면(벽), 세계 좌표. 가려진 부분은 빼고 준다. 바뀔 때만.
   * partial = 창 번호면 그 창 항목만 갈아 끼운다(올라탄 창 30Hz). 빈 목록이면 다 내린다.
   * 올라탄 창이 움직이면(위치) 따라가지 않고 떨어진다(사용자 결정). 끝 하나만 바뀌면(크기·가림) 그대로
   */
  setPerches(p: {
    tops: { id: string; win: number; x0: number; x1: number; y: number }[];
    walls: { id: string; win: number; x: number; y0: number; y1: number; face: "left" | "right" }[];
    partial?: number;
  }): void;
  /** 올라앉아 있는 윗변 id(없으면 null). 호스트가 바뀔 때 Rust 에 알려 그 창을 30Hz 로 받는다 */
  readonly perch: string | null;
  /** 지금 창 탐험(tower)을 할 만한가: 화면 모드에서 바로 갈 수 있는 옆면·윗변이 있거나 이미 창 위. 감독이 고르기 전에 본다 */
  readonly towerOk: boolean;
  /** 개발 빌드 표시용: 창마다 창 탐험으로 갈 수 있나, 못 가면 까닭(지금 고양이 자리 기준) */
  towerWhy(): { win: number; why: string; ok: boolean }[];
  /**
   * 타이핑 쉼: 다른 앱에서 타이핑을 잠깐 멈췄을 때. 발은 키 위에 멈추고 글자가 안 늘며 화면을 보고 가끔 천천히 깜빡인다.
   * 타이핑일 때만 듣고(다른 활동은 무시) 활동이 바뀌면 저절로 꺼진다
   */
  setRest(on: boolean): void;
  /** 입에 문다. 같은 id 면 바꾼다. 여럿이면 최대 3장이 겹쳐 보인다 */
  carry(items: NekoCarryItem | NekoCarryItem[]): void;
  /** 입에서 뺀다(id 없으면 전부). 뺀 것을 돌려준다 */
  drop(id?: string): NekoCarried[];
  carried(): NekoCarried[];
  /**
   * 무대에 놓아 둔 물건(선물). 바닥: u = 양끝 여백을 뺀 무대 폭 비율 0~1. 벽: u 와 v = 바닥 위 쓸 수 있는 높이 비율 0~1.
   * 새로 놓인 것만 '뿅' 하고 나온다. 잡고 끌면 decorMove, 우클릭하면 decorMenu(저장·버튼은 호스트).
   * 화면 모드(world)는 자리·크기만 쓰고(놀 것 고르기·피하기) 그리기·누르기는 잡은 것만(decorHeld). 뿅은 없다
   */
  setDecor(items: ({ id: string; shape: unknown; play?: NekoGiftPlay; size?: NekoGiftSize; lastPlayed?: number } & NekoDecorSpot)[]): void;
  /** 놓아 둔 물건 수(감독이 '선물 갖고 놀기'를 고를지 볼 때) */
  readonly decorCount: number;
  /** 이 점(무대 px)이 놓아 둔 물건 위면 그 id */
  hitDecor(x: number, y: number): string | null;
  /** 무대 px 의 한 점(물건 가운데)을 자리로. 선물함에서 끌어 놓을 때 */
  decorSpotAt(x: number, y: number, shape: unknown, size?: NekoGiftSize): NekoDecorSpot;
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
