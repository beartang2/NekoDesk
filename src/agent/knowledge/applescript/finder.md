# AppleScript — Finder (파일/폴더)

## 폴더/파일 열기
```applescript
-- 폴더 열기
tell application "Finder" to open folder (POSIX file "/Users/user/Documents" as alias)

-- 파일 열기 (기본 앱으로)
tell application "Finder" to open (POSIX file "/path/to/file.txt" as alias)

-- 특정 앱으로 열기
tell application "Finder" to open (POSIX file "/path/to/file.txt" as alias) using application file id "com.apple.TextEdit"
```

## 파일/폴더 존재 확인
```applescript
tell application "Finder"
    exists POSIX file "/path/to/file.txt"    -- true/false
    exists folder (POSIX file "/path/to/dir" as alias)
end tell
```

## 선택된 항목
```applescript
tell application "Finder"
    -- 선택된 파일 경로 (POSIX)
    set sel to selection
    if (count of sel) > 0 then
        POSIX path of (item 1 of sel as alias)
    end if

    -- 현재 Finder 창 경로
    POSIX path of (target of front Finder window as alias)
end tell
```

## 파일 복사/이동/삭제
```applescript
tell application "Finder"
    -- 복사
    duplicate (POSIX file "/src/file.txt" as alias) to folder (POSIX file "/dst/" as alias)

    -- 이동
    move (POSIX file "/src/file.txt" as alias) to folder (POSIX file "/dst/" as alias)

    -- 휴지통으로
    delete (POSIX file "/path/to/file.txt" as alias)

    -- 휴지통 비우기
    empty trash
end tell
```

## 새 폴더 생성
```applescript
tell application "Finder"
    make new folder at (POSIX file "/Users/user/Desktop" as alias) with properties {name:"새폴더"}
end tell
```

## 폴더 내 항목 목록
```applescript
tell application "Finder"
    set items to every item of folder (POSIX file "/Users/user/Desktop" as alias)
    repeat with f in items
        log name of f
    end repeat
end tell
```

## 경로 변환
```applescript
-- POSIX → HFS
set hfsPath to POSIX file "/Users/user/Desktop" as text
-- 결과: "Macintosh HD:Users:user:Desktop:"

-- HFS → POSIX
set posixPath to POSIX path of "Macintosh HD:Users:user:Desktop:"
```

## 파인더 창 제어
```applescript
tell application "Finder"
    -- 새 창 열기
    make new Finder window to desktop

    -- 현재 창 닫기
    close front Finder window

    -- 보기 모드 변경 (icon / list / column / gallery)
    set current view of front Finder window to list view
end tell
```

## 태그 / 색상
```applescript
tell application "Finder"
    -- 태그 추가
    set label index of (POSIX file "/path/to/file" as alias) to 2  -- 1~7, 0=없음
end tell
```
