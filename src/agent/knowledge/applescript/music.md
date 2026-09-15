# AppleScript — Music 앱 문법 가이드

## 검색어·이름 다루기
- "플리" 는 플레이리스트(Music 앱 재생목록)다. "Fly" 같은 앱 이름이 아니다.
- 사용자의 한국어 키워드(곡명·아티스트명·플레이리스트명)는 영어/로마자로 바꿔 먼저 검색하고, 실패하면 원문 한국어로 다시 시도한다. (예: "요루시카" → 먼저 "Yorushika")
- 곡명·플레이리스트명은 네가 직접 판단해 문자열로 써 넣는다. Python 으로 조합하지 않는다.

## ⚠️ AppleScript 기본 문법 — Python과 완전히 다름 (반드시 읽기)

AppleScript는 Python이 아니다. 다음 실수를 절대 하지 말 것:

```applescript
-- ❌ Python 문법 (AppleScript에서 에러)
queries = ["Lemon", "Sakura"]    -- 리스트 할당 안됨
for q in queries:                 -- 루프 안됨

-- ✅ 올바른 AppleScript 문법
set queries to {"Lemon", "Sakura"}   -- 리스트는 중괄호, set ... to 필수
set addedCount to 0                  -- 변수는 반드시 set ... to
repeat with q in queries             -- 루프는 repeat with ... in
end repeat
```

**변수 할당은 항상 `set 변수명 to 값`** — `=` 연산자는 없다.
**리스트는 `{...}` 중괄호** — `[...]` 대괄호는 유효하지 않다.
**모든 Music 명령은 `tell application "Music" ... end tell` 블록 안에** 있어야 한다.

---

## 예약어 충돌 규칙 (중요)

`name`, `artist`, `album`, `duration`, `position`, `track`, `volume`은 예약어다.
변수명으로 그대로 쓰면 에러가 난다. **접두어(track- 등)를 반드시 붙일 것.**

```applescript
-- ❌ set name to name of current track     -- 에러
-- ✅ set trackName to name of current track
-- ✅ set trackArtist to artist of current track
```

---

## 현재 재생 정보

```applescript
tell application "Music"
    set trackName   to name of current track
    set trackArtist to artist of current track
    return trackName & " - " & trackArtist
end tell
```

---

## 검색 문법 규칙 (핵심)

`search library playlist "Library" for "쿼리"` 가 유일하게 올바른 검색 문법.

⚠️ 검색 쿼리는 영어(로마자)로 먼저 시도. 결과가 없으면 한글 키워드로 재시도.

```applescript
tell application "Music"
    set results to search library playlist "Library" for "Yorushika"
    if (count of results) > 0 then
        play item 1 of results
        return "재생: " & (name of item 1 of results) & " - " & (artist of item 1 of results)
    else
        return "라이브러리에서 찾지 못했어."
    end if
end tell
```

---

## 재생 제어

```applescript
tell application "Music"
    play / pause / playpause / stop / next track / previous track
end tell
```

---

## 플레이리스트 재생

```applescript
tell application "Music"
    set plNames to name of every playlist   -- 이름 목록 확인
    play playlist "정확한 이름"
end tell
```

---

## 셔플 · 반복

```applescript
tell application "Music"
    set shuffle enabled to true / false
    set song repeat to off / one / all
end tell
```

---

## 볼륨

```applescript
tell application "Music"
    set sound volume to 80    -- 0~100 (Music 앱 전용)
end tell
-- 시스템 전체 볼륨: set volume output volume 30  (tell 블록 밖)
```

---

## 에러 처리

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

---

## 노래 추천 후 재생 — 핵심 패턴

사용자가 "노래 틀어줘", "추천해줘"라고 하면 **아래 패턴으로 바로 검색·재생**.
`display dialog` 나 `current track` 확인을 먼저 하지 말 것.

⚠️ candidates 목록은 **대화 맥락과 사용자 취향을 반영해 매번 새롭게 생성**한다.
⚠️ 아래 예시 곡명을 그대로 복사하지 말 것 — 매번 달라야 한다.

```applescript
tell application "Music"
    activate
    -- ⚠️ 아래는 예시 형식. 이 키워드를 그대로 쓰면 항상 같은 곡이 재생됨.
    -- 반드시 대화 맥락·사용자 취향에 맞는 키워드로 교체할 것.
    set candidates to {"Yorushika", "Ado", "YOASOBI"}
    repeat with candidate in candidates
        set results to search library playlist "Library" for candidate
        if (count of results) > 0 then
            set rIdx to random number from 1 to (count of results)
            set theTrack to item rIdx of results
            play theTrack
            return "재생 중: " & (name of theTrack) & " - " & (artist of theTrack)
        end if
    end repeat
    return "라이브러리에서 추천 곡을 찾지 못했어."
end tell
```

---

## 네코 전용 플레이리스트 편집 (핵심 패턴)

**네코가 편집할 수 있는 플레이리스트는 "Neko's Playlist" 단 하나.**
⚠️ 다른 플레이리스트는 절대 수정·삭제 금지. 재생만 가능.
⚠️ 새 플레이리스트 생성 금지. "Neko's Playlist"가 없을 때만 한 번 생성 가능.
⚠️ **Python으로 AppleScript를 생성하는 방식 절대 금지.**

사용자가 "플레이리스트에 추가해줘", "오늘의 플레이리스트 만들어줘" 등 요청 시:
1. 항상 `"Neko's Playlist"`를 대상으로 한다.
2. 기존 곡은 삭제하지 않는다. 새 곡만 `duplicate`로 추가.
3. 매번 검색 쿼리를 다양하게 바꿔 다른 노래가 추가되도록 한다.
4. 곡 추가 후 셔플 재생.

⚠️ `add track to playlist` 문법은 없음. 반드시 `duplicate` 사용.

**10곡 추가 완전 예시:**
```applescript
tell application "Music"
    activate
    set plName to "Neko's Playlist"

    if (count of (playlists whose name is plName)) is 0 then
        make new playlist with properties {name:plName}
    end if

    -- ⚠️ 아래 키워드는 예시. 반드시 대화 맥락·사용자 취향에 맞는 실제 키워드로 교체.
    set queries to {"Yorushika", "Indigo la End", "syudou", "Ado", "YOASOBI", "Mrs GREEN APPLE", "mol-74", "back number", "Eve", "Fujii Kaze"}
    set addedCount to 0
    set addedList to ""
    repeat with q in queries
        set results to search library playlist "Library" for q
        if (count of results) > 0 then
            set theTrack to item (random number from 1 to (count of results)) of results
            set tName to name of theTrack
            set tArtist to artist of theTrack
            -- 중복 체크: 이미 플레이리스트에 있으면 skip
            set isDupe to false
            repeat with existingTrack in (tracks of playlist plName)
                if (name of existingTrack is tName) and (artist of existingTrack is tArtist) then
                    set isDupe to true
                    exit repeat
                end if
            end repeat
            if not isDupe then
                duplicate theTrack to playlist plName
                set addedCount to addedCount + 1
                set addedList to addedList & tName & " - " & tArtist & return
            end if
        end if
    end repeat

    set shuffle enabled to true
    play playlist plName
    return (addedCount as text) & "곡 추가됨:" & return & addedList
end tell
```

---

## 음악 Discover — 라이브러리 외 곡 탐색 + 미리듣기

사용자가 "새로운 노래 찾아줘", "디스커버", "취향 맞는 노래 추천", "라이브러리에 없는 노래 틀어줘" 등 요청 시:

**라이브러리 외 전곡 재생은 불가. 반드시 아래 3단계 플로우를 사용할 것.**

### 1단계 — 라이브러리에서 취향 파악 (language: "applescript")
```applescript
tell application "Music"
    set pl to first playlist whose name is "Neko's Playlist"
    set artistList to ""
    repeat with tr in (tracks of pl)
        set artistList to artistList & (artist of tr) & ","
    end repeat
    return artistList
end tell
```

### 2단계 — iTunes API로 신규 곡 탐색 + 미리듣기 다운로드 (language: "python")

⚠️ SSL 인증서 검증 비활성화 필수 (`ctx.check_hostname = False`, `ctx.verify_mode = ssl.CERT_NONE`)
⚠️ 앨범아트는 반드시 `/tmp/neko_output.png` 로 저장 → 채팅창에 자동 표시됨
⚠️ 미리듣기는 `/tmp/neko_preview.mp3` 로 저장
⚠️ 라이브러리 아티스트와 **다른** 아티스트 위주로 탐색할 것 (Discover 목적)
⚠️ `country=jp` 파라미터로 J-Pop 결과 우선

```python
import urllib.request, urllib.parse, json, ssl, random

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

# 사용자 취향 기반 탐색 쿼리 (대화 맥락 반영, 매번 다르게)
# 예시: 라이브러리에 YOASOBI 있으면 → 비슷한 J-Pop 아티스트로 탐색
discovery_queries = ["Fujii Kaze", "mol-74", "Uru", "Aimer", "King Gnu"]  # ⚠️ 매번 다르게 생성

found = None
for query_str in discovery_queries:
    query = urllib.parse.quote(query_str)
    url = f"https://itunes.apple.com/search?term={query}&media=music&entity=song&limit=20&country=jp"
    with urllib.request.urlopen(url, timeout=5, context=ctx) as r:
        data = json.loads(r.read())
    results = [r for r in data.get("results", []) if r.get("previewUrl")]
    if results:
        found = random.choice(results)
        break

if not found:
    print("NOTFOUND")
else:
    preview_url = found["previewUrl"]
    artwork_url = found.get("artworkUrl100", "").replace("100x100bb", "500x500bb")
    track_name = found.get("trackName", "")
    artist_name = found.get("artistName", "")
    collection_name = found.get("collectionName", "")
    track_view_url = found.get("trackViewUrl", "")

    # 미리듣기 MP3 다운로드
    with urllib.request.urlopen(preview_url, context=ctx) as r:
        with open("/tmp/neko_preview.mp3", "wb") as f:
            f.write(r.read())

    # 앨범아트 다운로드 (채팅창 자동 표시)
    with urllib.request.urlopen(artwork_url, context=ctx) as r:
        with open("/tmp/neko_output.png", "wb") as f:
            f.write(r.read())

    print(f"TRACK:{track_name}")
    print(f"ARTIST:{artist_name}")
    print(f"ALBUM:{collection_name}")
    print(f"URL:{track_view_url}")
```

### 3단계 — 미리듣기 재생 (language: "shell")
```shell
afplay /tmp/neko_preview.mp3 &
echo "playing"
```

### finalAnswer 형식
- 곡명, 아티스트, 앨범 표시
- 30초 미리듣기 링크: `[🎵 30초 미리듣기](previewUrl)`
- Apple Music 링크: `[Apple Music에서 듣기](trackViewUrl)`
- 앨범아트는 이미 채팅창에 표시되므로 별도 언급 불필요
- previewUrl, trackViewUrl 모두 Python 실행 결과에서 가져온 값만 사용 (절대 만들어내지 말 것)

---

## display dialog 사용 금지

```applescript
-- ❌ display dialog "재생 중: " & trackName buttons {"확인"} default button 1
-- ✅ return "재생 중: " & trackName
```

결과는 항상 `return "문자열"` 로 반환한다.
