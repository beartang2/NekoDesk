import { describe, expect, it } from "vitest";
import { findPersonal, maskPersonal, outboundConcern, redactSecrets } from "./outbound-guard";

describe("비밀 가리기", () => {
  it("키·토큰·개인 키·비밀번호 대입은 가리고, 이름과 보통 글은 둔다", () => {
    const text = [
      "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "DB_PASSWORD='hunter2' # 메모",
      '{"password": "hunter2", "user": "kim"}',
      "aws AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
      "token 이라는 단어와 password 라는 말은 그냥 글이다",
    ].join("\n");
    const out = redactSecrets(text);
    for (const leak of ["sk-ant-api03", "hunter2", "AKIAIOSFODNN7EXAMPLE", "b3BlbnNzaC1rZXk", "abcdefghijklmnopqrstuvwxyz0123"]) {
      expect(out).not.toContain(leak);
    }
    expect(out).toContain("ANTHROPIC_API_KEY=‹");
    expect(out).toContain('"user": "kim"');
    expect(out).toContain("token 이라는 단어와 password 라는 말은 그냥 글이다");
    // 같은 입력은 늘 같은 출력이다(프롬프트 캐시).
    expect(redactSecrets(text)).toBe(out);
  });
});

describe("개인정보 찾기", () => {
  it("하이픈 있는 주민등록번호, 검증 숫자 맞는 카드번호를 찾고 가린다", () => {
    const text = "주민 900101-1234567, 카드 4111 1111 1111 1111, 주문번호 4111111111111112, 전화 010-1234-5678";
    expect(findPersonal(text)).toEqual(["주민등록번호처럼 보이는 값 1개", "카드번호처럼 보이는 값 1개"]);
    const masked = maskPersonal(text);
    expect(masked).toContain("‹주민등록번호 가림›");
    expect(masked).toContain("‹카드번호 가림›");
    expect(masked).toContain("4111111111111112"); // Luhn 이 안 맞는 건 그대로
    expect(masked).toContain("010-1234-5678");
  });

  it("메일·메시지를 읽은 AppleScript 결과는 개인정보가 없어도 묻는다", () => {
    const mail = outboundConcern("code.exec", { language: "applescript", code: 'tell application "Mail" to get content of message 1 of inbox' }, "안녕");
    expect(mail?.ruleKey).toBe("outbound:메일");
    expect(outboundConcern("code.exec", { language: "applescript", code: 'tell application "Music" to play' }, "ok")).toBeNull();
    expect(outboundConcern("todo.list", {}, "할 일 없음")).toBeNull();
  });

  it("앱 이름 대소문자·app·번들 ID·JXA·셸 osascript·데이터 경로도 사적인 출처로 친다", () => {
    const exec = (language: string, code: string) => outboundConcern("code.exec", { language, code }, "x")?.source;
    expect(exec("applescript", 'tell app "mail" to get messages')).toBe("메일");
    expect(exec("applescript", 'tell application id "com.apple.MobileSMS" to get chats')).toBe("메시지");
    expect(exec("javascript", 'Application("Contacts").people()')).toBe("연락처");
    expect(exec("shell", `osascript -e 'tell application "Notes" to get body of note 1'`)).toBe("메모");
    expect(exec("shell", "sqlite3 ~/Library/Messages/chat.db 'select text from message'")).toBe("메시지");
    expect(exec("python", "open(os.path.expanduser('~/Library/Mail/V10/x.emlx')).read()")).toBe("메일");
    expect(outboundConcern("fs.read", { path: "~/Library/Group Containers/group.com.apple.notes/x" }, "x")?.source).toBe("메모");
    expect(exec("shell", `osascript -e 'tell application "Music" to play'`)).toBeUndefined();
  });
});
