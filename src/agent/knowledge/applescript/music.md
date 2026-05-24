# AppleScript — Music 앱 문법 가이드

## tell 블록 기본 구조

```applescript
tell application "Music"
    -- 여기서 Music 앱의 모든 명령·속성에 접근 가능
end tell
```

한 줄로도 가능:
```applescript
tell application "Music" to playpause
```

---

## 예약어 충돌 규칙 (중요)

AppleScript에서 `name`, `artist`, `album`, `duration`, `position`, `track`, `volume`은
**언어 예약어이자 앱 속성 이름**이다.
이것들을 변수명으로 그대로 쓰면 "속성을 set하려는 명령"으로 해석되어 에러가 난다.

```applescript
-- ❌ 잘못된 예: 예약어를 변수명으로 사용
set name to name of current track     -- 에러: Can't set name
set duration to duration of t         -- 에러: Can't set duration
set position to player position       -- 에러

-- ✅ 올바른 예: 접두어를 붙여 변수명 구분
set trackName to name of current track
set trackDuration to duration of current track
set trackPosition to player position
```

**규칙: Music 속성 이름(name, artist, album, duration, position, rating, loved 등)을
변수명으로 쓸 때는 반드시 접두어(track-, my- 등)를 붙일 것.**

---

## 현재 재생 정보 읽기

```applescript
tell application "Music"
    set trackName     to name of current track
    set trackArtist   to artist of current track
    set trackAlbum    to album of current track
    set trackDuration to duration of current track   -- 초 단위 실수
    set trackPosition to player position             -- 초 단위 실수
    return trackName & " - " & trackArtist
end tell
```

속성 한 줄로 바로 반환할 때는 변수 불필요:
```applescript
tell application "Music" to get name of current track
```

---

## 검색 문법 규칙

`search library playlist "Library" for "쿼리"` 가 유일한 올바른 검색 문법.
`get search results for query` 같은 문법은 존재하지 않는다.

```applescript
tell application "Music"
    set results to search library playlist "Library" for "요루시카"
    -- results는 track 객체의 리스트
    if (count of results) > 0 then
        play item 1 of results
    end if
end tell
```

검색 결과가 없을 때 `item 1 of results`를 호출하면 에러가 나므로
`count` 확인이 필수다.

---

## 재생 제어

```applescript
tell application "Music"
    play             -- 재생 시작 (또는 재개)
    pause            -- 일시정지
    playpause        -- 재생/일시정지 토글
    stop             -- 정지
    next track       -- 다음 곡
    previous track   -- 이전 곡
end tell
```

---

## 플레이리스트 재생

```applescript
tell application "Music"
    play playlist "내 플레이리스트"
end tell
```

플레이리스트 이름이 정확히 일치해야 한다. 존재하지 않으면 에러.
이름 확인 먼저:
```applescript
tell application "Music"
    set plNames to name of every playlist
    return plNames  -- 리스트 반환
end tell
```

---

## 셔플 · 반복

```applescript
tell application "Music"
    set shuffle enabled to true    -- 셔플 켜기
    set shuffle enabled to false   -- 셔플 끄기

    set song repeat to off         -- 반복 없음
    set song repeat to one         -- 한 곡 반복
    set song repeat to all         -- 전체 반복
end tell
```

---

## 볼륨 (Music 앱 자체 볼륨, 시스템 볼륨과 별개)

```applescript
tell application "Music"
    set sound volume to 80    -- 0~100 정수
    get sound volume
end tell
```

시스템 전체 볼륨은 `set volume output volume 30` (tell 블록 밖에서 사용).

---

## 좋아요 · 평점

```applescript
tell application "Music"
    set loved of current track to true     -- 좋아요
    set rating of current track to 100     -- 평점 0~100
end tell
```

`loved`, `rating`도 예약어이므로 변수명으로 쓰지 말 것.

---

## 에러 처리

Music 앱이 꺼져있거나 재생 중인 곡이 없을 때 `current track`에 접근하면 에러 발생.
`try`로 감싸는 것이 안전하다:

```applescript
tell application "Music"
    try
        set trackName to name of current track
        return trackName
    on error errMsg
        return "재생 중인 곡 없음: " & errMsg
    end try
end tell
```
