/**
 * 타입 있는 인앱 이벤트 버스.
 *
 * 예전엔 `window.dispatchEvent(new CustomEvent("nekodesk:...", { detail }))` +
 * `window.addEventListener("nekodesk:...")` 라는 문자열 기반 전역 버스였다.
 * 이벤트 이름 오타나 잘못된 페이로드가 런타임까지 안 잡혔고, 컴포넌트가
 * `window` 전역에 결합됐다. 여기서는 이벤트 이름·페이로드가 컴파일 타임에 검증된다.
 */

import type { CodeExecResult } from "../agent/types";

export type StartGamePayload =
  | { type: "drawing" }
  | { type: "wordchain"; requestId?: number };

/** 이벤트 이름 → 페이로드 타입. void 는 페이로드 없음. */
interface EventMap {
  coderun: CodeExecResult;
  agentDone: void;
  wordchainGameover: void;
  startGame: StartGamePayload;
  /** 포모도로·커스텀 타이머가 끝났다. 네코가 할 말. */
  timerDone: string;
}

type Handler<T> = (payload: T) => void;

class TypedEmitter {
  private listeners = new Map<keyof EventMap, Set<Handler<unknown>>>();

  /** 구독. 반환된 함수를 호출하면 해제된다(useEffect cleanup 에 그대로 쓴다). */
  on<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as Handler<unknown>);
    return () => {
      this.listeners.get(event)?.delete(handler as Handler<unknown>);
    };
  }

  /** 발행. void 이벤트는 페이로드를 생략한다. */
  emit<K extends keyof EventMap>(
    event: K,
    ...args: EventMap[K] extends void ? [] : [EventMap[K]]
  ): void {
    const payload = args[0];
    this.listeners.get(event)?.forEach((h) => h(payload));
  }
}

export const appEvents = new TypedEmitter();

// ── 끝말잇기 첫 단어 요청/응답 ──────────────────────────────────────────────────
// 에이전트가 game.start(wordchain) 으로 게임을 시작시키고 UI 로부터 첫 단어를
// 돌려받는다. 예전엔 window.__nekodeskWordchainResolve 라는 단일 전역 슬롯이라
// 게임을 둘 이상 동시에 시작하면 서로 덮어써 레이스가 났다. 요청마다 고유 id 를
// 붙인 promise 맵으로 바꿔 격리한다.

let wordchainCounter = 0;
const wordchainPending = new Map<number, (word: string | null) => void>();

/** 끝말잇기를 시작시키고 첫 단어를 기다린다(타임아웃 시 null). */
export function requestWordchainFirstWord(timeoutMs = 15000): Promise<string | null> {
  const requestId = ++wordchainCounter;
  return new Promise((resolve) => {
    const settle = (word: string | null) => {
      if (wordchainPending.delete(requestId)) resolve(word);
    };
    wordchainPending.set(requestId, settle);
    appEvents.emit("startGame", { type: "wordchain", requestId });
    setTimeout(() => settle(null), timeoutMs);
  });
}

/** UI 가 첫 단어를 준비하면 호출. 해당 요청이 있으면 전달하고 true, 없으면 false
 *  (에이전트 없이 직접 시작한 경우 → 호출부가 직접 메시지를 띄운다). */
export function resolveWordchainFirstWord(
  requestId: number | undefined,
  word: string | null,
): boolean {
  if (requestId === undefined) return false;
  const settle = wordchainPending.get(requestId);
  if (settle) {
    settle(word);
    return true;
  }
  return false;
}
