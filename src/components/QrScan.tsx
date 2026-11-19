import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { syncApi } from "../api/tauri";
import { PAIR_SCANNED } from "./PairLink";
import "./QrScan.css";

/**
 * 폰: 맥 화면의 기기 연결 QR 을 앱 안에서 찍는다. 카메라 그림을 캔버스로 옮겨 jsQR 로 읽고(필요할 때만 불러온다),
 * 연결 주소면 카메라를 끄고 확인 창(PairLinkPrompt)으로 넘긴다 — 여기서 바로 연결하지 않는다.
 */
export function QrScan({ onClose }: { onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [note, setNote] = useState("맥 화면의 QR 을 네모 안에 비춰 주세요.");
  // 부모가 다시 그려질 때마다(동기화 칸은 5초마다) 카메라를 껐다 켜지 않게, 닫기는 ref 로 부른다
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let done = false;
    const stop = () => { done = true; clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); };
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch {
        setNote("카메라를 쓸 수 없어요. 설정 앱 › NekoDesk 에서 카메라를 허용하거나, 아이폰 카메라 앱으로 QR 을 찍어 주세요.");
        return;
      }
      if (done) { stop(); return; }
      const v = video.current;
      if (!v) return;
      v.srcObject = stream;
      await v.play().catch(() => {});
      const { default: jsQR } = await import("jsqr");
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      let busy = false;
      timer = window.setInterval(() => {
        if (busy || done || !ctx || !v.videoWidth) return;
        busy = true;
        // 긴 쪽 640px 로 줄여 읽는다(코드가 길어 칸이 촘촘하다 — 더 줄이면 못 읽는다)
        const k = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * k);
        canvas.height = Math.round(v.videoHeight * k);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const found = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
        if (!found) { busy = false; return; }
        void syncApi.pairCheck(found).then((got) => {
          if (!got) { setNote("NekoDesk 기기 연결 QR 이 아니에요."); busy = false; return; }
          stop();
          window.dispatchEvent(new CustomEvent(PAIR_SCANNED, { detail: got }));
          close.current();
        }).catch(() => { busy = false; });
      }, 200);
    })();
    return stop;
  }, []);

  return createPortal(
    <div className="qr-scan" role="dialog" aria-label="기기 연결 QR 찍기">
      <video ref={video} className="qr-scan__video" playsInline muted />
      <div className="qr-scan__frame" aria-hidden="true" />
      <p className="qr-scan__note">{note}</p>
      <button type="button" className="qr-scan__close" onClick={onClose}>닫기</button>
    </div>,
    document.body,
  );
}
