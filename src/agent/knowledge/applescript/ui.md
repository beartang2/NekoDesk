# AppleScript — UI 자동화 (키보드·마우스·대화상자)

## 키보드 입력
```applescript
tell application "System Events"
    -- 문자 입력
    keystroke "hello world"

    -- 단축키 (command+C = 복사)
    keystroke "c" using {command down}
    keystroke "v" using {command down}                      -- 붙여넣기
    keystroke "z" using {command down}                      -- 실행 취소
    keystroke "a" using {command down, shift down}          -- 복수 조합

    -- 특수키 (key code)
    key code 36   -- Return
    key code 48   -- Tab
    key code 51   -- Delete(Backspace)
    key code 53   -- Escape
    key code 123  -- 왼쪽 화살표
    key code 124  -- 오른쪽 화살표
    key code 125  -- 아래 화살표
    key code 126  -- 위 화살표
    key code 116  -- Page Up
    key code 121  -- Page Down
    key code 115  -- Home
    key code 119  -- End
end tell
```

## 마우스 제어
```applescript
tell application "System Events"
    -- 특정 좌표 클릭
    click at {500, 300}

    -- 더블클릭
    double click at {500, 300}

    -- 우클릭 (context menu)
    -- AppleScript 직접 우클릭 미지원 → cliclick 유틸 활용
    do shell script "/usr/local/bin/cliclick rc:500,300"
end tell
```

## UI 요소 클릭 (앱 내 버튼/메뉴)
```applescript
-- 메뉴 클릭
tell application "System Events"
    tell process "Safari"
        click menu item "새 탭" of menu "파일" of menu bar 1
    end tell
end tell

-- 버튼 클릭
tell application "System Events"
    tell process "앱이름"
        click button "확인" of window 1
    end tell
end tell

-- 텍스트 필드에 입력
tell application "System Events"
    tell process "앱이름"
        set value of text field 1 of window 1 to "입력값"
    end tell
end tell
```

## 대화상자
```applescript
-- 알림 메시지
display dialog "안녕하세요" buttons {"확인"} default button "확인"

-- 선택 대화상자
set choice to button returned of (display dialog "계속할까요?" buttons {"취소", "확인"} default button "확인")

-- 텍스트 입력
set userInput to text returned of (display dialog "이름:" default answer "")

-- 파일 선택
set f to choose file with prompt "파일을 선택하세요" of type {"public.plain-text"}
set fPath to POSIX path of f

-- 폴더 선택
set d to choose folder with prompt "폴더를 선택하세요"
set dPath to POSIX path of d

-- 목록 선택
set chosen to choose from list {"항목1", "항목2", "항목3"} with prompt "선택하세요"
```

## 알림 (Notification Center)
```applescript
display notification "완료됐습니다" with title "NekoDesk" subtitle "작업 완료" sound name "Glass"
-- sound name: "default", "Basso", "Glass", "Hero", "Ping", "Pop", "Purr", "Sosumi", "Tink"
```

## 스피치 (TTS)
```applescript
say "안녕하세요"
say "Hello" using "Samantha"  -- 특정 음성
say "텍스트" speaking rate 150 pitch 50  -- 속도/음높이 조절
```

## 클립보드
```applescript
set the clipboard to "복사할 내용"
set cb to the clipboard as text
```
