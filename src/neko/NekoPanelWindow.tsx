import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { syncWindowTheme } from "../lib/window-theme";
import { startNekoWindowSync } from "./windowSync";
import { NekoCustomize } from "./NekoCustomizeModal";
import { NekoGiftPanel } from "./NekoGiftBox";

export type NekoPanelKind = "neko-customize" | "neko-gifts";

const close = () => void getCurrentWindow().close();

/** 설정에서 따로 띄우는 창(panel_open). 메인 창과 테마·네코·선물을 맞추고, Esc 로 닫는다 */
export function NekoPanelWindow({ kind }: { kind: NekoPanelKind }) {
  useEffect(() => {
    syncWindowTheme();
    startNekoWindowSync();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing) close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return kind === "neko-customize" ? <NekoCustomize onClose={close} /> : <NekoGiftPanel />;
}
