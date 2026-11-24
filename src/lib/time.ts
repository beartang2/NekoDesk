/**
 * 시각은 날씨 위치의 시간대로 보인다. 날씨 배지(App 의 WeatherBadge)가 받아 온 시간대를
 * 여기 적고, 다음에 켤 때 첫 화면부터 쓰도록 남겨 둔다. 모르면(날씨를 비움) 맥의 시간대.
 */
const ZONE_KEY = "nekodesk_weather_tz";
let zone: string | undefined = localStorage.getItem(ZONE_KEY) || undefined;

export function setTimeZone(tz: string | undefined) {
  zone = tz || undefined;
  if (zone) localStorage.setItem(ZONE_KEY, zone);
  else localStorage.removeItem(ZONE_KEY);
}

export function timeZone(): string | undefined {
  return zone;
}

/**
 * DB 시각. SQLite 의 datetime('now') 는 UTC 를 "2026-10-30 04:11:00" 처럼 시간대 표시 없이
 * 준다. 그대로 new Date 에 넣으면 로컬 시각으로 읽혀 한국에선 9시간 밀렸다.
 */
export function parseDbTime(s: string): Date {
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/i.test(s);
  return new Date(hasZone ? s : `${s.replace(" ", "T")}Z`);
}

/** "오후 01:11" */
export function clock(d: Date = new Date()): string {
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: zone });
}

/** "2026-10-30" — DB 시각의 날짜만. 할 일 완료일처럼. (en-CA 가 YYYY-MM-DD 로 찍는다) */
export function dbDate(s: string): string {
  return parseDbTime(s).toLocaleDateString("en-CA", { timeZone: zone });
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
const DAY_MS = 86_400_000;
/** "YYYY-MM-DD" 의 요일(달력 날짜 그대로 — 시간대로 옮기지 않는다) */
const weekdayOf = (ymd: string) => WEEKDAY[new Date(`${ymd}T00:00:00Z`).getUTCDay()];

/**
 * 지금 날짜·요일·시각과 시간대(날씨 위치 — 모르면 이 기기). time.now 도구(0.1.32, 사용자: 메시지마다 시각을 붙이지 말고 필요할 때
 * 네코가 확인하게)
 */
export function nowInZone(now: Date = new Date()): { date: string; weekday: string; time: string; zone: string } {
  const tz = zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = now.toLocaleDateString("en-CA", { timeZone: tz });
  const time = now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  return { date, weekday: weekdayOf(date), time, zone: tz };
}

/**
 * 일정·할 일에 적은 날짜(ISO — 날짜만이거나 시각까지) → "2026-11-25(수) 14:00, 내일". 오늘(앱 시간대) 기준 말을 붙여, 모델이 날짜를
 * 잘못 셌으면 도구 결과에서 바로 드러나게 한다. 날짜를 못 읽으면 받은 글 그대로
 */
export function dayWithRel(iso: string, now: Date = new Date()): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(iso.trim());
  if (!m) return iso;
  const d = Math.round((Date.parse(`${m[1]}T00:00:00Z`) - Date.parse(`${nowInZone(now).date}T00:00:00Z`)) / DAY_MS);
  const rel = d === 0 ? "오늘" : d === 1 ? "내일" : d === 2 ? "모레" : d === -1 ? "어제" : d > 0 ? `${d}일 뒤` : `${-d}일 전`;
  return `${m[1]}(${weekdayOf(m[1])})${m[2] ? ` ${m[2]}` : ""}, ${rel}`;
}
