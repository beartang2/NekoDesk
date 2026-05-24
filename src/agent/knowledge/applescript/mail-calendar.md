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

### 메시지 보내기
```applescript
tell application "Messages"
    set targetBuddy to buddy "010-1234-5678" of (service 1)
    send "안녕하세요!" to targetBuddy
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
