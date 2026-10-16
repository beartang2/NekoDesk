import { useEffect, useRef } from "react";
import { getAnimation } from "./spriteData";

/** 스프라이트 한 칸(32×32)에서 머리만 — 귀 끝부터 턱까지. 털색마다 밑그림이 같아 자리도 같다. */
const HEAD = { x: 2, y: 3, w: 17, h: 17 };

/**
 * 네코 얼굴. 평소 그림의 첫 칸에서 머리만 잘라 그린다.
 *
 * 17px 을 정수배로 키워야 픽셀이 고르다. 기본 34px 은 레티나에서 4배, 일반 모니터에서 2배.
 */
export function NekoHead({ variantId, size = 34, className }: { variantId: string; size?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { src, frames } = getAnimation("idle", variantId);
    const frame = frames[0];
    const image = new Image();
    const draw = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, frame.x + HEAD.x, frame.y + HEAD.y, HEAD.w, HEAD.h, 0, 0, canvas.width, canvas.height);
    };
    image.addEventListener("load", draw);
    image.src = src;
    if (image.complete) draw();
    return () => image.removeEventListener("load", draw);
  }, [variantId]);

  return (
    <canvas
      ref={ref}
      className={className}
      width={HEAD.w * 4}
      height={HEAD.h * 4}
      style={{ width: size, height: size, imageRendering: "pixelated" }}
      aria-hidden="true"
    />
  );
}
