/**
 * ⌃⇧N 빠른 질문 창 ↔ 메인 창이 주고받는 것.
 *
 * 빠른 질문 창은 입력만 받는다. 실제 에이전트 루프·확인 창·기억은 전부 메인 창에
 * 있으므로, 질문을 메인 창으로 넘기고 창은 곧바로 사라진다. 답은 메인 창의 "빠른
 * 질문" 대화에 쌓이고, 사용자가 다른 앱에 가 있으니 macOS 알림으로도 온다.
 */

/** Rust(quick.rs)가 단축키 순간에 읽어 보내는 맥락. */
export interface QuickContext {
  selection: string | null;
  clipboard: string | null;
  app: string | null;
}

/** 선택한 글에 한 번 눌러 시키는 일. */
export const QUICK_ACTIONS = ["요약", "번역", "설명"] as const;
export type QuickAction = (typeof QUICK_ACTIONS)[number];

/** 빠른 질문 창 → 메인 창. 포함하기로 고른 맥락만 실린다. */
export interface QuickAskPayload {
  text: string;
  /** 선택한 글에 누른 버튼. 있으면 text 는 무시하고 selection 에 그 일만 한다. */
  action?: QuickAction;
  selection?: string;
  clipboard?: string;
  app?: string;
  /** 📷 로 잘라 온 화면. 모델용으로 줄인 JPEG data URL. 메인 창이 첨부로 붙인다. */
  image?: string;
}

export const QUICK_CONTEXT_EVENT = "quick-context";
export const QUICK_ASK_EVENT = "quick-ask";

/** 채팅에 보일 인용 미리보기 길이. 모델에는 전부 간다. */
const PREVIEW_CHARS = 80;

function preview(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS - 1)}…` : one;
}

/** 버튼 일은 말풍선에 고른 글을 이만큼까지만 보인다. 모델에는 전부 간다. */
const ACTION_PREVIEW_CHARS = 600;

/**
 * 한국어로 쓴 글인가. 한글 한 음절은 라틴 글자 셋쯤으로 친다 — 글자 수로만 세면 "오늘 FOMC 회의"
 * 처럼 영문 약어가 섞인 한국어 문장이 영어로 잡힌다.
 */
export function isKorean(s: string): boolean {
  const letters = s.match(/\p{L}/gu) ?? [];
  const hangul = letters.filter((c) => /\p{Script=Hangul}/u.test(c)).length;
  return hangul * 3 > letters.length - hangul;
}

/**
 * 버튼 일의 지시. 채팅 시스템 프롬프트 대신 이것만 보낸다(runTextTask).
 * 번역 방향은 모델에 "한국어면 영어로" 판단을 맡기지 않고 여기서 정한다 — 4B 는 그 조건을
 * 자주 놓쳤다.
 */
function actionSystem(action: QuickAction, text: string): string {
  switch (action) {
    case "번역": {
      const to = isKorean(text) ? "영어" : "한국어";
      // "한 문장도 빠뜨리지 말고" 가 없으면 4B 가 두 문장을 한 문장으로 뭉치며 수치·요일을 흘렸다.
      return `너는 번역기야. 사용자가 준 글을 한 문장도 빠뜨리지 말고 자연스러운 ${to}로 번역해. 번역만 출력해.`;
    }
    case "요약":
      return "사용자가 준 글을 한국어로 세 줄 안쪽으로 요약해. 요약만 반말로 출력해.";
    case "설명":
      return "사용자가 준 글을 처음 보는 사람도 알게 한국어로 쉽게 풀어 설명해. 반말로 짧게.";
  }
}

/** 버튼 일. 말풍선엔 고른 글과 라벨만 보이고, 모델엔 고른 글과 그 일의 지시만 간다. */
export interface QuickTask {
  label: QuickAction;
  system: string;
}

/**
 * 모델에 보낼 글과 채팅에 보일 글을 만든다.
 *
 * 맥락은 질문 **뒤에** 붙인다. 앞에 두면 긴 선택문이 질문을 밀어내 4B 모델이 무엇을
 * 하라는 건지 놓친다. 채팅에는 맥락을 한 줄 인용으로만 보여준다 — 로그 수천 줄을
 * 복사해 물어봐도 대화창이 그걸로 도배되지 않게.
 */
export function buildQuickPrompt(p: QuickAskPayload): { userText: string; displayText: string; task?: QuickTask } {
  if (p.action && p.selection?.trim()) {
    const text = p.selection.trim();
    return {
      userText: text,
      displayText: text.length > ACTION_PREVIEW_CHARS ? `${text.slice(0, ACTION_PREVIEW_CHARS - 1)}…` : text,
      task: { label: p.action, system: actionSystem(p.action, text) },
    };
  }
  const where = p.app ? ` (${p.app})` : "";
  const blocks: string[] = [];
  const quotes: string[] = [];
  if (p.selection) {
    blocks.push(`[선택한 텍스트${where}]\n${p.selection}`);
    quotes.push(`> 선택${where}: ${preview(p.selection)}`);
  }
  if (p.clipboard) {
    blocks.push(`[클립보드]\n${p.clipboard}`);
    quotes.push(`> 클립보드: ${preview(p.clipboard)}`);
  }
  const text = p.text.trim();
  return {
    userText: blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text,
    displayText: quotes.length ? `${text}\n\n${quotes.join("\n")}` : text,
  };
}
