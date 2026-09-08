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
  content: string;
  keywords: string[];
}

const KNOWLEDGE_MAP: KnowledgeEntry[] = [
  {
    name: "AppleScript/시스템",
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
    content: musicKnowledge,
    keywords: [
      "음악", "music", "노래", "song", "track", "앨범", "album",
      "재생", "play", "일시정지", "pause", "다음곡", "이전곡",
      "셔플", "shuffle", "반복", "repeat",
      "플레이리스트", "playlist",
      "요루시카", "아티스트", "artist",
      "airplay",
      "틀어줘", "틀어", "들을래", "들을게", "들어볼게", "추천", "recommend",
      "lemon", "yonezu", "yorushika", "kenshi",
      "새로운 노래", "모르는 노래", "안 들어본", "미리듣기", "취향에 맞는",
    ],
  },
  {
    name: "AppleScript/Finder",
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
    const { skillsApi } = await import("../../api/tauri");
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
 * 사용자 입력 키워드를 보고 관련 knowledge 파일만 골라 반환한다.
 * 매칭되는 게 없으면 빈 문자열 반환 (프롬프트에 불필요한 내용 추가 안 함).
 */
export function buildKnowledgeSection(userInput: string, recentContext = ""): string {
  const combined = (userInput + " " + recentContext).toLowerCase();

  // 사용자 것을 앞에 둔다. 내장 지식과 겹치면 사용자 쪽을 먼저 읽게 된다.
  const matched = [...userSkills, ...KNOWLEDGE_MAP].filter(({ keywords }) =>
    keywords.some((kw) => combined.includes(kw.toLowerCase()))
  );

  if (matched.length === 0) return "";

  const sections = matched
    .map(({ name, content }) => `### ${name}\n${content.trim()}`)
    .join("\n\n");

  return `\n\n## 참고 지식\n${sections}`;
}
