# AppleScript — 브라우저 (Safari / Chrome)

## Safari

### 기본 제어
```applescript
tell application "Safari"
    activate                          -- 앱 활성화
    get URL of front document         -- 현재 URL
    get name of front document        -- 페이지 제목
end tell
```

### 탭 / 창 제어
```applescript
tell application "Safari"
    -- 새 탭으로 URL 열기
    make new document with properties {URL: "https://example.com"}

    -- 현재 탭 URL 변경
    set URL of front document to "https://example.com"

    -- 탭 목록
    set tabList to every tab of front window

    -- 탭 닫기
    close current tab of front window
end tell
```

### JavaScript 실행
```applescript
tell application "Safari"
    -- JS 실행 후 결과 반환
    set result to do JavaScript "document.title" in front document
    set result to do JavaScript "document.querySelector('h1').innerText" in front document

    -- 스크롤
    do JavaScript "window.scrollTo(0, 500)" in front document

    -- 클릭
    do JavaScript "document.querySelector('button').click()" in front document
end tell
```

### 북마크
```applescript
tell application "Safari"
    -- 현재 페이지 북마크 추가 (직접 API 없음 → 키보드 단축키 활용)
    tell application "System Events"
        keystroke "d" using {command down}
    end tell
end tell
```

---

## Google Chrome

### 기본 제어
```applescript
tell application "Google Chrome"
    activate
    get URL of active tab of front window    -- 현재 URL
    get title of active tab of front window  -- 탭 제목
end tell
```

### 탭 제어
```applescript
tell application "Google Chrome"
    -- 새 탭으로 URL 열기
    make new tab at end of tabs of front window with properties {URL: "https://example.com"}

    -- 모든 탭 URL 목록
    set urls to {}
    repeat with t in tabs of front window
        set end of urls to URL of t
    end repeat

    -- 탭 닫기
    close active tab of front window

    -- 새 창
    make new window
end tell
```

### JavaScript 실행
```applescript
tell application "Google Chrome"
    set result to execute front window's active tab javascript "document.title"
    execute front window's active tab javascript "window.scrollTo(0, 500)"
end tell
```

### 앞으로/뒤로/새로고침
```applescript
tell application "Google Chrome"
    tell front window's active tab
        reload       -- 새로고침
        go back      -- 뒤로
        go forward   -- 앞으로
    end tell
end tell
```


---

## 문법 참고 (2026-10-30 확인)

- 앱마다 정확한 명령·속성은 그 앱의 스크립트 사전(.sdef)이 기준이다. 웹 글보다 우선한다.
  `find /System/Applications/<앱>.app /System/Library/CoreServices/<앱>.app -name "*.sdef"` 로 찾아 grep 해라
  (`sdef` 명령은 Xcode 가 있어야 돌아서 이 Mac 에선 안 된다).
- 언어 문법: [AppleScript Language Guide](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/introduction/ASLR_intro.html) (Apple, 2016-01-25 갱신된 보관 문서)
- 자동화 예제: [Mac Automation Scripting Guide](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/index.html) (Apple, 2016-06-13 갱신된 보관 문서)
