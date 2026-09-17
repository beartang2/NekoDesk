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

/** 빠른 질문 창 → 메인 창. 포함하기로 고른 맥락만 실린다. */
export interface QuickAskPayload {
  text: string;
  selection?: string;
  clipboard?: string;
  app?: string;
}

export const QUICK_CONTEXT_EVENT = "quick-context";
export const QUICK_ASK_EVENT = "quick-ask";

/** 채팅에 보일 인용 미리보기 길이. 모델에는 전부 간다. */
const PREVIEW_CHARS = 80;

function preview(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS - 1)}…` : one;
}

/**
 * 모델에 보낼 글과 채팅에 보일 글을 만든다.
 *
 * 맥락은 질문 **뒤에** 붙인다. 앞에 두면 긴 선택문이 질문을 밀어내 4B 모델이 무엇을
 * 하라는 건지 놓친다. 채팅에는 맥락을 한 줄 인용으로만 보여준다 — 로그 수천 줄을
 * 복사해 물어봐도 대화창이 그걸로 도배되지 않게.
 */
export function buildQuickPrompt(p: QuickAskPayload): { userText: string; displayText: string } {
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
