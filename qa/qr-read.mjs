// 기기 연결 QR(sync_pair_qr 의 SVG)이 가운데 발바닥을 넣고도 읽히는지 확인한다.
//   NEKO_QR_OUT=/tmp/qr.svg cargo test --lib sync::run   (src-tauri 에서)  →  node qa/qr-read.mjs /tmp/qr.svg
// SVG 의 칸(M x.06 y.06 …)을 그대로 점으로 찍어 jsQR(폰이 쓰는 것)로 읽는다. 발바닥 칸도 어두운 칸으로 친다(가장 나쁜 경우).
import { readFileSync } from "node:fs";
import jsQR from "jsqr";

const svg = readFileSync(process.argv[2], "utf8");
const size = Number(svg.match(/viewBox="0 0 (\d+)/)[1]);
const K = 4; // 칸 하나를 4px 로(폰 카메라에서 칸이 작게 잡히는 쪽에 가깝게)
const px = new Uint8ClampedArray(size * K * size * K * 4).fill(255);
for (const [, x, y] of svg.matchAll(/M(\d+)\.06 (\d+)\.06/g)) {
  for (let dy = 0; dy < K; dy++) for (let dx = 0; dx < K; dx++) {
    const i = ((y * K + dy) * size * K + (x * K + dx)) * 4;
    px[i] = px[i + 1] = px[i + 2] = 0;
  }
}
const read = jsQR(px, size * K, size * K)?.data;
if (!read?.startsWith("nekodesk://pair?d=")) { console.error("못 읽음:", read); process.exit(1); }
console.log(`읽힘: ${size - 8}칸, ${read.length}글자`);
