import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AlertDialog } from "radix-ui";
import { syncApi } from "../api/tauri";
import "./Update.css";

/**
 * 폰: 맥의 기기 연결 QR 을 카메라로 찍으면 앱이 열리고(nekodesk://pair?d=…), 여기서 서버 주소를 보여 주고 연결할지 묻는다.
 * 그 주소는 아무 앱·웹 링크나 열 수 있다 — 묻지 않고 연결하면 남의 서버로 대화가 올라갈 수 있다.
 */
export function PairLinkPrompt() {
  const [link, setLink] = useState<{ pairing: string; host: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const take = () => void syncApi.pairLinked().then((got) => {
      if (!got) return;
      setNote("");
      setLink({ pairing: got[0], host: got[1] });
    }).catch(() => {});
    take(); // 그 주소로 앱이 켜졌으면 화면보다 먼저 와 있다
    const off = listen("pair-link", take);
    return () => { void off.then((f) => f()); };
  }, []);

  async function join() {
    if (!link) return;
    setBusy(true);
    try {
      if ((await syncApi.status()).registered) { setNote("이미 다른 기기와 연결되어 있어요. 설정 › 연동 › 동기화에서 확인해 주세요."); return; }
      await syncApi.pairJoin(link.pairing);
      setLink(null);
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  }

  // 서버 이름은 백엔드가 주소 해석기로 뽑은 호스트다(화면에서 글자를 잘라 만들지 않는다 — user@host 로 속일 수 있다)
  const host = link?.host ?? "";
  return (
    <AlertDialog.Root open={!!link} onOpenChange={(open) => { if (!open) setLink(null); }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="update-overlay">
          <AlertDialog.Content className="update-dialog">
            <AlertDialog.Title className="update-dialog__title">이 기기를 연결할까요?</AlertDialog.Title>
            <AlertDialog.Description className="update-dialog__sub">
              {note || `${host} 서버로 대화·기억·할 일을 동기화해요. 내가 맥에서 만든 QR 이 맞을 때만 연결해 주세요.`}
            </AlertDialog.Description>
            <div className="update-dialog__actions">
              <AlertDialog.Cancel className="update-dialog__btn">취소</AlertDialog.Cancel>
              {!note && <button type="button" className="update-dialog__btn update-dialog__btn--primary" disabled={busy} onClick={() => void join()}>연결하기</button>}
            </div>
          </AlertDialog.Content>
        </AlertDialog.Overlay>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
