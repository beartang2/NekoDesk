/**
 * ⌃⇧N 에서 고른 글이 인코딩된 모양이면 바로 풀어 보여 준다. 모델 없이 — 틀릴 일이 없고 즉시다.
 *
 * 아무 글이나 푸는 척하면 안 된다. "Hello123" 도 base64 글자로만 돼 있다. 풀었을 때 읽을 수 있는
 * 글(UTF-8, 제어 문자 없음)이 나올 때만, 숫자는 그럴듯한 날짜(2001~2100년)일 때만 보여 준다.
 *
 * 고른 글은 끝이 잘려 있거나(`…%F`, 바이트 반쪽) 중간에 딴 글자가 끼어 있기 일쑤다. 그렇다고 통째로
 * 포기하면 사용자는 번역 버튼을 누르고, 모델은 못 읽는 글을 지어내 번역한다. 풀리는 데까지 푼다.
 */

export interface Decoded {
  kind: "JWT" | "Unix 시간" | "JSON" | "URL" | "Base64" | "16진수";
  text: string;
}

const MIN_YEAR_S = 978307200; // 2001-01-01
const MAX_YEAR_S = 4102444800; // 2100-01-01

export function decode(input: string): Decoded | null {
  const s = input.trim();
  if (!s || s.length > 100_000) return null;
  return jwt(s) ?? unixTime(s) ?? json(s) ?? url(s) ?? hex(s) ?? base64(s);
}

function jwt(s: string): Decoded | null {
  if (!/^[\w-]+\.[\w-]+\.[\w-]*$/.test(s)) return null;
  const [head, body] = s.split(".");
  const header = parseJson(base64Text(head));
  const payload = parseJson(base64Text(body));
  if (!header || typeof header !== "object" || !("alg" in header) || !payload) return null;
  const lines = [`header ${pretty(header)}`, `payload ${pretty(payload)}`];
  // 만료·발급 시각은 숫자로만 오니 읽을 수 있게 붙인다.
  for (const key of ["iat", "nbf", "exp"] as const) {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === "number") lines.push(`${key}: ${when(v * 1000)}`);
  }
  lines.push("서명은 확인하지 않았어.");
  return { kind: "JWT", text: lines.join("\n") };
}

function unixTime(s: string): Decoded | null {
  if (!/^\d{10}(\d{3})?$/.test(s)) return null;
  const ms = s.length === 13 ? Number(s) : Number(s) * 1000;
  if (ms < MIN_YEAR_S * 1000 || ms > MAX_YEAR_S * 1000) return null;
  return { kind: "Unix 시간", text: when(ms) };
}

/** 이미 줄 바꿈된 JSON 은 풀 게 없다. 한 줄로 뭉친 것만. */
function json(s: string): Decoded | null {
  if (!/^[[{]/.test(s) || s.includes("\n")) return null;
  const v = parseJson(s);
  return v && typeof v === "object" ? { kind: "JSON", text: pretty(v) } : null;
}

/** %XX 가 이어진 덩이마다 푼다. 끝이 잘린 `%F` 나 깨진 덩이는 그대로 둔다. */
function url(s: string): Decoded | null {
  if (!/%[0-9A-Fa-f]{2}/.test(s)) return null;
  const text = s
    .replace(/\+/g, " ")
    .replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => utf8(run.slice(1).split("%").map((h) => parseInt(h, 16))) ?? run);
  return text !== s ? { kind: "URL", text } : null;
}

/**
 * "48 65 6c" · "48:65:6c" · "48656c". 이어 쓴 건 a~f 가 하나는 있어야 한다 — "41424344" 같은 숫자를
 * 글자(ABCD)로 풀지 않게.
 */
function hex(s: string): Decoded | null {
  const spaced = /^[0-9a-fA-F]{2}(?:[\s:]+[0-9a-fA-F]{2})+$/.test(s);
  const bare = s.replace(/^0x/, "");
  const packed = /^[0-9a-fA-F]{8,}$/.test(bare) && /[a-fA-F]/.test(bare) && bare.length % 2 === 0;
  if (!spaced && !packed) return null;
  const pairs = spaced ? s.split(/[\s:]+/) : (bare.match(/../g) ?? []);
  if (pairs.length < 4) return null;
  const text = utf8(pairs.map((h) => parseInt(h, 16)));
  return text ? { kind: "16진수", text } : null;
}

/** 통째로, 안 되면 딴 글자(공백·이모지 등)로 끊긴 조각마다. 조각이 하나라도 안 풀리면 base64 가 아니다. */
function base64(s: string): Decoded | null {
  if (s.length < 12) return null;
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const text = base64Text(s);
    if (!text) return null;
    const inner = parseJson(text);
    return { kind: "Base64", text: inner && typeof inner === "object" ? pretty(inner) : text };
  }
  // 나눈 조각: 짝수 자리는 base64 후보, 홀수 자리는 그 사이에 낀 글자.
  const parts = s.split(/([^A-Za-z0-9+/_=-]+)/u);
  if (!parts.some((p, i) => i % 2 === 0 && p.length >= 12)) return null;
  const decoded = parts.map((p, i) => (i % 2 === 1 || !p ? p : base64Text(p)));
  return decoded.every((d) => d !== null) ? { kind: "Base64", text: decoded.join("") } : null;
}

/** base64(·url-safe) 를 풀어 읽을 수 있는 글이면 돌려준다. */
function base64Text(s: string): string | null {
  try {
    const std = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    if (std.length % 4 === 1) return null;
    return utf8(Array.from(atob(std + "=".repeat((4 - (std.length % 4)) % 4)), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * 바이트가 읽을 수 있는 UTF-8 글이면 그 글. 끝에서 잘린 반쪽 글자는 버린다(stream) — 고른 글 끝이 잘려
 * 있기 일쑤라. 가운데가 깨졌거나, 줄 바꿈·탭 말고 제어 문자가 섞이면 글이 아니라 바이너리다.
 */
function utf8(bytes: number[]): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes), { stream: true });
    return text && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F�]/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function parseJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** "2026. 10. 19. (일) 오후 5:20:31 · 3일 전" */
function when(ms: number): string {
  const d = new Date(ms);
  const at = d.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "medium" });
  const day = d.toLocaleDateString("ko-KR", { weekday: "short" });
  return `${at} (${day}) · ${ago(ms - Date.now())}`;
}

function ago(diff: number): string {
  const past = diff < 0;
  const m = Math.round(Math.abs(diff) / 60000);
  const span = m < 1 ? "지금" : m < 60 ? `${m}분` : m < 1440 ? `${Math.round(m / 60)}시간` : `${Math.round(m / 1440)}일`;
  return span === "지금" ? span : `${span} ${past ? "전" : "뒤"}`;
}
