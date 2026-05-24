# AppleScript — 시스템 제어

## 볼륨
```applescript
-- 출력 볼륨 설정 (0~100 정수)
set volume output volume 30

-- 입력(마이크) 볼륨 설정
set volume input volume 50

-- 음소거
set volume with output muted

-- 음소거 해제
set volume without output muted

-- 현재 볼륨 조회
set v to output volume of (get volume settings)  -- 정수 반환
set isMuted to output muted of (get volume settings)  -- boolean
```

## 화면 밝기
```applescript
-- 밝기는 AppleScript 직접 제어 불가 → shell 활용
do shell script "brightness 0.5"  -- 0.0~1.0 (brightness CLI 필요)

-- 다크모드 전환
tell application "System Events"
    tell appearance preferences
        set dark mode to true   -- 다크모드 켜기
        set dark mode to false  -- 라이트모드
    end tell
end tell
```

## 잠금 / 절전
```applescript
-- 화면 잠금
tell application "System Events" to keystroke "q" using {control down, command down}

-- 절전 모드
tell application "System Events" to sleep

-- 시스템 종료 (확인 대화상자 표시)
tell application "System Events" to shut down

-- 재시작
tell application "System Events" to restart
```

## 스크린샷
```applescript
-- 전체 화면 캡처 (~/Desktop/screenshot.png)
do shell script "screencapture ~/Desktop/screenshot.png"

-- 특정 영역 캡처 (x,y,width,height)
do shell script "screencapture -R 0,0,800,600 ~/Desktop/region.png"

-- 클립보드로 캡처
do shell script "screencapture -c"
```

## 알림 센터
```applescript
display notification "내용" with title "제목" subtitle "부제목" sound name "default"
```

## 시스템 정보
```applescript
-- 현재 사용자
do shell script "whoami"

-- macOS 버전
do shell script "sw_vers -productVersion"

-- 배터리 상태
do shell script "pmset -g batt"

-- CPU 사용률
do shell script "top -l 1 | grep 'CPU usage'"

-- 디스크 사용량
do shell script "df -h /"

-- IP 주소
do shell script "ipconfig getifaddr en0"
```

## Wi-Fi
```applescript
-- Wi-Fi 끄기
do shell script "networksetup -setairportpower en0 off" with administrator privileges

-- Wi-Fi 켜기
do shell script "networksetup -setairportpower en0 on" with administrator privileges

-- 현재 연결된 SSID
do shell script "networksetup -getairportnetwork en0"
```

## 클립보드
```applescript
-- 클립보드 읽기
set cb to the clipboard

-- 클립보드 쓰기
set the clipboard to "복사할 텍스트"

-- 클립보드 이미지 저장
set the clipboard to (read (POSIX file "/path/to/image.png") as JPEG picture)
```
