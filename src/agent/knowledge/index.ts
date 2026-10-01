import { skillsApi } from "../../api/tauri";
import systemKnowledge      from "./applescript/system.md?raw";
import musicKnowledge       from "./applescript/music.md?raw";
import finderKnowledge      from "./applescript/finder.md?raw";
import browserKnowledge     from "./applescript/browser.md?raw";
import uiKnowledge          from "./applescript/ui.md?raw";
import appsKnowledge        from "./applescript/apps.md?raw";
import mailCalendarKnowledge from "./applescript/mail-calendar.md?raw";
import messagesKnowledge     from "./applescript/messages.md?raw";
import drawingKnowledge      from "./drawing.md?raw";

interface KnowledgeEntry {
  name: string;
  /** 한 줄 요약. 스킬 목록(프롬프트)에 이름 옆에 실린다 — 짧게. */
  description: string;
  content: string;
}

const KNOWLEDGE_MAP: KnowledgeEntry[] = [
  {
    name: "그림그리기",
    description: "SVG 로 그림·아이콘·캐릭터 그리기",
    content: drawingKnowledge,
  },
  {
    name: "AppleScript/시스템",
    description: "볼륨·밝기·다크모드·스크린샷·배터리·클립보드",
    content: systemKnowledge,
  },
  {
    name: "AppleScript/Music",
    description: "Music 앱 재생·플레이리스트·추천",
    content: musicKnowledge,
  },
  {
    name: "AppleScript/Finder",
    description: "파일·폴더 복사·이동·삭제",
    content: finderKnowledge,
  },
  {
    name: "AppleScript/브라우저",
    description: "Safari·Chrome 탭·URL·페이지",
    content: browserKnowledge,
  },
  {
    name: "AppleScript/UI자동화",
    description: "키보드·마우스·메뉴·대화상자 조작, TTS",
    content: uiKnowledge,
  },
  {
    name: "AppleScript/앱제어",
    description: "앱 실행·종료·숨기기",
    content: appsKnowledge,
  },
  {
    name: "AppleScript/메일·캘린더",
    description: "Mail·Calendar 읽기·쓰기",
    content: mailCalendarKnowledge,
  },
  {
    name: "AppleScript/Messages",
    description: "iMessage·SMS 보내기",
    content: messagesKnowledge,
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

/** "/이름 ..." 으로 시작하면 그 이름. Claude Code 의 슬래시 스킬 호출과 같다. */
function slashSkillName(userInput: string): string | null {
  return /^\s*\/(\S+)/.exec(userInput)?.[1] ?? null;
}

/** 이름으로 지식 하나를 찾는다. 대소문자·앞뒤 공백·선행 슬래시를 무시한다. */
function findKnowledge(name: string): KnowledgeEntry | undefined {
  const q = name.trim().toLowerCase().replace(/^\//, "");
  if (!q) return undefined;
  const all = [...userSkills, ...KNOWLEDGE_MAP];
  // 정확히 맞는 게 우선. 없으면 부분 일치 — 모델이 "AppleScript" 만 적기도 한다.
  return all.find((e) => e.name.toLowerCase() === q) ?? all.find((e) => e.name.toLowerCase().includes(q));
}

/**
 * `skill.read` 툴이 쓴다. 모델이 목록을 보고 필요하다고 판단했을 때만 불린다.
 */
export function readKnowledge(name: string): { name: string; content: string } | null {
  const hit = findKnowledge(name);
  return hit ? { name: hit.name, content: hit.content.trim() } : null;
}

/**
 * 사용자가 "/이름" 으로 직접 부른 지식만 프롬프트에 붙인다.
 *
 * 예전에는 엔트리마다 키워드 표를 달아 사용자 말과 맞춰보고 자동으로 붙였다.
 * 표에 없는 말로 물으면 안 걸리고("자화상 그려줘" 는 걸리는데 "네 모습 보여줘" 는
 * 안 걸림), 엉뚱하게 걸리면 컨텍스트만 먹었다. 지금은 시스템 프롬프트의 목록을
 * 보고 모델이 `skill.read` 로 직접 읽는다 — 언제 필요한지는 모델이 판단한다.
 * 이 함수는 사용자가 명시적으로 부르는 경로만 남긴 것이다.
 */
export function buildKnowledgeSection(userInput: string): string {
  const name = slashSkillName(userInput);
  if (!name) return "";
  const entry = findKnowledge(name);
  if (!entry) return "";
  return `\n\n## 참고 지식 (사용자가 /${entry.name} 으로 직접 불렀어)\n### ${entry.name}\n${entry.content.trim()}`;
}

/**
 * 시스템 프롬프트에 실을 스킬 목록 — 이름과 한 줄 요약만.
 *
 * Claude Code 가 스킬을 다루는 방식이다: 목록(가벼움)은 늘 보이고, 본문(무거움)은
 * 모델이 `skill.read` 로 부를 때만 온다. 목록이 있어야 모델이 "이런 건 할 줄 안다"
 * 고 답할 수 있고, 사용자도 무엇을 "/이름" 으로 부를 수 있는지 안다.
 */
export function buildSkillIndex(): string {
  return [...userSkills, ...KNOWLEDGE_MAP]
    .map(({ name, description }) => (description ? `- ${name}: ${description}` : `- ${name}`))
    .join("\n");
}
