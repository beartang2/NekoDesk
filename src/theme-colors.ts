// ── HSL helpers ───────────────────────────────────────────────────────────────

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = d / (l > 0.5 ? 2 - max - min : max + min);
  let h = 0;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    case b: h = ((r - g) / d + 4) / 6; break;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${h} ${Math.round(s)}% ${Math.round(l)}%)`;
}

// ── Accent derivation ─────────────────────────────────────────────────────────
// 사용자가 선택한 hex를 그대로 --accent로 사용 (명도 최소 보정).
// dim · hover는 같은 색상 계열에서 명도/채도만 조정해 자동 파생.

export function deriveAccent(accentHex: string, isDark: boolean) {
  const [h, s, l] = hexToHsl(accentHex);

  if (isDark) {
    const aL = Math.max(62, l); // 어두운 배경에서 충분히 밝게
    return {
      accent:      hsl(h, s,        aL),
      accentDim:   hsl(h, s * 0.48, Math.max(14, aL * 0.34)),
      accentHover: hsl(h, s * 0.58, Math.max(24, aL * 0.50)),
    };
  } else {
    const aL = Math.min(50, l); // 밝은 배경에서 충분히 어둡게
    return {
      accent:      hsl(h, s,        aL),
      accentDim:   hsl(h, s * 0.70, Math.min(95, 100 - (100 - aL) * 0.18)),
      accentHover: hsl(h, s * 0.62, Math.min(88, 100 - (100 - aL) * 0.30)),
    };
  }
}

// ── Storage ───────────────────────────────────────────────────────────────────

const ACCENT_HEX_KEY = "nekodesk_accent_hex";
const ACCENT_HUE_KEY = "nekodesk_accent_hue"; // 구버전 마이그레이션용
const DEFAULT_ACCENT  = "#a78bfa";

/** 구버전 hue → 대표 hex 변환 (S=0.8, L=0.6 고정) */
function legacyHueToHex(hue: number): string {
  const s = 0.8, l = 0.6;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function getStoredAccent(): string {
  const hex = localStorage.getItem(ACCENT_HEX_KEY);
  if (hex) return hex;
  // 구버전 호환: hue → hex 변환
  const hue = localStorage.getItem(ACCENT_HUE_KEY);
  if (hue) return legacyHueToHex(parseInt(hue, 10));
  return DEFAULT_ACCENT;
}

export function saveAccentHex(hex: string) {
  if (hex.toLowerCase() === DEFAULT_ACCENT) {
    localStorage.removeItem(ACCENT_HEX_KEY);
  } else {
    localStorage.setItem(ACCENT_HEX_KEY, hex);
  }
  localStorage.removeItem(ACCENT_HUE_KEY); // 구버전 키 제거
}

// ── Apply ─────────────────────────────────────────────────────────────────────

export function applyThemeColors(isDark: boolean) {
  const hex = getStoredAccent();
  const { accent, accentDim, accentHover } = deriveAccent(hex, isDark);
  document.documentElement.style.setProperty("--accent",       accent);
  document.documentElement.style.setProperty("--accent-dim",   accentDim);
  document.documentElement.style.setProperty("--accent-hover", accentHover);
}
