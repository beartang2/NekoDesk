import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { PLACE_NAME } from "./gifts";
import type { NekoPlacement } from "./nekoStore";
import "../components/Update.css"; // 확인 창과 같은 모양

/** 고를 자리 하나. off = 흐리게, 못 고름(이미 놓인 곳·꽉 찬 곳). note 는 오른쪽 작은 글 */
export type PlaceChoice = { at: NekoPlacement; note?: string; off?: boolean };
export type PlaceAsk = {
  title: string;
  question: string;
  choices: PlaceChoice[];
  /** 자리를 골랐다(선물) */
  pick?: (at: NekoPlacement) => void;
  /** 자리를 고른 뒤 한 단계 더(가구: 그 자리의 칸 고르기) — 질문과 본문. 본문이 done() 을 부르면 닫힌다 */
  then?: { question: string; body: (at: NekoPlacement, done: () => void) => ReactNode };
};

/**
 * 선물함 '놓기·옮기기' 뒤에 뜨는 '어디에 놓을까요?'(선물·가구 탭이 같이 쓴다). 네코가 지금 어디 있든 고른 자리에 놓는다.
 * 모양은 버리기 확인 창(update-dialog)과 같고, 자리는 한 줄씩 큰 버튼 — 폰에서도 누르기 쉽게. 바깥을 누르거나 Esc 면 취소.
 * then 이 있으면(가구) 자리를 고른 뒤 같은 창에서 칸을 고른다('뒤로'로 자리 고르기로)
 */
export function PlacePicker({ ask, onClose }: { ask: PlaceAsk | null; onClose: () => void }) {
  const [at, setAt] = useState<NekoPlacement | null>(null);
  useEffect(() => setAt(null), [ask]);
  const step = ask?.then && at ? ask.then : null;
  return (
    <Dialog.Root open={!!ask} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="update-overlay">
          <Dialog.Content className="update-dialog place-pick">
            <Dialog.Title className="update-dialog__title">{step ? step.question : ask?.question}</Dialog.Title>
            <Dialog.Description className="update-dialog__sub">{ask?.title}{step && at ? ` · ${PLACE_NAME[at]}` : ""}</Dialog.Description>
            {step && at ? step.body(at, onClose) : <div className="place-pick__list">
              {ask?.choices.map((c) => (
                <button
                  key={c.at}
                  type="button"
                  className="update-dialog__btn place-pick__btn"
                  disabled={c.off}
                  onClick={() => { if (ask.then) setAt(c.at); else { ask.pick?.(c.at); onClose(); } }}
                >
                  <span>{PLACE_NAME[c.at]}</span>
                  {c.note && <span className="place-pick__note">{c.note}</span>}
                </button>
              ))}
            </div>}
            <div className="update-dialog__actions">
              {step && <button type="button" className="update-dialog__btn place-pick__back" onClick={() => setAt(null)}>뒤로</button>}
              <Dialog.Close className="update-dialog__btn">취소</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
