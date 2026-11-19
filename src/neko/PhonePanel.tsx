import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { NekoCustomize } from "./NekoCustomizeModal";
import { NekoGiftPanel } from "./NekoGiftBox";
import { usePhonePanel } from "./panel";
import "./PhonePanel.css";

const TITLE = { "neko-customize": "네코 꾸미기", "neko-gifts": "선물함" } as const;

/**
 * 폰: 네코 꾸미기·선물함을 설정 위에 한 장으로 띄운다. 맥에서 따로 뜨는 창(NekoPanelWindow)과 같은 내용이고,
 * 창 틀이 하던 제목·닫기를 여기서 그린다. 같은 화면이라 네코·선물 스토어를 그대로 같이 쓴다.
 */
export function PhonePanel() {
  const kind = usePhonePanel((s) => s.kind);
  const close = usePhonePanel((s) => s.close);
  if (!kind) return null;
  return createPortal(
    <div className="phone-panel" role="dialog" aria-label={TITLE[kind]}>
      <header className="phone-panel__header">
        <h2 className="phone-panel__title">{TITLE[kind]}</h2>
        <button type="button" className="phone-panel__close" onClick={close} aria-label="닫기"><X size={18} /></button>
      </header>
      <div className="phone-panel__body">
        {kind === "neko-customize" ? <NekoCustomize onClose={close} /> : <NekoGiftPanel />}
      </div>
    </div>,
    document.body,
  );
}
