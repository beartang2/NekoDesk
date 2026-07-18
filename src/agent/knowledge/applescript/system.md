# AppleScript — 시스템 제어

## 볼륨
⚠️ 볼륨 제어는 반드시 아래 형식을 사용할 것. `tell application "Music" to set volume ...` 형식은 문법 오류 발생.

```applescript
-- 출력 볼륨 절댓값 설정 (0~100 정수)
set volume output volume 30   -- 30으로 설정

-- ⚠️ "N 올려줘" / "N 줄여줘" → 반드시 현재 볼륨 먼저 읽고 계산
-- "볼륨 10 올려줘" 예시:
set curVol to output volume of (get volume settings)
set volume output volume (curVol + 10)
-- "볼륨 5 줄여줘" 예시:
set curVol to output volume of (get volume settings)
set volume output volume (curVol - 5)

-- 음소거
set volume output muted true
-- 음소거 해제
set volume output muted false

-- 현재 볼륨 조회
set volSettings to get volume settings
set curVol to output volume of volSettings   -- 정수(0~100)
set isMuted to output muted of volSettings   -- boolean
```

## 화면 밝기
```applescript
-- 밝기는 AppleScript 직접 제어 불가 → shell 활용
-- ⚠️ brightness CLI는 macOS에 기본 포함되지 않음. Homebrew로 설치 필요: brew install brightness
do shell script "brightness 0.5"  -- 0.0~1.0

-- brightness CLI 없이 사용 가능한 대안 (Accessibility Inspector 기반, 단계별 조절만 가능)
-- 키보드 단축키로 밝기 조절 (접근성 권한 필요)
tell application "System Events"
    key code 113  -- 밝기 낮추기 (F1)
    key code 144  -- 밝기 높이기 (F2)
end tell

-- 다크모드 전환 (macOS Mojave 10.14 이상, Sonoma/Sequoia에서 동작 확인됨)
tell application "System Events"
    tell appearance preferences
        set dark mode to true   -- 다크모드 켜기
        set dark mode to false  -- 라이트모드
    end tell
end tell

-- 다크모드 토글
tell application "System Events"
    tell appearance preferences
        set dark mode to not dark mode
    end tell
end tell
```

## 잠금 / 절전
```applescript
-- 화면 잠금 (macOS 10.13 High Sierra 이상)
-- ⚠️ 접근성 권한 필요 (시스템 환경설정 > 개인 정보 보호 > 접근성에서 앱 허용)
tell application "System Events" to keystroke "q" using {control down, command down}

-- 접근성 권한 없이 화면 잠금 (스크린세이버 실행 방식)
-- ⚠️ "잠자기 후 암호 요구" 설정이 "즉시"로 되어 있어야 실제 잠금됨
do shell script "open -a ScreenSaverEngine"

-- 절전 모드 (디스플레이 + 시스템 절전)
tell application "System Events" to sleep
-- 또는 Finder 사용 (동일한 효과)
-- tell application "Finder" to sleep

-- 디스플레이만 끄기 (시스템은 계속 실행)
do shell script "pmset displaysleepnow"

-- 시스템 종료 (확인 대화상자 표시)
tell application "System Events" to shut down

-- 재시작
tell application "System Events" to restart
```

## 스크린샷
```applescript
-- 전체 화면 캡처 (~/Desktop/screenshot.png)
-- ⚠️ 화면 녹화 권한 필요 (시스템 환경설정 > 개인 정보 보호 > 화면 녹화)
do shell script "screencapture ~/Desktop/screenshot.png"

-- 특정 영역 캡처 (-R<x,y,width,height> 형식, 공백 없이)
do shell script "screencapture -R 0,0,800,600 ~/Desktop/region.png"

-- 클립보드로 캡처
do shell script "screencapture -c"

-- 소리 없이 캡처
do shell script "screencapture -x ~/Desktop/screenshot.png"

-- JPEG 형식으로 저장
do shell script "screencapture -t jpg ~/Desktop/screenshot.jpg"
```

## 알림 센터
```applescript
-- ⚠️ "default"는 유효한 sound name이 아님. 실제 시스템 사운드 이름을 사용할 것.
-- 유효한 sound name: Basso, Blow, Bottle, Frog, Funk, Glass, Hero, Morse, Ping, Pop, Purr, Sosumi, Submarine, Tink
display notification "내용" with title "제목" subtitle "부제목" sound name "Glass"

-- 사운드 없이 알림
display notification "내용" with title "제목"

-- ⚠️ 알림 표시 여부는 시스템 환경설정 > 알림 설정에 따라 달라질 수 있음
```

## 시스템 정보
```applescript
-- 현재 사용자
do shell script "whoami"

-- macOS 버전
do shell script "sw_vers -productVersion"

-- 배터리 상태
do shell script "pmset -g batt"

-- CPU 사용률 (-s 0 플래그로 즉시 출력, 대기 시간 없음)
do shell script "top -l 1 -s 0 | grep 'CPU usage'"

-- 디스크 사용량
do shell script "df -h /"

-- IP 주소 (Wi-Fi: en0, 유선: 기기마다 다름)
do shell script "ipconfig getifaddr en0"

-- 전체 네트워크 인터페이스 목록 확인
do shell script "networksetup -listallhardwareports"
```

## Wi-Fi
```applescript
-- Wi-Fi 끄기
-- ⚠️ with administrator privileges는 sudo 없이 root 권한 요청. sudo와 중복 사용 금지.
do shell script "networksetup -setairportpower en0 off" with administrator privileges

-- Wi-Fi 켜기
do shell script "networksetup -setairportpower en0 on" with administrator privileges

-- 현재 연결된 SSID
do shell script "networksetup -getairportnetwork en0"

-- ⚠️ Wi-Fi 인터페이스 이름은 기기마다 다를 수 있음 (대부분 en0이지만 확인 필요)
-- 인터페이스 이름 확인 방법:
-- do shell script "networksetup -listallhardwareports"
```

## 클립보드
```applescript
-- 클립보드 읽기
set cb to the clipboard

-- 클립보드 쓰기
set the clipboard to "복사할 텍스트"

-- 클립보드에 이미지 저장 (파일 형식에 맞는 클래스 지정)
-- PNG 파일의 경우
set the clipboard to (read (POSIX file "/path/to/image.png") as «class PNGf»)
-- JPEG 파일의 경우
set the clipboard to (read (POSIX file "/path/to/image.jpg") as JPEG picture)
-- TIFF 파일의 경우 (가장 범용적)
set the clipboard to (read (POSIX file "/path/to/image.tiff") as TIFF picture)
```
