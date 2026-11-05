/**
 * Claude(Anthropic)로 나가기 전에 거르는 것들.
 *
 * - 비밀(API 키·개인 키·비밀번호 대입)은 묻지 않고 가린다. 모델이 값 자체를 알아야 할 일이
 *   거의 없고, 툴 결과에 섞여 사용자가 모르는 새 나가는 게 대부분이다.
 * - 개인정보(주민등록번호·카드번호)와 메일·메시지·연락처·메모에서 읽은 결과는 사용자에게 묻는다.
 *   필요해서 보내는 경우가 있어 일괄로 가리면 일을 못 한다.
 *
 * 가리는 결과는 입력이 같으면 늘 같다 — Claude 프롬프트 캐시가 앞쪽이 안 바뀌는 데 기댄다.
 */

const HIDDEN = (what: string) => `‹${what} 가림›`;

/** [패턴, 무엇]. 순서대로 바꾼다 — 개인 키 블록처럼 긴 것 먼저. */
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "개인 키"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "API 키"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "API 키"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS 키"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "GitHub 토큰"],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/g, "GitHub 토큰"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "Slack 토큰"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "Google 키"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, "토큰"],
];

/** `.env`·설정 파일의 대입(`DB_PASSWORD=x`, `"api_key": "x"`). 이름은 두고 값만 가린다. */
const ASSIGNMENTS: RegExp[] = [
  /\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g,
  /("(?:password|passwd|secret|token|api_?key|access_?key)"\s*:\s*)"[^"\n]*"/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, what] of SECRETS) out = out.replace(re, HIDDEN(what));
  for (const re of ASSIGNMENTS) out = out.replace(re, (_m, name: string) => `${name}${HIDDEN("값")}`);
  return out;
}

// ── 개인정보 ──────────────────────────────────────────────────────────────────

const RRN = /\b(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(-?)([1-8])(\d{6})\b/g;
const CARD = /\b[3-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{1,7}\b/g;

/** 붙여 쓴 13자리는 검증 숫자가 맞을 때만 주민등록번호로 친다(2020-10 이후 번호는 안 맞아 하이픈이 있어야 잡힌다). */
function rrnChecksumOk(digits: string): boolean {
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = w.reduce((s, x, i) => s + x * +digits[i], 0);
  return (11 - (sum % 11)) % 10 === +digits[12];
}

function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function isRrn(m: RegExpMatchArray): boolean {
  return m[4] === "-" || rrnChecksumOk(m[0].replace("-", ""));
}

function isCard(raw: string): boolean {
  const digits = raw.replace(/[ -]/g, "");
  return digits.length >= 13 && digits.length <= 19 && luhnOk(digits);
}

/** 찾은 개인정보 종류별 개수. 없으면 빈 배열. */
export function findPersonal(text: string): string[] {
  const rrn = [...text.matchAll(RRN)].filter(isRrn).length;
  const card = [...text.matchAll(CARD)].filter((m) => isCard(m[0])).length;
  return [rrn && `주민등록번호처럼 보이는 값 ${rrn}개`, card && `카드번호처럼 보이는 값 ${card}개`].filter(
    (s): s is string => !!s,
  );
}

export function maskPersonal(text: string): string {
  return text
    .replace(RRN, (...a) => (isRrn(a as unknown as RegExpMatchArray) ? HIDDEN("주민등록번호") : a[0]))
    .replace(CARD, (m) => (isCard(m) ? HIDDEN("카드번호") : m));
}

// ── 민감한 출처 ───────────────────────────────────────────────────────────────

const PRIVATE_APPS: Record<string, string> = { Mail: "메일", Messages: "메시지", Contacts: "연락처", Notes: "메모" };

/** 이 호출이 사적인 앱의 내용을 읽었나(AppleScript 로 메일·메시지·연락처·메모를 열었나). */
export function privateSource(name: string, params: Record<string, unknown>): string | null {
  if (name !== "code.exec" || params["language"] !== "applescript") return null;
  const m = /tell\s+application\s+"(Mail|Messages|Contacts|Notes)"/.exec(String(params["code"] ?? ""));
  return m ? PRIVATE_APPS[m[1]] : null;
}

/** 사용자에게 물어야 할 것. 없으면 null. */
export interface OutboundConcern {
  /** "세션 동안"·"항상" 을 고르면 저장될 규칙. */
  ruleKey: string;
  /** 확인 창 본문. */
  preview: string;
  /** 거부했을 때 모델에게 대신 줄 결과. */
  withheld: string;
}

export function outboundConcern(name: string, params: Record<string, unknown>, summary: string): OutboundConcern | null {
  const source = privateSource(name, params);
  if (source) {
    return {
      ruleKey: `outbound:${source}`,
      preview: `${source} 내용을 Claude(Anthropic)로 보내려고 해.\n거부하면 이 결과는 보내지 않아.`,
      withheld: `사용자가 이 ${source} 내용을 Claude 로 보내지 않기로 했어. 내용 없이 할 수 있는 만큼만 하고, 안 되면 그렇다고 말해.`,
    };
  }
  const found = findPersonal(summary);
  if (!found.length) return null;
  return {
    ruleKey: "outbound:개인정보",
    preview: `${name} 결과에 ${found.join(", ")}가 있어. Claude(Anthropic)로 그대로 보낼까?\n거부하면 그 값만 가리고 보내.`,
    withheld: maskPersonal(summary),
  };
}
