/**
 * 캔버스 비트맵을 화면에 보이는 박스 크기에 맞춘다.
 *
 * 크기를 바꾸면 캔버스가 비워지므로 그리던 내용을 옮겨 담는데, **확대·축소 없이**
 * 좌상단에 그대로 붙인다. 늘어난 자리는 흰 여백이 된다.
 *
 * 예전 구현이 이 함수 대신 "500×600 고정 비트맵을 wrapper 로 잘라 보여주기" 를 택한
 * 이유가 바로 왜곡이었다. 그 방식은 왜곡은 막았지만 toDataURL 이 안 보이는 여백까지
 * 통째로 내보내는 대가를 치렀다.
 *
 * @returns 실제로 크기를 바꿨으면 true (호출자가 되돌리기 스택을 비울 수 있게).
 */
export function syncCanvasToBox(canvas: HTMLCanvasElement, scale = 2): boolean {
  const w = Math.round(canvas.clientWidth * scale);
  const h = Math.round(canvas.clientHeight * scale);
  if (!w || !h || (canvas.width === w && canvas.height === h)) return false;

  const prev = canvas.ownerDocument.createElement("canvas");
  prev.width = canvas.width;
  prev.height = canvas.height;
  prev.getContext("2d")?.drawImage(canvas, 0, 0);

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  // 인자 3개 = 원본 크기 그대로. 여기에 폭·높이를 더하면(인자 5개) 그림이 늘어난다.
  ctx.drawImage(prev, 0, 0);
  return true;
}
