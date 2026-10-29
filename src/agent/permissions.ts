import { settingsApi } from "../api/tauri";
import type { PermissionDecision } from "./types";

/**
 * 툴 실행 승인 규칙.
 *
 * 예전에는 `code.exec` 를 부를 때마다 확인 다이얼로그가 떴다. 같은 명령을 하루에
 * 스무 번 승인하게 만들면 사용자는 내용을 안 읽고 누르게 되고, 그러면 확인 창이
 * 방어 수단이 아니라 장식이 된다. 그래서 "이 세션 동안" / "항상" 을 둔다.
 *
 * 다만 `danger-patterns.ts` 에 걸린 코드는 어떤 규칙으로도 건너뛸 수 없다. 규칙을
 * 만드는 주체가 사용자가 아니라 프롬프트 인젝션일 수 있기 때문이다.
 */

export type { PermissionDecision };

const RULES_KEY = "permission_rules";
const WRITE_ROOTS_KEY = "fs_write_roots";

/** 앱을 껐다 켜면 사라지는 승인. */
const sessionRules = new Set<string>();

/** 영속 승인. DB 가 원본이고 이건 읽기 캐시다(hot path 에서 IPC 를 안 타려고). */
let alwaysRules = new Set<string>();
let loaded = false;

export async function loadPermissionRules(): Promise<void> {
  try {
    const raw = await settingsApi.get(RULES_KEY);
    alwaysRules = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    alwaysRules = new Set();
  }
  loaded = true;
}

export function isLoaded(): boolean {
  return loaded;
}

/** 이 규칙 키가 이미 승인돼 있는가. */
export function isAllowed(ruleKey: string): boolean {
  return sessionRules.has(ruleKey) || alwaysRules.has(ruleKey);
}

/** 사용자의 선택을 기록한다. allow_once 는 아무것도 남기지 않는다. */
export async function remember(ruleKey: string, decision: PermissionDecision): Promise<void> {
  if (decision === "allow_session") {
    sessionRules.add(ruleKey);
    return;
  }
  if (decision !== "allow_always") return;

  alwaysRules.add(ruleKey);
  await settingsApi.set(RULES_KEY, JSON.stringify([...alwaysRules])).catch(() => {});
}

/** 테스트·설정 화면용. */
export function listAlwaysRules(): string[] {
  return [...alwaysRules].sort();
}

export async function forgetAlwaysRule(ruleKey: string): Promise<void> {
  alwaysRules.delete(ruleKey);
  await settingsApi.set(RULES_KEY, JSON.stringify([...alwaysRules])).catch(() => {});
}

export function clearSessionRules(): void {
  sessionRules.clear();
}

/**
 * 오토모드 — 확인 창 없이 실행한다.
 *
 * 그래도 건너뛰지 않는 것: 위험 패턴(`danger-patterns.ts`)과 밖으로 내보내는 동작
 * (메시지·메일 전송 등). 웹페이지에 숨은 지시에 모델이 조종당해도 되돌릴 수 없는
 * 일은 일어나지 않게 하려는 것이다. 자격증명 경로는 백엔드가 막으니 여기와 무관하다.
 *
 * 저장하지 않는다. 앱을 끄면 꺼진다 — 켜둔 걸 잊는 게 가장 위험해서.
 */
let autoApprove = false;

export function isAutoApprove(): boolean {
  return autoApprove;
}

export function setAutoApprove(on: boolean): void {
  autoApprove = on;
}

// ── 규칙 키 ───────────────────────────────────────────────────────────────────

/**
 * code.exec 의 규칙 키. **null 이면 기억할 수 없는 호출**이다 — 매번 묻는다.
 *
 * 코드 전체가 아니라 **무엇을 실행하는지**로 묶는다. `git status` 를 승인했다고
 * `git push --force` 까지 열리면 안 되므로 shell 은 첫 두 토큰까지 본다
 * (`git status`, `brew install`). AppleScript 는 어느 앱을 조종하는지가 핵심이다.
 *
 * 기억할 수 없는 것:
 *  - Python 등 범용 언어. "python 항상 허용" 은 "아무 코드나 항상 허용" 과 같다.
 *  - 메타문자가 든 셸(`git status; git push`). 첫 명령만 보고 키를 만들면 뒤에 붙은
 *    명령이 그 키로 같이 열린다.
 *  - 인터프리터·래퍼(`python3 -c`, `sh -c`, `xargs`, `env`). 역시 아무 코드나 돈다.
 *  - 앱을 안 고른 AppleScript, 또는 메시지·메일·키 입력처럼 되돌릴 수 없는 앱.
 */
export function execRuleKey(code: string, language: string): string | null {
  const lang = language.toLowerCase();
  if (lang === "applescript" || lang === "osascript") {
    return appleScriptRuleKey(code);
  }
  if (lang === "shell" || lang === "sh" || lang === "bash") {
    const lines = code.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    // 명령이 두 줄이면 첫 줄 키로 둘째 줄까지 열린다. 한 줄, 그것도 메타문자 없는 한 줄만.
    if (lines.length !== 1 || SHELL_COMPOUND.test(lines[0])) return null;
    const first = firstCommand(lines[0]);
    if (!first || INTERPRETERS.has(first.split(" ")[0])) return null;
    return `code.exec:shell:${first}`;
  }
  return null;
}

/** 연결·치환·서브셸·이스케이프. 하나라도 있으면 명령이 하나가 아니다. */
const SHELL_COMPOUND = /[;&|$`(){}\\]/;

/** 이 안에서 아무 코드나 돌릴 수 있는 명령. 기억하면 언어 전체를 여는 셈이다. */
const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "fish", "dash", "python", "python3", "node", "deno", "bun", "ruby", "perl",
  "php", "osascript", "swift", "eval", "exec", "xargs", "env", "nohup", "nice", "time", "sudo",
  "doas", "su", "command", "builtin", "source", ".",
]);

/**
 * 되돌릴 수 없거나 다른 앱으로 번지는 AppleScript 대상. 매번 묻는다.
 * System Events 는 키 입력·메뉴 조작으로 어떤 앱이든 조종할 수 있다.
 */
const APPLESCRIPT_NEVER_REMEMBER = new Set([
  "messages", "mail", "system events", "safari", "google chrome", "chrome", "arc", "firefox",
  "terminal", "iterm", "iterm2", "script editor",
]);

const APPLESCRIPT_ESCAPES = /\b(do shell script|run script|load script|do javascript|keystroke|key code|with administrator privileges)\b/i;

function appleScriptRuleKey(code: string): string | null {
  if (APPLESCRIPT_ESCAPES.test(code)) return null;
  const targets = new Set<string>();
  for (const m of code.matchAll(/tell\s+(?:application|app)\s+(?:id\s+)?"([^"]+)"/gi)) {
    targets.add(m[1]);
  }
  if (targets.size === 0) return null;
  for (const t of targets) {
    if (APPLESCRIPT_NEVER_REMEMBER.has(t.toLowerCase())) return null;
  }
  // 조종하는 앱 **전부**가 키다. Music 만 승인했는데 Music+Messages 스크립트가 열리면 안 된다.
  return `code.exec:applescript:${[...targets].sort().join("+")}`;
}

/**
 * 셸 코드에서 실제로 실행되는 첫 명령을 뽑는다.
 *
 * 환경변수 대입(`FOO=1 git ...`)을 건너뛴다. 서브명령이 있는 도구(git, brew, npm,
 * docker)는 두 토큰을 묶어야 의미가 산다.
 */
const SUBCOMMAND_TOOLS = new Set([
  "git", "brew", "npm", "npx", "pnpm", "yarn", "cargo", "docker", "kubectl", "gh", "pip", "pip3",
]);

function firstCommand(code: string): string | null {
  const line = code.trim().split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
  if (!line) return null;

  const tokens = line
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    // 앞에 붙는 환경변수 대입은 명령이 아니다.
    .filter((t, i, arr) => !(i < arr.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)));

  const head = tokens[0];
  if (!head) return null;
  // 경로로 부른 경우 basename 만 (`/usr/bin/git` → `git`)
  const name = head.split("/").pop() ?? head;
  if (SUBCOMMAND_TOOLS.has(name) && tokens[1] && !tokens[1].startsWith("-")) {
    return `${name} ${tokens[1]}`;
  }
  return name;
}

/**
 * 파일 쓰기의 규칙 키는 **부모 디렉토리**다. 파일 하나를 승인했다고 그 파일만
 * 열어두면 규칙이 수백 개로 늘어 아무 의미가 없다.
 */
export function writeRuleKey(path: string): string | null {
  const dir = parentDir(path);
  // 홈이나 루트 바로 아래 파일을 "항상" 으로 열면 `~/.zshrc`, `~/Library/...` 까지 그 규칙에
  // 들어간다(쓰기 루트는 재귀다). 그런 쓰기는 매번 묻는다.
  if (dir === "/" || /^\/Users\/?$/.test(dir) || /^\/Users\/[^/]+$/.test(dir) || /^\/home\/[^/]+$/.test(dir)) {
    return null;
  }
  return `fs.write:${dir}`;
}

export function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

/**
 * "항상 허용" 된 쓰기 경로는 Rust 쪽 승인 루트로도 넘어가야 한다. 그래야 다음부터
 * 백엔드가 `approved` 없이도 통과시킨다.
 */
export async function addWriteRoot(dir: string): Promise<void> {
  try {
    const raw = await settingsApi.get(WRITE_ROOTS_KEY);
    const roots = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    roots.add(dir);
    await settingsApi.set(WRITE_ROOTS_KEY, JSON.stringify([...roots]));
  } catch {
    // 실패해도 치명적이지 않다 — 다음번에 다시 확인을 물을 뿐이다.
  }
}
