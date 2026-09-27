import { addDays, format } from "date-fns";
import { normalizeDateInput, parseKoreanDate } from "../src/agent/korean-date";
import {
  codeHas,
  codeLacks,
  custom,
  language,
  noOsascriptWrapper,
  noPythonSyntax,
  param,
  paramEquals,
  type Check,
  type EvalCase,
} from "./scoring";

/**
 * 평가 케이스. 기대 동작은 시스템 프롬프트 규칙과 src/agent/knowledge 문서를 기준으로 한다.
 * 규칙을 바꾸면 여기 기대값도 같이 바꿔야 한다.
 */

// ── 공통 체크 묶음 ──────────────────────────────────────────────────────────────

const appleScript: Check[] = [language("applescript"), noPythonSyntax, noOsascriptWrapper];

/** knowledge/applescript/music.md "네코 전용 플레이리스트 편집" 규칙. */
const nekoPlaylist: Check[] = [
  ...appleScript,
  codeHas("\"Neko's Playlist\" 대상", /Neko's Playlist/),
  codeHas("곡 추가는 duplicate", /\bduplicate\b/),
  codeLacks("존재하지 않는 add ... to playlist 문법 없음", /\badd\b[^\n]*\bto\s+(user\s+)?playlist/i),
  custom("다른 이름의 플레이리스트를 새로 만들지 않음", (s) => {
    const src = String(s.params["code"] ?? "");
    const makes = [...src.matchAll(/make new (?:user )?playlist with properties \{name:([^}]+)\}/g)];
    return makes.every((m) => /plName|Neko's Playlist/.test(m[1]));
  }),
];

/** knowledge/applescript/music.md "노래 추천 후 재생" 규칙. */
const playMusic: Check[] = [
  ...appleScript,
  codeHas("Music 앱 대상", /tell application "Music"/),
  codeHas("재생 명령", /\bplay\b/),
  codeLacks("display dialog 사용 안 함", /display dialog/),
];

/** 규칙 25: URL·최신 정보는 기억으로 답하지 않는다. 규칙 10: 영어 검색어 우선. */
function news(topic: RegExp): Check[] {
  return [
    param("주제가 검색어에 들어감", "query", topic),
    custom("영어 검색어 (규칙 10, 참고용)", (s) => /^[\x00-\x7F]+$/.test(String(s.params["query"] ?? "")), false),
  ];
}

// ── 날짜 기대값 (실행 시각 기준) ────────────────────────────────────────────────

const now = new Date();
const tomorrow = format(addDays(now, 1), "yyyy-MM-dd");
const nextTuesday = parseKoreanDate("다음 주 화요일", now)!.iso;

/** 모델이 준 날짜를 앱과 똑같이 정규화한 뒤 비교한다. */
function startsOn(date: string, time?: string): Check {
  return custom(`start_at → ${date}${time ? ` ${time}` : ""}`, (s) => {
    const iso = normalizeDateInput(String(s.params["start_at"] ?? ""), now);
    return iso.startsWith(time ? `${date}T${time}` : date);
  });
}

// ── 케이스 ──────────────────────────────────────────────────────────────────────

export const CASES: EvalCase[] = [
  // 음악: 플레이리스트
  {
    id: "music-playlist-vague",
    category: "음악",
    input: "플레이리스트 만들어줘",
    accept: [
      { tool: "code.exec", checks: nekoPlaylist },
      // 규칙 13②: 취향이 불명확한 추천·창작은 먼저 물어봐도 된다.
      { tool: "user.ask" },
    ],
  },
  {
    id: "music-playlist-mood",
    category: "음악",
    input: "비 오는 날 듣기 좋은 노래로 플레이리스트 만들어줘",
    accept: [{ tool: "code.exec", checks: nekoPlaylist }],
  },
  {
    id: "music-playlist-artist",
    category: "음악",
    input: "요루시카 노래로 플레이리스트 만들어줘",
    accept: [{
      tool: "code.exec",
      // 규칙 15: 한국어 아티스트명은 로마자로 먼저 검색한다.
      checks: [...nekoPlaylist, codeHas("로마자 아티스트명", /Yorushika/i)],
    }],
  },
  {
    id: "music-playlist-add",
    category: "음악",
    input: "플레이리스트에 신나는 노래 좀 더 넣어줘",
    accept: [{ tool: "code.exec", checks: nekoPlaylist }],
  },

  // 음악: 재생
  {
    id: "music-play-favorite",
    category: "음악",
    input: "좋아하는 노래 틀어줘",
    accept: [
      { tool: "code.exec", checks: playMusic },
      { tool: "user.ask" },
    ],
    note: "라이브러리 곡을 바로 틀면 통과. 취향을 물어보는 것도 허용.",
  },
  {
    id: "music-play-artist",
    category: "음악",
    input: "요네즈 켄시 노래 틀어줘",
    accept: [{
      tool: "code.exec",
      checks: [...playMusic, codeHas("로마자 아티스트명", /yonezu|kenshi|米津/i)],
    }],
  },
  {
    id: "music-play-generic",
    category: "음악",
    input: "노래 좀 틀어줘",
    accept: [
      { tool: "code.exec", checks: playMusic },
      { tool: "user.ask" },
    ],
  },
  {
    id: "music-pause",
    category: "음악",
    input: "노래 잠깐 멈춰줘",
    accept: [{ tool: "code.exec", checks: [...appleScript, codeHas("일시정지", /\bpause\b|playpause/)] }],
  },
  {
    id: "music-now-playing",
    category: "음악",
    input: "지금 나오는 노래 뭐야?",
    accept: [{ tool: "code.exec", checks: [...appleScript, codeHas("현재 곡 조회", /current track/)] }],
  },

  // 뉴스
  {
    id: "news-security-today",
    category: "뉴스",
    input: "오늘 보안 뉴스 알려줘",
    accept: [{ tool: "web.search", checks: news(/security|cyber|보안|vulnerab|CVE|hack|breach/i) }],
  },
  {
    id: "news-security-issue",
    category: "뉴스",
    input: "요즘 보안 이슈 뭐 있어?",
    accept: [{ tool: "web.search", checks: news(/security|cyber|보안|vulnerab|CVE|hack|breach/i) }],
  },
  {
    id: "news-tech-latest",
    category: "뉴스",
    input: "최신 테크 뉴스 알려줘",
    accept: [{ tool: "web.search", checks: news(/tech|테크|기술|AI|IT\b/i) }],
  },
  {
    id: "news-ai",
    category: "뉴스",
    input: "AI 관련 최신 소식 있어?",
    accept: [{ tool: "web.search", checks: news(/\bAI\b|artificial intelligence|인공지능|LLM/i) }],
  },
  {
    id: "news-site-headline",
    category: "뉴스",
    input: "보안뉴스 사이트 헤드라인 가져와줘",
    // 규칙 9·25: URL 을 지어내지 말고 검색부터.
    accept: [{ tool: "web.search" }],
  },

  // 회귀 확인: 할 일·일정
  {
    id: "todo-add",
    category: "할 일·일정",
    input: "내일까지 보고서 제출하는 거 할 일에 추가해줘",
    accept: [{ tool: "todo.add", checks: [param("내용에 보고서", "content", /보고서/)] }],
  },
  {
    id: "todo-list",
    category: "할 일·일정",
    input: "할 일 뭐 남았어?",
    accept: [{ tool: "todo.list" }],
  },
  {
    id: "schedule-add-tomorrow",
    category: "할 일·일정",
    input: "내일 오후 3시에 팀 회의 잡아줘",
    accept: [{ tool: "schedule.add", checks: [param("제목에 회의", "title", /회의/), startsOn(tomorrow, "15:00")] }],
  },
  {
    id: "schedule-add-relative",
    category: "할 일·일정",
    input: "다음 주 화요일에 치과 예약 있어",
    accept: [{ tool: "schedule.add", checks: [param("제목에 치과", "title", /치과/), startsOn(nextTuesday)] }],
  },
  {
    id: "schedule-list-week",
    category: "할 일·일정",
    input: "이번 주 일정 알려줘",
    accept: [{ tool: "schedule.list", checks: [paramEquals("range", "week")] }],
  },

  // 회귀 확인: 기타 도구
  {
    id: "math",
    category: "기타",
    input: "1234 곱하기 56은 얼마야?",
    accept: [{ tool: "math.eval" }],
  },
  {
    id: "weather",
    category: "기타",
    input: "오늘 서울 날씨 어때?",
    accept: [{ tool: "weather.get", checks: [param("지역", "location", /서울|seoul/i)] }],
  },
  {
    id: "clipboard",
    category: "기타",
    input: "방금 복사한 거 요약해줘",
    accept: [{ tool: "clipboard", checks: [paramEquals("action", "read")] }],
  },
  {
    id: "file-list",
    category: "기타",
    input: "다운로드 폴더에 뭐 있어?",
    accept: [{ tool: "file", checks: [paramEquals("action", "list"), param("다운로드 경로", "path", /Downloads/)] }],
  },

  // 도구가 필요 없는 대화
  {
    id: "chat-greeting",
    category: "대화",
    input: "안녕 네코!",
    accept: [{ tool: "none", checks: [custom("답변 있음", (s) => Boolean(s.finalAnswer?.trim()))] }],
  },
  {
    id: "chat-capabilities",
    category: "대화",
    input: "너 뭐 할 수 있어?",
    accept: [{ tool: "none", checks: [custom("답변 있음", (s) => Boolean(s.finalAnswer?.trim()))] }],
  },
];
