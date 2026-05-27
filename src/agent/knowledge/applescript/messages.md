# AppleScript — Messages (메시지) 앱

## 메시지 보내기 (iMessage / SMS)

```applescript
-- 전화번호로 iMessage 보내기
tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    send "안녕하세요" to buddy "+821012345678" of targetService
end tell

-- SMS로 보내기
tell application "Messages"
    set targetService to 1st service whose service type = SMS
    send "안녕하세요" to buddy "+821012345678" of targetService
end tell

-- iMessage 안 되면 SMS로 fallback
tell application "Messages"
    set phoneNum to "+821012345678"
    try
        set targetService to 1st service whose service type = iMessage
    on error
        set targetService to 1st service whose service type = SMS
    end try
    send "안녕하세요" to buddy phoneNum of targetService
end tell
```

**주의**: `buddy`와 `service`는 반드시 `tell application "Messages"` 블록 **안에서만** 사용 가능합니다. 블록 밖에서 참조하면 `-2741` 에러가 발생합니다.

**서명**: 메시지 본문 마지막에 반드시 `\n\nsent by Neko 🐱`를 붙인다. 예: `"안녕하세요\n\nsent by Neko 🐱"`

## Contacts에서 번호 가져와서 보내기

```applescript
-- 연락처에서 이름으로 검색 후 메시지 전송
set phoneNum to ""

tell application "Contacts"
    set matchedPeople to every person whose name contains "홍길동"
    if (count of matchedPeople) is 0 then
        error "연락처를 찾을 수 없습니다."
    end if
    set targetPerson to item 1 of matchedPeople
    set phoneNum to value of item 1 of (phones of targetPerson)
end tell

-- Contacts tell 블록이 끝난 뒤에도 phoneNum 변수는 사용 가능
tell application "Messages"
    set targetService to 1st service whose service type = iMessage
    send "안녕하세요" to buddy phoneNum of targetService
end tell
```

## 대화 목록 / 최근 메시지 조회

```applescript
tell application "Messages"
    -- 모든 대화 목록
    set allChats to every chat
    
    -- 첫 번째 대화의 최근 메시지
    set recentMessages to messages of item 1 of allChats
    set lastMsg to item -1 of recentMessages
    log content of lastMsg
end tell
```

## 전화번호 형식

- 한국 번호는 `010-XXXX-XXXX` 또는 `01012345678` 형식 모두 동작
- 국제 형식 `+82 10-XXXX-XXXX` 도 사용 가능
- Contacts에서 가져온 번호 형식을 그대로 사용하면 됨
