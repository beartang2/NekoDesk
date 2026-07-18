# AppleScript — Mail · Calendar · Messages

## Mail

### 메일 보내기
```applescript
tell application "Mail"
    set msg to make new outgoing message with properties {
        subject: "제목",
        content: "본문 내용",
        visible: false
    }
    tell msg
        make new to recipient with properties {address: "to@example.com"}
        make new cc recipient with properties {address: "cc@example.com"}
    end tell
    send msg
end tell
```

### 받은 편지함 읽기
```applescript
tell application "Mail"
    set inbox to mailbox "받은 편지함" of account 1
    set msgs to messages of inbox
    repeat with m in msgs
        if read status of m is false then
            log subject of m  -- 읽지 않은 메일 제목
        end if
    end repeat
end tell
```

### 첨부파일 저장
```applescript
tell application "Mail"
    set msg to message 1 of mailbox "받은 편지함" of account 1
    repeat with att in mail attachments of msg
        save att in (POSIX file "/Users/user/Downloads/") as native format
    end repeat
end tell
```

---

## Calendar (iCal)

### 일정 추가
```applescript
tell application "Calendar"
    tell calendar "집"
        set startDate to current date
        set endDate to startDate + 3600  -- 1시간 후
        make new event with properties {
            summary: "회의",
            start date: startDate,
            end date: endDate,
            description: "팀 주간 회의"
        }
    end tell
end tell
```

### 오늘 일정 조회
```applescript
tell application "Calendar"
    set today to current date
    set midnight to today - (time of today)
    set tomorrow to midnight + 86400

    set evts to (every event of calendar "집" whose start date ≥ midnight and start date < tomorrow)
    repeat with e in evts
        log summary of e & " @ " & (start date of e as text)
    end repeat
end tell
```

### 일정 삭제
```applescript
tell application "Calendar"
    tell calendar "집"
        set evts to every event whose summary is "회의"
        repeat with e in evts
            delete e
        end repeat
    end tell
end tell
```

---

## Messages (iMessage / SMS)

### 연락처 이름으로 검색 후 메시지 보내기 (권장 패턴)
⚠️ `buddy "이름"` 방식은 조용히 실패할 수 있음. 반드시 Contacts에서 전화번호를 조회한 뒤 번호로 전송할 것.
⚠️ Contacts 조회와 Messages 전송은 반드시 별개의 `tell application` 블록으로 분리할 것. 하나의 `tell application "Messages"` 블록 안에서 `every person` 같은 Contacts 명령어를 쓰면 오류 발생.

**완전한 동작 예시 (Contacts 조회 → 전화번호 추출 → Messages 전송)**
```applescript
-- Step 1: Contacts에서 이름으로 전화번호 조회
set phoneNum to ""
tell application "Contacts"
    set matchedPeople to every person whose name contains "홍길동"
    if (count of matchedPeople) is 0 then
        -- exact match 실패 → 핵심 키워드(2글자 이상)로 후보 추출 후 사용자에게 제안
        -- "혹시 이 분 말씀하시는 건가요?" 형태로 확인 받은 뒤 재시도
        error "연락처 없음"
    end if
    set targetPerson to item 1 of matchedPeople
    set phoneNum to value of item 1 of (phones of targetPerson)
    -- phoneNum 예시: "01012345678" (하이픈 없는 경우도 있음, 그대로 사용 가능)
end tell

-- Step 2: 조회한 전화번호로 Messages 전송 (별도 tell 블록)
tell application "Messages"
    send "보낼 메시지 내용" to buddy phoneNum of service 1
end tell
```

**exact match 실패 시 — 유사 이름 후보 추출**
```applescript
tell application "Contacts"
    set keyword to "길동"  -- 입력 이름에서 핵심 키워드 사용
    set candidates to {}
    repeat with p in (every person)
        if (name of p) contains keyword then
            set end of candidates to name of p
        end if
    end repeat
    return candidates  -- 이 목록을 사용자에게 제안
end tell
```

### 최근 대화 확인
```applescript
tell application "Messages"
    set convs to every chat
    repeat with c in convs
        log name of c
    end repeat
end tell
```
