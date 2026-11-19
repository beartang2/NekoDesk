import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { IS_PHONE } from "../lib/platform";
import type { NekoPanelKind } from "./NekoPanelWindow";

/** 폰: 지금 화면 위에 띄운 네코 창(꾸미기·선물함). 폰엔 창이 하나라 따로 띄울 수 없다 */
export const usePhonePanel = create<{ kind: NekoPanelKind | null; close: () => void }>((set) => ({
  kind: null,
  close: () => set({ kind: null }),
}));

/** 네코 꾸미기·선물함을 연다. 맥은 따로 뜨는 창(panel_open), 폰은 같은 화면 위의 한 장(PhonePanel) */
export function openNekoPanel(kind: NekoPanelKind): void {
  if (IS_PHONE) {
    // 키보드가 떠 있으면 내린다(lib/phone.ts 를 부르면 서로 불러 돌아서, 같은 일을 여기서 한다)
    const el = document.activeElement;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) el.blur();
    usePhonePanel.setState({ kind });
  }
  else void invoke("panel_open", { kind }).catch(() => {});
}
