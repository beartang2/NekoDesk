/**
 * 모델에 보낼 이미지를 긴 변 maxPx 로 줄여 data URL 로.
 *
 * 비전 모델은 이미지 크기만큼 토큰을 먹는다. 첨부 사진은 768 이면 충분하지만, 글씨가
 * 많은 화면 캡처는 그보다 크게 넘겨야 읽힌다(호출부가 정한다). 못 읽으면 원본 그대로.
 */
export function resizeImageForLlm(
  file: Blob,
  maxPx = 768,
  /** 정하지 않으면 PNG 는 PNG, 나머지는 JPEG(0.82). 화면 캡처는 JPEG 0.9 로 받는다. */
  out?: { type: "image/png" | "image/jpeg"; quality?: number }
): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve("");
    reader.onload = (e) => {
      const src = e.target?.result as string;
      const img = new Image();
      img.onerror = () => resolve(src); // fallback: return original
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
        const mime = out?.type ?? (file.type === "image/png" ? "image/png" : "image/jpeg");
        const quality = mime === "image/jpeg" ? out?.quality ?? 0.82 : undefined;
        resolve(canvas.toDataURL(mime, quality));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}
