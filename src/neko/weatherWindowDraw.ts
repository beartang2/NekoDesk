import { GIFT_PALETTE } from "./engine/gift-shape";

/**
 * 방·거실 창문 그림(WeatherWindow). 네코 그림체를 따른다 — 선 없이 면만, 위가 밝고 아래가 살짝 어두운 덩어리,
 * 그늘은 검정이 아니라 보랏빛 갈색(INK) 쪽으로, 색은 선물 그림과 같은 팔레트(gift-shape).
 */

export type WeatherKind = "clear" | "cloud" | "rain" | "snow" | "storm" | "fog";

/** WMO 날씨 코드 → 창밖 그림 6가지. 모르는 코드는 구름 */
export function weatherKind(code: number): WeatherKind {
  if (code === 0 || code === 1) return "clear";
  if (code === 45 || code === 48) return "fog";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95 && code <= 99) return "storm";
  return "cloud";
}

/** 해 뜨고 지는 앞뒤 이만큼(초) 동안 하늘이 바뀐다 */
const TWILIGHT_S = 45 * 60;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * 지금(유닉스 초) 하늘의 밝기: light 0(밤)~1(낮), glow 0~1(해 뜨고 질 무렵 붉은 기운).
 * 해 뜨고 지는 때를 모르면 낮·밤만(isDay).
 */
export function skyAt(nowS: number, sunrise: number | null, sunset: number | null, isDay: boolean) {
  if (sunrise == null || sunset == null) return { light: isDay ? 1 : 0, glow: 0 };
  const light = Math.min(smooth(sunrise - TWILIGHT_S, sunrise + TWILIGHT_S, nowS), 1 - smooth(sunset - TWILIGHT_S, sunset + TWILIGHT_S, nowS));
  const glow = Math.max(0, 1 - Math.abs(nowS - sunrise) / TWILIGHT_S, 1 - Math.abs(nowS - sunset) / TWILIGHT_S);
  return { light, glow };
}

type Rgb = [number, number, number];
const rgbOf = (hex: string): Rgb => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k)) as Rgb;
const css = ([r, g, b]: Rgb, a = 1) => (a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`);
const P = Object.fromEntries(Object.entries(GIFT_PALETTE).map(([k, v]) => [k, rgbOf(v)])) as Record<keyof typeof GIFT_PALETTE, Rgb>;
const INK: Rgb = [58, 44, 52];
const WHITE: Rgb = [255, 255, 255];

// 하늘: 위·아래 색. 밤 → 낮을 light 로 섞고, 해 뜨고 질 무렵은 glow 만큼 노을 쪽으로
const SKY = {
  night: [[40, 46, 82], [70, 72, 112]] as Rgb[],
  day: [[118, 178, 230], [198, 228, 246]] as Rgb[],
  dusk: [[112, 98, 164], [246, 172, 128]] as Rgb[],
};
/** 흐린 날씨는 하늘을 회색 쪽으로 이만큼 */
const OVERCAST: Record<WeatherKind, number> = { clear: 0, cloud: 0.3, rain: 0.55, snow: 0.45, storm: 0.72, fog: 0.62 };

/** 0~1 의사 난수(자리마다 같은 값 — 빗방울·별·구름이 매 프레임 같은 자리에서 이어진다) */
const rnd = (i: number, k: number) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };

function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
/** 면 칠하기: 위는 밝게, 아래는 INK 쪽으로 살짝(선물 그림과 같은 입체) */
function shade(g: CanvasRenderingContext2D, rgb: Rgb, y0: number, y1: number, a = 1) {
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, css(mix(rgb, WHITE, 0.3), a)); gr.addColorStop(0.45, css(rgb, a)); gr.addColorStop(1, css(mix(rgb, INK, 0.16), a));
  return gr;
}

function cloud(g: CanvasRenderingContext2D, x: number, y: number, s: number, rgb: Rgb, a: number) {
  g.fillStyle = shade(g, rgb, y - s * 0.9, y + s * 0.35, a);
  g.beginPath();
  g.arc(x - s * 0.55, y, s * 0.42, 0, Math.PI * 2);
  g.arc(x, y - s * 0.28, s * 0.58, 0, Math.PI * 2);
  g.arc(x + s * 0.6, y - s * 0.02, s * 0.4, 0, Math.PI * 2);
  g.fill();
  rrect(g, x - s * 0.95, y - s * 0.05, s * 1.9, s * 0.42, s * 0.21); g.fill();
}

/** 창밖 한 장면(유리 안쪽, 0,0~pw,ph). t = 날씨 움직임 시계(초) */
function scene(g: CanvasRenderingContext2D, pw: number, ph: number, kind: WeatherKind, light: number, glow: number, t: number) {
  const over = OVERCAST[kind], gray: Rgb = mix([150, 156, 168], [64, 66, 82], 1 - light);
  const sky = [0, 1].map((i) => mix(mix(mix(SKY.night[i], SKY.day[i], light), SKY.dusk[i], glow * (1 - over * 0.6)), gray, over));
  const gr = g.createLinearGradient(0, 0, 0, ph);
  gr.addColorStop(0, css(sky[0])); gr.addColorStop(1, css(sky[1]));
  g.fillStyle = gr; g.fillRect(0, 0, pw, ph);
  const u = Math.min(pw, ph);

  // 별·달(밤, 맑거나 구름 조금)
  if (light < 0.5 && (kind === "clear" || kind === "cloud")) {
    const a = (1 - light * 2) * (kind === "clear" ? 1 : 0.5);
    for (let i = 0; i < 14; i++) {
      const tw = 0.55 + 0.45 * Math.sin(t * (1.3 + rnd(i, 3)) + i);
      g.fillStyle = css(P.white, a * tw * 0.9);
      g.beginPath(); g.arc(rnd(i, 1) * pw, rnd(i, 2) * ph * 0.7, 0.5 + rnd(i, 4) * 0.7, 0, Math.PI * 2); g.fill();
    }
    const mx = pw * 0.7, my = ph * 0.24, mr = u * 0.12;
    g.fillStyle = css(mix(P.yellow, WHITE, 0.55), a);
    g.beginPath(); g.arc(mx, my, mr, 0, Math.PI * 2); g.fill();
    g.fillStyle = css(sky[0]); // 초승달: 하늘색 원으로 한쪽을 가린다
    g.beginPath(); g.arc(mx + mr * 0.45, my - mr * 0.25, mr * 0.88, 0, Math.PI * 2); g.fill();
  }
  // 해(낮, 맑거나 구름 조금). 해 질 무렵엔 주황으로 낮게
  if (light > 0.3 && (kind === "clear" || kind === "cloud")) {
    const sx = pw * 0.7, sy = ph * (0.24 + glow * 0.22), sr = u * 0.13, col = mix(P.yellow, P.orange, glow);
    const a = Math.min(1, (light - 0.3) * 3);
    g.fillStyle = css(col, a * (0.22 + 0.06 * Math.sin(t * 1.4)));
    g.beginPath(); g.arc(sx, sy, sr * 1.7, 0, Math.PI * 2); g.fill();
    g.fillStyle = shade(g, col, sy - sr, sy + sr, a);
    g.beginPath(); g.arc(sx, sy, sr, 0, Math.PI * 2); g.fill();
  }

  // 먼 언덕(눈이면 하얗게)
  const hill = kind === "snow" ? mix(P.white, [150, 160, 190], 1 - light) : mix(mix(P.green, INK, 0.62), P.green, light * (1 - over * 0.5));
  g.fillStyle = shade(g, hill, ph * 0.8, ph);
  g.beginPath(); g.ellipse(pw * 0.3, ph * 1.02, pw * 0.75, ph * 0.2, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = shade(g, mix(hill, INK, 0.12), ph * 0.85, ph);
  g.beginPath(); g.ellipse(pw * 0.95, ph * 1.06, pw * 0.6, ph * 0.18, 0, 0, Math.PI * 2); g.fill();

  // 구름: 날씨마다 수·색. 천천히 오른쪽으로 흘러간다
  const n = { clear: 1, cloud: 3, rain: 3, snow: 2, storm: 3, fog: 0 }[kind];
  const cRgb = kind === "storm" ? mix([110, 112, 130], INK, 0.3 * (1 - light)) : mix(mix(P.white, [190, 194, 206], over), [96, 98, 128], 1 - light);
  for (let i = 0; i < n; i++) {
    const s = u * (0.2 + rnd(i, 5) * 0.12) * (kind === "clear" ? 0.8 : 1), span = pw + s * 3;
    const x = ((rnd(i, 6) * span + t * u * (0.025 + rnd(i, 7) * 0.02)) % span) - s * 1.5;
    cloud(g, x, ph * (0.16 + i * 0.13 + rnd(i, 8) * 0.06), s, cRgb, kind === "clear" ? 0.85 : 0.95);
  }

  // 비·천둥: 비스듬한 빗줄기
  if (kind === "rain" || kind === "storm") {
    const drops = Math.round((pw * ph) / (kind === "storm" ? 90 : 130)), len = Math.max(3, ph * 0.07);
    g.strokeStyle = css(mix(P.blue, WHITE, light * 0.4), 0.75); g.lineWidth = 1; g.lineCap = "round";
    g.beginPath();
    for (let i = 0; i < drops; i++) {
      const y = (rnd(i, 9) * (ph + len) + t * ph * (0.9 + rnd(i, 10) * 0.4)) % (ph + len) - len, x = rnd(i, 11) * (pw + 8) - y * 0.18;
      g.moveTo(x, y); g.lineTo(x - len * 0.18, y + len);
    }
    g.stroke();
  }
  // 눈: 흔들리며 천천히
  if (kind === "snow") {
    g.fillStyle = css(P.white, 0.95);
    const flakes = Math.round((pw * ph) / 150);
    for (let i = 0; i < flakes; i++) {
      const y = (rnd(i, 12) * (ph + 4) + t * ph * (0.12 + rnd(i, 13) * 0.08)) % (ph + 4) - 2;
      const x = rnd(i, 14) * pw + Math.sin(t * (0.8 + rnd(i, 15)) + i) * 2.5;
      g.beginPath(); g.arc(x, y, 0.8 + rnd(i, 16) * 0.9, 0, Math.PI * 2); g.fill();
    }
  }
  // 천둥: 몇 초에 한 번 번쩍 + 번개
  if (kind === "storm") {
    const k = (t % 6.5) / 6.5, flash = k < 0.03 ? 1 - k / 0.03 : 0;
    if (flash > 0) {
      g.fillStyle = css(WHITE, 0.45 * flash); g.fillRect(0, 0, pw, ph);
      const bx = pw * (0.3 + rnd(Math.floor(t / 6.5), 17) * 0.4);
      g.fillStyle = css(P.yellow, flash);
      g.beginPath();
      g.moveTo(bx, ph * 0.28); g.lineTo(bx - u * 0.08, ph * 0.56); g.lineTo(bx, ph * 0.54); g.lineTo(bx - u * 0.05, ph * 0.8);
      g.lineTo(bx + u * 0.08, ph * 0.48); g.lineTo(bx + u * 0.01, ph * 0.5); g.lineTo(bx + u * 0.06, ph * 0.28);
      g.closePath(); g.fill();
    }
  }
  // 안개: 옅은 띠가 좌우로 느리게
  if (kind === "fog") {
    for (let i = 0; i < 4; i++) {
      const y = ph * (0.22 + i * 0.2), dx = Math.sin(t * 0.25 + i * 1.7) * pw * 0.12;
      g.fillStyle = css(mix(P.white, [150, 154, 176], 1 - light), 0.42);
      rrect(g, -pw * 0.2 + dx + (i % 2) * pw * 0.15, y, pw * 1.1, ph * 0.1, ph * 0.05); g.fill();
    }
  }
}

export interface WindowState {
  kind: WeatherKind;
  /** 바뀌기 전 날씨(겹쳐 바뀌는 동안만), fade 0~1 = 새 날씨가 덮인 정도 */
  prev: WeatherKind | null;
  fade: number;
  light: number;
  glow: number;
  /** 날씨 움직임 시계(초) */
  t: number;
  /** 커튼: 0 닫힘 ~ 1 열림 */
  open: number;
  dark: boolean;
  /** 거실(가로로 긴 창)이면 창살을 세로 하나로(두 칸) */
  wide: boolean;
}

/** 창틀 바깥 여백(커튼 봉·창턱·그림자). 캔버스는 창 칸보다 사방 PAD, 아래로 SILL 만큼 크다 */
export const WINDOW_PAD = 7;
export const WINDOW_SILL = 6;

/**
 * 창 하나를 그린다. (0,0) = 창 칸 왼쪽 위에서 PAD 만큼 바깥, 창 칸은 (PAD,PAD) 에서 w×h.
 * view: 창 여럿이 한 풍경을 나눠 볼 때 이 창이 보는 자리(풍경 왼쪽에서 x, 풍경 폭 w). 없으면 이 창이 풍경 전부
 */
export function drawWindow(g: CanvasRenderingContext2D, w: number, h: number, st: WindowState, view?: { x: number; w: number }) {
  const F = Math.max(4, Math.round(Math.min(w, h) * 0.08)), pw = w - 2 * F, ph = h - 2 * F;
  const frame = st.dark ? mix(P.white, INK, 0.62) : mix(P.white, WHITE, 0.2);
  g.save();
  g.translate(WINDOW_PAD, WINDOW_PAD);

  // 틀(옅은 그림자로 벽에서 띄운다 — 고양이·선물과 같은 가장자리)
  g.save(); g.shadowColor = st.dark ? "rgba(0,0,0,0.4)" : "rgba(40,28,48,0.28)"; g.shadowBlur = 3; g.shadowOffsetY = 1;
  g.fillStyle = shade(g, frame, 0, h); rrect(g, 0, 0, w, h, F * 0.7); g.fill();
  g.restore();

  // 유리 안 풍경
  g.save();
  rrect(g, F, F, pw, ph, F * 0.35); g.clip(); g.translate(F, F);
  const vw = view ? view.w : pw;
  g.save(); if (view) g.translate(-view.x, 0);
  if (st.prev && st.fade < 1) scene(g, vw, ph, st.prev, st.light, st.glow, st.t);
  if (st.prev && st.fade < 1) g.globalAlpha = st.fade;
  scene(g, vw, ph, st.kind, st.light, st.glow, st.t);
  g.globalAlpha = 1;
  g.restore();
  // 다크 테마에선 창밖을 살짝 눌러 밝은 낮 하늘이 눈을 찌르지 않게
  if (st.dark) { g.fillStyle = css(INK, 0.18); g.fillRect(0, 0, pw, ph); }
  // 유리 반짝임(왼쪽 위 짧게)
  const gl = Math.min(pw, ph) * 0.22;
  g.strokeStyle = css(WHITE, 0.22); g.lineWidth = Math.max(1.5, F * 0.35); g.lineCap = "round";
  g.beginPath(); g.moveTo(gl * 0.4, gl * 1.3); g.lineTo(gl * 1.3, gl * 0.4); g.stroke();
  g.restore();

  // 창살: 세로 창은 십자, 가로 창은 세 칸
  const bar = Math.max(2, Math.round(F * 0.5));
  g.fillStyle = shade(g, frame, 0, h);
  if (st.wide) g.fillRect(Math.round(w / 2 - bar / 2), F, bar, ph);
  else { g.fillRect(Math.round(w / 2 - bar / 2), F, bar, ph); g.fillRect(F, Math.round(F + ph * 0.42 - bar / 2), pw, bar); }

  // 창턱
  g.fillStyle = shade(g, mix(frame, INK, 0.08), h - F * 0.4, h + WINDOW_SILL);
  rrect(g, -WINDOW_PAD + 2, h - F * 0.4, w + 2 * WINDOW_PAD - 4, WINDOW_SILL + F * 0.4, 2); g.fill();

  // 커튼: 봉에서 양쪽으로. 닫히면 창을 다 덮고, 열리면 양 끝에 모인다
  const curtain = st.dark ? mix(P.pink, INK, 0.45) : mix(P.pink, WHITE, 0.25), e = st.open * st.open * (3 - 2 * st.open);
  const half = w / 2 + WINDOW_PAD - 2, gathered = Math.min(half * 0.22, Math.max(8, h * 0.28));
  const cw = half * (1 - e) + gathered * e, top = -WINDOW_PAD + 4, bottom = h + 1;
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -WINDOW_PAD + 2 : w + WINDOW_PAD - 2 - cw;
    // 열린 커튼은 아래가 안쪽으로 묶여 좁다
    const inset = cw * 0.35 * e, folds = Math.max(2, Math.round(cw / 6));
    g.beginPath();
    if (side < 0) { g.moveTo(x0, top); g.lineTo(x0 + cw, top); g.quadraticCurveTo(x0 + cw - inset * 1.4, h * 0.6, x0 + cw - inset, bottom); g.lineTo(x0, bottom); }
    else { g.moveTo(x0 + cw, top); g.lineTo(x0, top); g.quadraticCurveTo(x0 + inset * 1.4, h * 0.6, x0 + inset, bottom); g.lineTo(x0 + cw, bottom); }
    g.closePath();
    const fg = g.createLinearGradient(x0, 0, x0 + cw, 0);
    for (let i = 0; i <= folds; i++) fg.addColorStop(i / folds, css(i % 2 ? mix(curtain, INK, 0.14) : mix(curtain, WHITE, 0.18)));
    g.fillStyle = fg; g.fill();
  }
  // 커튼 봉
  g.fillStyle = shade(g, st.dark ? mix(P.brown, INK, 0.3) : P.brown, top - 2, top + 2);
  rrect(g, -WINDOW_PAD + 1, top - 2, w + 2 * WINDOW_PAD - 2, 3, 1.5); g.fill();
  g.restore();
}
