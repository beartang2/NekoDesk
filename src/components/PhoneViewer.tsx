import { useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { ViewerItem } from "./Viewer";
import "./PhoneViewer.css";

/**
 * 폰: 채팅의 그림·파일을 눌렀을 때 크게 보는 장. 맥은 따로 뜬 뷰어 창(Viewer.tsx, viewer_open)인데 폰에는 창이 하나라
 * 그 명령이 없어 눌러도 아무 일이 없었다(사용자: 모바일 파일 프리뷰). 그림은 화면에 맞춰 보이고 두 번 누르면 크게(밀어서 본다),
 * 글 파일은 글을 보인다. 볼 것이 없으면 까닭 한 줄.
 */
let current: ViewerItem | null = null;
const subs = new Set<() => void>();
function set(item: ViewerItem | null) { current = item; subs.forEach((f) => f()); }
export const showPhoneViewer = (item: ViewerItem): void => set(item);

const IMAGE_NAME = /\.(png|jpe?g|gif|webp|heic|heif|svg|bmp|tiff?)$/i;

export function PhoneViewer() {
  const item = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => current);
  const [big, setBig] = useState(false);
  const tapped = useRef(0);
  if (!item) return null;
  const close = () => { setBig(false); set(null); };
  const image = item.dataUrl?.startsWith("data:image/") ? item.dataUrl : null;
  // 두 번 누르기: iOS 웹뷰는 확대를 꺼 둬서 dblclick 이 안 온다 — 누른 사이를 잰다
  const tap = () => {
    const now = Date.now();
    if (now - tapped.current < 320) setBig((v) => !v);
    tapped.current = now;
  };
  return createPortal(
    <div className="phone-viewer" role="dialog" aria-label={item.name}>
      <header className="phone-viewer__header">
        <span className="phone-viewer__name">{item.name}</span>
        <button type="button" className="phone-viewer__close" onClick={close} aria-label="닫기"><X size={18} /></button>
      </header>
      <div className={`phone-viewer__body${image ? " phone-viewer__body--image" : ""}`}>
        {image ? (
          <img className={`phone-viewer__image${big ? " phone-viewer__image--big" : ""}`} src={image} alt={item.name} onClick={tap} />
        ) : item.text ? (
          <pre className="phone-viewer__text">{item.text}</pre>
        ) : (
          <p className="phone-viewer__none">
            {IMAGE_NAME.test(item.name) ? "그림 본문이 이 기기에 없습니다. 보낸 기기에서 볼 수 있습니다." : "이 파일은 미리 볼 수 없습니다."}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
