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
