/**
 * code.exec 에 대한 하드 게이트.
 *
 * 기본값이 "확인 없이 실행"이고, 확인 여부를 LLM 의 `needsConfirm` 필드에 맡기던
 * 구조였다. 모델은 확인을 *추가*할 수는 있어도 *억제*할 수는 없지만(OR 연산),
 * 여기 걸리지 않는 코드는 모델이 `needsConfirm:false` 를 주면 조용히 실행된다.
 *
 * 예전 패턴은 셸 6종뿐이라 `shutil.rmtree(...)` 나 osascript 로 Mail 을 읽는 코드가
 * 그대로 통과했다. web.scrape 로 읽은 악성 페이지가 모델을 조종할 수 있으므로
 * 언어별로 실제 피해가 나는 지점을 덮는다.
 *
 * 오탐은 사용자를 지치게 해 결국 아무거나 승인하게 만든다. 시스템 프롬프트가
 * 날짜 계산에 `do shell script "date ..."` 를 권장하므로, `do shell script` 자체는
 * 막지 않고 그 안에서 파괴적 명령을 부를 때만 잡는다.
 */
export const DANGER_PATTERNS: Array<[RegExp, string]> = [
  // ── Shell ──
  [/\brm\s+-[rf]{1,2}\w*\s/, "파일/디렉토리 강제 삭제"],
  [/\bsudo\b/, "관리자 권한 실행"],
  [/\bdd\b.*\bif=/, "디스크 직접 쓰기"],
  [/>\s*\/dev\/(?!null)/, "디바이스 직접 접근"],
  [/\bkillall?\b|\bpkill\b/, "프로세스 강제 종료"],
  [/\bshutdown\b|\breboot\b/, "시스템 종료/재시작"],
  [/\bchmod\s+(\+x|777|a\+)/, "실행 권한 부여"],
  [/\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b/, "인터넷에서 받은 스크립트 즉시 실행"],
  [/\bnc\b\s+-\w*e/, "리버스 셸"],

  // ── Python ──
  [/\bshutil\.rmtree\s*\(/, "디렉토리 재귀 삭제 (Python)"],
  [/\bos\.(remove|unlink|rmdir)\s*\(/, "파일 삭제 (Python)"],
  [/\bos\.system\s*\(/, "Python 에서 셸 실행"],
  [/\bsubprocess\.(run|call|Popen|check_output|check_call)\s*\(/, "Python 에서 프로세스 실행"],

  // ── 자격증명 / 민감 파일 ──
  [/\.ssh\/|id_rsa|id_ed25519/, "SSH 개인키 접근"],
  [/\.aws\/credentials|\.config\/gcloud/, "클라우드 자격증명 접근"],
  [/\bsecurity\s+find-(generic|internet)-password/, "키체인 비밀번호 추출"],

  // ── AppleScript ──
  [/with administrator privileges/i, "관리자 권한 실행 (AppleScript)"],
  [/do shell script[^\n]*\b(rm|curl|wget|chmod|chown|sudo|nc|dd)\b/, "AppleScript 에서 위험한 셸 명령"],
  [/\bdelete\b[^\n]*\b(folder|file|disk)\b/i, "Finder 로 파일 삭제"],
  [/tell application "System Events"[^\n]*\bkeystroke\b/, "키 입력 자동화 (키로깅 가능)"],
];

/**
 * 밖으로 내보내는 동작. 확인 창 기본값에서는 어차피 묻지만, **오토모드에서도**
 * 건너뛰지 않는다. 한 번 나간 메시지·메일은 되돌릴 수 없고, 보내라는 지시가
 * 사용자가 아니라 모델이 읽은 웹페이지에서 왔을 수 있다.
 */
export const EXTERNAL_SEND_PATTERNS: Array<[RegExp, string]> = [
  [/tell application "Messages"[\s\S]*\bsend\b/i, "메시지 보내기"],
  [/tell application "Mail"[\s\S]*\b(send|outgoing message)\b/i, "메일 보내기"],
  [/\bsmtplib\b|\bsendmail\b/, "메일 보내기 (Python/셸)"],
  [/\bcurl\b[^\n]*\s(-X\s*POST|-d\b|--data|-F\b|--upload-file|-T\b)/, "외부로 데이터 보내기"],
  [/\brequests\.(post|put)\s*\(/, "외부로 데이터 보내기 (Python)"],
];

export function findExternalSendReason(code: string): string | undefined {
  return EXTERNAL_SEND_PATTERNS.find(([pattern]) => pattern.test(code))?.[1];
}

/** 걸린 패턴의 사유를 돌려준다. 안 걸리면 undefined. */
export function findDangerReason(code: string): string | undefined {
  return DANGER_PATTERNS.find(([pattern]) => pattern.test(code))?.[1];
}

// 부작용이 없다고 확신할 수 있는 좁은 화이트리스트. 애매하면 false 를 돌려
// 확인을 요구한다(fail-safe). 여기 있는 것만 확인 없이 실행된다.

const SAFE_APPLESCRIPT = [
  /^\s*display notification\b/,     // 알림
  /^\s*get volume settings\b/,      // 볼륨 조회
  /^\s*set volume\b/,               // 볼륨 조절 (되돌리기 쉬움)
];

// 읽기/조회만 하는 셸 명령. 쓰기·삭제·네트워크·리다이렉트가 없어야 한다.
const SAFE_SHELL_ONELINE =
  /^\s*(date|cal|whoami|pwd|hostname|uptime|sw_vers|uname|echo)\b[^\n]*$/;

const HAS_REDIRECT_OR_PIPE = /[|>]/;

/**
 * 확인 없이 실행해도 안전한, 부작용 없는 코드인가.
 * 확신이 없으면 false — 그러면 확인 다이얼로그가 뜬다.
 */
export function isSafeReadOnly(code: string, language: string): boolean {
  if (findDangerReason(code)) return false;
  const lang = language.toLowerCase();
  const src = code.trim();
  if (!src) return false;

  if (lang === "applescript" || lang === "osascript") {
    return src.split("\n").every((line) => {
      const l = line.trim();
      if (!l || l.startsWith("--")) return true;
      return SAFE_APPLESCRIPT.some((re) => re.test(l));
    });
  }

  if (lang === "shell" || lang === "sh" || lang === "bash") {
    // 한 줄짜리 순수 조회만 허용. 여러 줄·파이프·리다이렉트는 확인.
    if (src.includes("\n") || HAS_REDIRECT_OR_PIPE.test(src)) return false;
    return SAFE_SHELL_ONELINE.test(src);
  }

  // Python 등은 임의 부작용을 판별하기 어렵다. 항상 확인.
  return false;
}
