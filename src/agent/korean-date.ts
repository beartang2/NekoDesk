import {
  addDays,
  addMonths,
  addWeeks,
  endOfMonth,
  format,
  setDate,
  startOfWeek,
} from "date-fns";

/**
 * 한국어 상대 날짜 표현을 ISO 문자열로 바꾼다.
 *
 * 왜 직접 만드는가: JS 표준 자연어 날짜 파서인 chrono-node 는 한국어를 지원하지
 * 않는다(en/fr/it/ja/nl/ru/uk/vi 등만 지원). 그래서 4B급 로컬 모델이 "다음 주
 * 화요일" 같은 표현을 ISO 로 바꾸는 계산을 직접 하게 되는데, 여기서 자주 틀린다.
 * 규칙이 좁으므로 결정론적으로 처리해서 모델의 산수를 신뢰하지 않는다.
 *
 * 모델이 이미 올바른 ISO 를 준 경우엔 그대로 통과시키고(= 이 함수를 안 부르거나
 * null 을 받음), 상대 표현이 그대로 넘어온 경우에만 교정한다.
 */

/** 시각이 포함된 결과인지까지 알려준다. 종일 일정과 시간 일정을 구분해야 하기 때문. */
export interface ParsedKoreanDate {
  /** "YYYY-MM-DD" 또는 "YYYY-MM-DDTHH:mm:ss" */
  iso: string;
  hasTime: boolean;
}

const WEEKDAYS: Record<string, number> = {
  일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6,
};

/** 이미 ISO 8601(날짜 또는 날짜+시각)인가. */
export function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?/.test(value.trim());
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toResult(date: Date, hour: number | null, minute: number): ParsedKoreanDate {
  const datePart = format(date, "yyyy-MM-dd");
  if (hour === null) return { iso: datePart, hasTime: false };
  return { iso: `${datePart}T${pad(hour)}:${pad(minute)}:00`, hasTime: true };
}

/**
 * "오후 3시 30분", "새벽 2시", "정오" 등에서 시/분을 뽑는다.
 * 시각 표현이 없으면 null.
 */
function parseTime(text: string): { hour: number; minute: number } | null {
  if (/정오/.test(text)) return { hour: 12, minute: 0 };
  if (/자정/.test(text)) return { hour: 0, minute: 0 };

  // "15:30", "15시 30분", "3시"
  const hm = text.match(/(\d{1,2})\s*(?::|시)\s*(\d{1,2})?\s*분?/);
  if (!hm) return null;

  let hour = Number(hm[1]);
  const minute = hm[2] ? Number(hm[2]) : 0;
  if (hour > 23 || minute > 59) return null;

  // 오전/오후 보정. "저녁 7시" → 19시, "새벽 2시" → 2시
  const isAfternoon = /오후|저녁|밤/.test(text);
  const isMorning = /오전|아침|새벽/.test(text);
  if (isAfternoon && hour < 12) hour += 12;
  if (isMorning && hour === 12) hour = 0;

  return { hour, minute };
}

/**
 * 한국어 날짜 표현을 파싱한다. 해석 불가면 null.
 *
 * @param text  "내일 오후 3시", "다음 주 화요일", "3월 2일" 등
 * @param now   기준 시각 (테스트를 위해 주입 가능)
 */
export function parseKoreanDate(text: string, now: Date = new Date()): ParsedKoreanDate | null {
  const s = text.trim();
  if (!s) return null;

  const time = parseTime(s);
  const hour = time?.hour ?? null;
  const minute = time?.minute ?? 0;

  // ── 절대 표기 우선 ──────────────────────────────────────────────────────────

  // "2026-03-02" / "2026/3/2"
  const ymd = s.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    if (!isNaN(d.getTime())) return toResult(d, hour, minute);
  }

  // "3월 2일" — 이미 지난 날짜면 내년으로 넘긴다
  const md = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (md) {
    const month = Number(md[1]) - 1;
    const day = Number(md[2]);
    let d = new Date(now.getFullYear(), month, day);
    if (!isNaN(d.getTime())) {
      if (d.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) {
        d = new Date(now.getFullYear() + 1, month, day);
      }
      return toResult(d, hour, minute);
    }
  }

  // ── 상대 표기 ───────────────────────────────────────────────────────────────

  if (/그저께|그제/.test(s)) return toResult(addDays(now, -2), hour, minute);
  if (/어제/.test(s)) return toResult(addDays(now, -1), hour, minute);
  if (/오늘|금일/.test(s)) return toResult(now, hour, minute);
  if (/내일|낼/.test(s)) return toResult(addDays(now, 1), hour, minute);
  if (/모레/.test(s)) return toResult(addDays(now, 2), hour, minute);
  if (/글피/.test(s)) return toResult(addDays(now, 3), hour, minute);

  // "3일 후", "2주 뒤", "1개월 후"
  const rel = s.match(/(\d{1,3})\s*(일|주|주일|개월|달)\s*(?:후|뒤|이따|있다가)/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2];
    if (unit === "일") return toResult(addDays(now, n), hour, minute);
    if (unit === "주" || unit === "주일") return toResult(addWeeks(now, n), hour, minute);
    return toResult(addMonths(now, n), hour, minute);
  }

  // "다음 주 화요일", "이번 주 금요일", "다다음 주 월요일"
  const weekday = s.match(/([일월화수목금토])\s*요일/);
  if (weekday) {
    const target = WEEKDAYS[weekday[1]]!;
    let weekOffset = 0;
    if (/다다음\s*주/.test(s)) weekOffset = 2;
    else if (/다음\s*주|담주/.test(s)) weekOffset = 1;
    else if (/지난\s*주|저번\s*주/.test(s)) weekOffset = -1;

    // 주 시작을 일요일로 맞춘 뒤 목표 요일로 이동
    const base = startOfWeek(addWeeks(now, weekOffset), { weekStartsOn: 0 });
    let d = addDays(base, target);

    // "이번 주 X요일"인데 이미 지났으면 다음 주로 넘기지 않는다(사용자가 과거를
    // 지목했을 수 있음). 다만 주 지정어가 아예 없으면 가장 가까운 미래로 본다.
    const hasWeekWord = /주/.test(s);
    if (!hasWeekWord && d.getTime() < now.getTime()) d = addDays(d, 7);
    return toResult(d, hour, minute);
  }

  // "이번 달 말", "다음 달 15일"
  const monthWord = s.match(/(이번|다음|담)\s*달/);
  if (monthWord) {
    const offset = monthWord[1] === "이번" ? 0 : 1;
    const base = addMonths(now, offset);
    if (/말/.test(s)) return toResult(endOfMonth(base), hour, minute);
    const dayInMonth = s.match(/(\d{1,2})\s*일/);
    if (dayInMonth) return toResult(setDate(base, Number(dayInMonth[1])), hour, minute);
    return toResult(base, hour, minute);
  }

  // 날짜 단서 없이 시각만 있으면 오늘로 본다. 단, 이미 지난 시각이면 내일.
  if (hour !== null) {
    const todayAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    const d = todayAt.getTime() < now.getTime() ? addDays(todayAt, 1) : todayAt;
    return toResult(d, hour, minute);
  }

  return null;
}

/**
 * 도구가 받은 날짜 문자열을 정규화한다.
 *
 * 이미 ISO 면 그대로 두고, 한국어 상대 표현이면 계산해서 ISO 로 바꾼다.
 * 어느 쪽도 아니면 원본을 그대로 돌려준다(도구 쪽 검증에 맡긴다).
 */
export function normalizeDateInput(value: string, now: Date = new Date()): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (isIsoDateString(trimmed)) return trimmed;

  const parsed = parseKoreanDate(trimmed, now);
  return parsed ? parsed.iso : trimmed;
}
