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

## 아트워크(커버 이미지) — 2026-10-30 기준 (macOS 27.2, Music 1.7.2)

플레이리스트 커버는 아래 `set data of artwork 1` 로 바꾼다. **`make new artwork` 는 쓰지 마라** — 사전(sdef)엔
`artwork` 가 playlist 의 원소로 있지만 만들기는 안 된다. 2026-10-30 이 Mac 에서 실제로 실패했다:
- `make new artwork at end of artworks of p with properties {data:imgData}` → -10014
- `make new artwork at p with properties {data:imgData}` → -2710 (jrf.io 2026-03-26 글도 같은 -2710)
- `make new artwork ... with data X` 는 문법 자체가 없다(-2741).

⚠️ `count of artworks of <playlist>` 로 커버가 있는지 판단하지 마라. 이날 이 Mac 의 플레이리스트
28개가 전부 0 이었다 — 화면에 커버가 보이는 Neko's Playlist 도 0 이다. 스크립트가 플레이리스트
커버를 못 읽는 것이지, 커버가 없는 게 아니다.

**커버 바꾸기는 `set data of artwork 1` 로 된다 — 2026-10-30 이 Mac 에서 확인.** 성공해도 Music 이
"An error of type 1 has occurred. (1)" 을 낸다(jrf.io 2026-03-26 보고와 같음). 그래서 오류 1 만 삼킨다.
이 그대로 써라 — 다른 오류 번호는 그대로 올라온다. 끝나면 바뀌었는지 사용자에게 화면으로 확인받아라
(스크립트로는 커버를 읽을 수 없다).

```applescript
set imgPath to (POSIX path of (path to home folder)) & ".nekodesk/output/cover.svg.png"
set imgData to read (POSIX file imgPath) as «class PNGf»  -- JPEG 면 as JPEG picture
tell application "Music"
    try
        set data of artwork 1 of playlist "Neko's Playlist" to imgData
    on error errMsg number errNum
        if errNum is not 1 then error errMsg number errNum  -- 1 은 성공해도 나는 오류
    end try
end tell
return "커버 바꿈"
```

커버가 한 번도 없던 플레이리스트에서도 되는지는 확인 못 했다. 다른 오류가 나면 이미지를 PNG 로
저장해 두고 사용자에게 이렇게 안내해라(Apple 지원 문서, macOS 27):
Music 사이드바에서 플레이리스트 선택 → 편집 버튼(또는 더 보기 → 편집) → 추가 버튼으로 이미지 선택.
이미지 파일을 아트워크 자리에 끌어다 놓아도 된다.

- 이미지는 **PNG·JPEG 만**. SVG 는 먼저 PNG 로 굽는다(language: "shell"):
  `qlmanage -t -s 1024 -o ~/.nekodesk/output ~/.nekodesk/output/cover.svg` → `cover.svg.png`.
  같은 이름의 예전 PNG 가 남아 있을 수 있으니 방금 구운 파일을 써라.
- `read` 는 `tell application "Music"` **밖에서** 한다. `POSIX file` 은 `~` 를 못 푼다 — 홈 경로를 붙여라.
- 곡은 `set data of artwork 1 of <track> to imgData` (Doug Adams 의 iTunes 시절 방식, 이 Mac 에선 미확인).
- 다른 플레이리스트·곡의 아트워크는 바꾸지 마라.

출처: [jrf.io — ampart](https://jrf.io/posts/ampart/) ·
[Apple 지원 — Mac용 Music 에서 플레이리스트 만들기·편집](https://support.apple.com/guide/music/musd5d051981/mac)

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


---

## 문법 참고 (2026-10-30 확인)

- 앱마다 정확한 명령·속성은 그 앱의 스크립트 사전(.sdef)이 기준이다. 웹 글보다 우선한다.
  `find /System/Applications/<앱>.app /System/Library/CoreServices/<앱>.app -name "*.sdef"` 로 찾아 grep 해라
  (`sdef` 명령은 Xcode 가 있어야 돌아서 이 Mac 에선 안 된다).
- 언어 문법: [AppleScript Language Guide](https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/introduction/ASLR_intro.html) (Apple, 2016-01-25 갱신된 보관 문서)
- 자동화 예제: [Mac Automation Scripting Guide](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/index.html) (Apple, 2016-06-13 갱신된 보관 문서)
- Music 전용: [Doug's AppleScripts](https://dougscripts.com/itunes/) (Music 앱 스크립트 모음, 2026-10-29 글까지 갱신 중)
