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

/**
 * 툴이 만든 그림(SVG·PNG·JPEG data URL)을 모델이 받는 PNG 로 굽는다. 긴 변 maxPx.
 *
 * Claude 는 SVG 를 이미지로 받지 않는다. 웹뷰가 SVG 를 그릴 줄 아니 캔버스에 한 번
 * 그려 PNG 로 뽑는다. 못 읽거나(깨진 SVG) 캔버스가 막히면 null — 그 그림은 안 보여 주면 된다.
 */
export function rasterizeForLlm(dataUrl: string, maxPx = 768): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // 깨진 SVG 는 onerror 없이 영영 안 끝나기도 한다. 기다리다 루프가 멈추면 안 된다.
    const timer = setTimeout(() => resolve(null), 3000);
    const done = (v: string | null) => { clearTimeout(timer); resolve(v); };
    img.onerror = () => done(null);
    img.onload = () => {
      // 크기 없는 SVG(width/height 빠짐)는 0 으로 온다. viewBox 비율을 모르니 정사각으로 본다.
      const w0 = img.naturalWidth || maxPx;
      const h0 = img.naturalHeight || maxPx;
      const scale = Math.min(1, maxPx / Math.max(w0, h0));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w0 * scale));
      canvas.height = Math.max(1, Math.round(h0 * scale));
      try {
        canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
        done(canvas.toDataURL("image/png"));
      } catch {
        done(null);
      }
    };
    img.src = dataUrl;
  });
}
