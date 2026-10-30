# AppleScript — 앱 제어

## 앱 실행 / 종료
```applescript
-- 앱 실행 (활성화)
tell application "Safari" to activate
tell application "Finder" to activate

-- 앱 실행 (번들 ID로)
tell application id "com.apple.Safari" to activate

-- 앱 종료
tell application "Safari" to quit

-- 앱 강제 종료
do shell script "killall Safari"

-- 앱 숨기기 / 보이기
tell application "System Events"
    set visible of process "Safari" to false  -- 숨기기
    set visible of process "Safari" to true   -- 보이기
end tell
```

## 실행 중 앱 목록
```applescript
tell application "System Events"
    -- 일반 앱 (UI 있는 것만)
    set appNames to name of every process where background only is false

    -- 전체 프로세스
    set allProcs to name of every process
end tell
```

## 앱 실행 여부 확인
```applescript
tell application "System Events"
    set isRunning to (count of (every process whose name is "Safari")) > 0
end tell
```

## 창 제어
```applescript
tell application "Safari"
    -- 창 크기/위치
    set bounds of front window to {0, 0, 1280, 800}  -- {x, y, width, height}

    -- 최소화
    set miniaturized of front window to true

    -- 전체화면
    set zoomed of front window to true

    -- 창 닫기
    close front window
end tell
```

## Spotlight / 앱 열기 (shell 활용)
```applescript
-- 앱 열기 (open 명령)
do shell script "open -a Safari"
do shell script "open -a 'Google Chrome' 'https://example.com'"

-- 파일을 특정 앱으로 열기
do shell script "open -a TextEdit '/path/to/file.txt'"

-- 앱 번들 경로 찾기
do shell script "mdfind kMDItemCFBundleIdentifier = 'com.apple.Safari'"
```

## Dock / 메뉴바
```applescript
-- Dock 숨기기/보이기 토글
tell application "System Events"
    tell dock preferences
        set autohide to not autohide
    end tell
end tell
```

## 자주 쓰는 앱 번들 ID
```
Safari:          com.apple.Safari
Chrome:          com.google.Chrome
Firefox:         org.mozilla.firefox
Finder:          com.apple.finder
Music:           com.apple.Music
Mail:            com.apple.mail
Calendar:        com.apple.iCal
Notes:           com.apple.Notes
Messages:        com.apple.MobileSMS
Terminal:        com.apple.Terminal
VS Code:         com.microsoft.VSCode
Slack:           com.tinyspeck.slackmacgap
Notion:          notion.id
```


---

## 문법 참고 (2026-10-30 확인)

- 앱마다 정확한 명령·속성은 그 앱의 스크립트 사전(.sdef)이 기준이다. 웹 글보다 우선한다.
  `find /System/Applications/<앱>.app /System/Library/CoreServices/<앱>.app -name "*.sdef"` 로 찾아 grep 해라
  (`sdef` 명령은 Xcode 가 있어야 돌아서 이 Mac 에선 안 된다).
- 언어 문법: [AppleScript Language Guide](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/introduction/ASLR_intro.html) (Apple, 2016-01-25 갱신된 보관 문서)
- 자동화 예제: [Mac Automation Scripting Guide](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/index.html) (Apple, 2016-06-13 갱신된 보관 문서)
