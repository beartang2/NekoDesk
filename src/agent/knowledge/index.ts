import { skillsApi } from "../../api/tauri";
import { estimateTokens } from "../token-estimate";
import systemKnowledge      from "./applescript/system.md?raw";
import musicKnowledge       from "./applescript/music.md?raw";
import finderKnowledge      from "./applescript/finder.md?raw";
import browserKnowledge     from "./applescript/browser.md?raw";
import uiKnowledge          from "./applescript/ui.md?raw";
import appsKnowledge        from "./applescript/apps.md?raw";
import mailCalendarKnowledge from "./applescript/mail-calendar.md?raw";
import messagesKnowledge     from "./applescript/messages.md?raw";

interface KnowledgeEntry {
  name: string;
  /** 한 줄 요약. 스킬 목록(프롬프트)에 이름 옆에 실린다 — 짧게. */
  description: string;
  content: string;
  keywords: string[];
}

const KNOWLEDGE_MAP: KnowledgeEntry[] = [
  {
    name: "AppleScript/시스템",
    description: "볼륨·밝기·다크모드·스크린샷·배터리·클립보드",
    content: systemKnowledge,
    keywords: [
      "볼륨", "소리", "음량", "volume", "mute", "음소거",
      "밝기", "brightness", "화면", "스크린",
      "다크모드", "dark mode", "라이트모드",
      "잠금", "절전", "sleep", "종료", "재시작", "shutdown", "restart",
      "스크린샷", "screenshot", "캡처",
      "알림", "notification",
      "배터리", "battery", "wifi", "wi-fi", "네트워크", "network",
      "클립보드", "clipboard", "복사", "붙여넣기",
      "ip", "cpu", "디스크", "메모리",
    ],
  },
  {
    name: "AppleScript/Music",
    description: "Music 앱 재생·플레이리스트·추천",
    content: musicKnowledge,
    keywords: [
      "음악", "music", "노래", "song", "track", "앨범", "album",
      "재생", "play", "일시정지", "pause", "다음곡", "이전곡",
      "셔플", "shuffle", "반복", "repeat",
      "플레이리스트", "playlist", "플리",
      "요루시카", "아티스트", "artist",
      "airplay",
      "틀어줘", "틀어", "들을래", "들을게", "들어볼게", "추천", "recommend",
      "lemon", "yonezu", "yorushika", "kenshi",
      "새로운 노래", "모르는 노래", "안 들어본", "미리듣기", "취향에 맞는",
    ],
  },
  {
    name: "AppleScript/Finder",
    description: "파일·폴더 복사·이동·삭제",
    content: finderKnowledge,
    keywords: [
      "파일", "file", "폴더", "folder", "디렉토리", "directory",
      "finder", "파인더",
      "복사", "copy", "이동", "move", "삭제", "delete",
      "휴지통", "trash",
      "경로", "path", "posix",
      "탐색", "탐색기",
    ],
  },
  {
    name: "AppleScript/브라우저",
    description: "Safari·Chrome 탭·URL·페이지",
    content: browserKnowledge,
    keywords: [
      "safari", "사파리", "chrome", "크롬", "firefox", "파이어폭스",
      "브라우저", "browser",
      "url", "탭", "tab", "창", "window",
      "웹", "web", "페이지", "page",
      "javascript", "js",
      "북마크", "bookmark",
    ],
  },
  {
    name: "AppleScript/UI자동화",
    description: "키보드·마우스·메뉴·대화상자 조작, TTS",
    content: uiKnowledge,
    keywords: [
      "키보드", "keyboard", "단축키", "shortcut", "keystroke",
      "마우스", "mouse", "클릭", "click",
      "버튼", "button", "메뉴", "menu",
      "대화상자", "dialog", "팝업", "popup",
      "tts", "말하기", "speech", "say",
      "입력", "타이핑", "typing",
      "ui 자동화", "automation",
    ],
  },
  {
    name: "AppleScript/앱제어",
    description: "앱 실행·종료·숨기기",
    content: appsKnowledge,
    keywords: [
      "앱", "app", "application", "어플",
      "실행", "launch", "open", "열기",
      "종료", "quit", "닫기", "close",
      "숨기기", "hide",
      "dock", "독",
      "프로세스", "process",
      "번들", "bundle",
    ],
  },
  {
    name: "AppleScript/메일·캘린더",
    description: "Mail·Calendar 읽기·쓰기",
    content: mailCalendarKnowledge,
    keywords: [
      "메일", "mail", "email", "이메일",
      "캘린더", "calendar", "일정", "schedule",
      "받은편지함", "inbox",
      "첨부", "attachment",
    ],
  },
  {
    name: "AppleScript/Messages",
    description: "iMessage·SMS 보내기",
    content: messagesKnowledge,
    keywords: [
      "메시지", "message", "imessage", "sms",
      "문자", "보내기", "send", "전송",
      "카톡", "카카오", "연락",
    ],
  },
];

/**
 * 사용자가 `~/.nekodesk/skills/*.md` 에 넣어둔 지식.
 *
 * 내장 지식은 빌드에 박혀 있어 못 고친다. 이건 앱 시작 때 한 번 읽어 같은 목록에
 * 합류시킨다. 파일을 고쳤으면 `reloadUserSkills()` 로 다시 읽는다.
 */
let userSkills: KnowledgeEntry[] = [];

export async function reloadUserSkills(): Promise<number> {
  try {
    const loaded = await skillsApi.load();
    // IPC 경계다. 배열이 아닌 게 오면 buildKnowledgeSection 의 전개가 터지고,
    // 그건 요청마다 지나는 길이라 대화 전체가 "LLM 연결 실패" 로 죽는다.
    userSkills = Array.isArray(loaded) ? loaded : [];
  } catch {
    userSkills = []; // 지식은 부가 기능이다. 못 읽어도 대화는 계속돼야 한다.
  }
  return userSkills.length;
}

/**
 * 지식 본문을 한 번에 얼마나 붙일지.
 *
 * Claude Code 는 스킬을 한 번에 하나씩 골라 읽는다. 여기서는 키워드로 여러 개가
 * 걸릴 수 있어서, 걸린 만큼 다 붙이면 music.md 하나만도 2천 토큰이라 컨텍스트가
 * 지식으로 메워진다. 많이 걸린 순으로 담고 예산이 차면 나머지는 버린다.
 */
const KNOWLEDGE_TOKEN_BUDGET = 3000;

/** "/이름 ..." 으로 시작하면 그 이름. Claude Code 의 슬래시 스킬 호출과 같다. */
function slashSkillName(userInput: string): string | null {
  return /^\s*\/(\S+)/.exec(userInput)?.[1] ?? null;
}

/**
 * 관련 knowledge 만 골라 프롬프트 조각으로 만든다.
 *
 * 걸리는 방법은 둘이다. 사용자 말에 키워드가 있거나, 사용자가 "/이름" 으로
 * 직접 불렀거나. 매칭되는 게 없으면 빈 문자열(프롬프트에 아무것도 안 붙임).
 */
export function buildKnowledgeSection(userInput: string, recentContext = ""): string {
  const combined = (userInput + " " + recentContext).toLowerCase();
  const all = [...userSkills, ...KNOWLEDGE_MAP];

  const forcedName = slashSkillName(userInput)?.toLowerCase();
  const forced = forcedName ? all.find((e) => e.name.toLowerCase() === forcedName) : undefined;

  // 많이 걸린 순. 같으면 원래 순서 — 사용자 것이 내장보다 앞이라 겹치면 사용자
  // 쪽을 먼저 읽게 된다.
  const ranked = all
    .map((entry, order) => ({
      entry,
      order,
      hits: entry.keywords.filter((kw) => combined.includes(kw.toLowerCase())).length,
    }))
    .filter(({ entry, hits }) => hits > 0 && entry !== forced)
    .sort((a, b) => b.hits - a.hits || a.order - b.order)
    .map(({ entry }) => entry);
  const candidates = forced ? [forced, ...ranked] : ranked;
  if (candidates.length === 0) return "";

  const picked: KnowledgeEntry[] = [];
  let used = 0;
  for (const entry of candidates) {
    const cost = estimateTokens(entry.content);
    // 첫 번째는 예산을 넘어도 넣는다 — 안 넣으면 걸린 게 없는 것과 같다.
    if (picked.length > 0 && used + cost > KNOWLEDGE_TOKEN_BUDGET) break;
    picked.push(entry);
    used += cost;
  }

  const sections = picked
    .map(({ name, content }) => `### ${name}\n${content.trim()}`)
    .join("\n\n");
  const note = forced ? ` (사용자가 /${forced.name} 으로 직접 불렀어)` : "";

  return `\n\n## 참고 지식${note}\n${sections}`;
}

/**
 * 시스템 프롬프트에 실을 스킬 목록 — 이름과 한 줄 요약만.
 *
 * Claude Code 가 스킬을 다루는 방식이다: 목록(가벼움)은 늘 보이고, 본문(무거움)은
 * 필요할 때만 붙는다. 목록이 있어야 모델이 "이런 건 할 줄 안다" 고 답할 수 있고,
 * 사용자도 무엇을 "/이름" 으로 부를 수 있는지 안다.
 */
export function buildSkillIndex(): string {
  return [...userSkills, ...KNOWLEDGE_MAP]
    .map(({ name, description }) => (description ? `- ${name}: ${description}` : `- ${name}`))
    .join("\n");
}
