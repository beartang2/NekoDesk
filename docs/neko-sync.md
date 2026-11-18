# 네코 동기화 — 맥·아이폰에서 같은 네코, 같은 대화

상태: 설계(1단계). 구현 전 승인 필요. 2026-11-18.
관련 문서: `docs/neko-gifts.md`(선물함), `docs/neko-screen-mode.md`(네코 자리).

맥북을 덮어도 아이폰에서 같은 대화를 이어 가고, 맥을 다시 열면 폰에서 한 말이 보인다.
아무 기기도 안 쓰는 동안에도 네코는 산책을 다녀오고, 폰에 알림이 온다.

"미확인"이라고 적은 것은 코드나 문서로 확인하지 못한 것이다. 추측으로 채우지 않았다.

---

## 0. 한눈에

- **기기**: 맥북(지금 앱), 아이폰 13 미니, 아이폰 17. 각 기기는 오프라인에서도 혼자 동작하고, 연결되면 맞춘다.
- **서버**: 사용자의 Cloudflare 계정에 Worker 하나 + D1 하나(무료 플랜). 코드는 `server/`, wrangler 로 배포.
  - 배포와 `wrangler secret` 은 사용자가 한다. 세션은 `wrangler dev` 로컬 검증까지만.
- **암호화**: 대화·기억·할 일·선물은 기기에서 암호화해 올린다. 서버는 암호문과 최소한의 머리 정보만 가진다.
  - 열쇠(32바이트)는 기기 키체인에만 있다. 맥에서 만들고, 폰에는 짝 맞추기 코드로 넘긴다.
- **동기화**: 모든 것을 "기록(record)" 하나로 본다. 서버는 기록마다 순번(seq)을 매기고, 기기는 "이 순번 뒤로 바뀐 것"만 받는다.
  - 대화 메시지는 덧붙기만 한다(고치지 않는다). 나머지는 항목별로 나중에 쓴 쪽이 이긴다.
  - 주고받기는 폴링이다. 웹소켓·푸시는 쓰지 않는다.
- **서버 산책**: cron 이 10분마다 깨어, 끼니 시간대인데 아무 기기도 안 쓰고 있고 그 끼니 산책을 아무도 안 나갔으면 서버가 나간다.
  - 서버는 대화·사용자 기억을 보지 않는다. 위치·네코 이름·성격 글·근처 장소 목록만 평문으로 가진다.
  - 결과는 서버에 잠깐 평문으로 있다가, 처음 받은 기기가 대화에 적고(암호화) 서버 것을 지운다.
- **알림**: Worker → ntfy.sh → 아이폰의 ntfy 앱. 본문은 고정 문장("네코가 돌아왔어")뿐이다.
- **폰 앱**: 같은 Tauri 2 프로젝트를 iOS 로 빌드한다. 무료 계정이라 7일마다 맥에서 스크립트로 다시 빌드·설치한다.
- **순서**: 1) 설계(이 문서) → 2) Worker + 맥 동기화 → 3) iOS 앱 → 4) 서버 산책 + 알림.

---

## 1. 지금 구조 (코드에서 확인한 것)

### 1.1 어디에 무엇이 있나

| 무엇 | 어디 | 식별자 | 비고 |
|---|---|---|---|
| 대화 메시지 | SQLCipher DB `conversation_messages` (`src-tauri/src/db/conversations.rs`) | `id INTEGER AUTOINCREMENT` + `session_id TEXT` | 열: role, content, created_at, attachments(JSON), meta(JSON). 세션당 최근 5000개만 남긴다(`MAX_PER_SESSION`) |
| 세션 목록 | localStorage `nekodesk_sessions` (`src/stores/sessionStore.ts`) | `id`(UUID), `title`, `date` | 배열 순서가 곧 목록 순서(새 대화가 앞). 지금 열린 세션은 `nekodesk_active_session` |
| 대화 요약(수동) | localStorage `nekodesk_compact_<세션 id>` (`src/App.tsx`) | 세션 id | 수동 요약은 요약을 저장한 뒤 **그 세션의 DB 메시지를 전부 지운다**(`conversationApi.delete`) |
| 대화 요약(자동) | DB 메시지 한 줄, `meta.compacted = true` (`src/hooks/useAgentLoop.ts` `autoCompact`) | — | 앞 대화는 그대로 남고 모델에만 요약 뒤쪽이 간다 |
| 기억 | DB `memories` (`db/memories.rs`) | `id INTEGER`, `content UNIQUE` | kind(`fact`·`neko` 등), use_count, last_used_at. 500개 넘으면 덜 쓰인 것부터 지운다 |
| 할 일 | DB `todos` (`db/todos.rs`) | `id INTEGER` | 추가·완료만 있다(삭제 없음) |
| 일정 | DB `events` (`db/events.rs`) | `id INTEGER` | 추가·삭제 |
| 설정(키-값) | DB `settings` (`db/settings.rs`) | key | `updated_at` 열이 있다 |
| 선물함 | settings 키 `neko_gifts` — JSON 배열 하나 (`src/neko/gifts.ts`) | 선물마다 `id` | `{id, at, title, body, shape, play?, size?, placed?, lastPlayed?}`, 최대 100개 |
| 선물 종류 이력 | settings 키 `neko_gift_history` (`src/agent/walk.ts`) | — | 최근 5개 종류, 그림 그린 날 |
| 네코 외형 | settings 키 `neko_appearance` + localStorage 같은 키 (`src/neko/nekoStore.ts`) | — | 털색·무늬·눈 등 |
| 네코 자리 | settings 키 `neko_stage` | — | 사이드바/독/화면, 높이·크기. 맥 화면에 묶인 값 |
| 산책 상태 | settings 키 `neko_walk` (`src/App.tsx` `WALK_KEY`) | — | `Walk` 한 개(경로·들른 곳·done·pin) |
| 네코 이름·성격·사용자 프로필 | localStorage `nekodesk_neko_name`·`nekodesk_system_prompt`·`nekodesk_user_profile` (`src/stores/settingsStore.ts`) | — | |
| 오래된 대화 지우기 설정 | localStorage `nekodesk_session_retention` | — | 끔·30일·90일 |
| Claude 예산·장부 | localStorage `nekodesk_claude_budget`·`nekodesk_claude_usage` (`src/stores/claudeBudget.ts`) | — | 기기 안에서만 센다 |
| API 키 | macOS 키체인, 서비스 `com.nekodesk.desktop` (`src-tauri/src/secrets.rs`) | `anthropic_api_key` 등 | 화면(webview)에는 값을 안 준다 |
| DB 열쇠 | 키체인 `db_key`(32바이트 hex) | — | `secrets.rs` 의 키체인 구현은 `#[cfg(target_os = "macos")]` 뿐이고 다른 OS 는 오류를 돌려준다 |

걸리는 점

- **메시지에 기기 간 고유 번호가 없다.** DB 는 자동 증가 정수이고, 화면은 불러올 때마다 `crypto.randomUUID()` 를 새로 붙인다(`App.tsx` 메시지 로드).
- 기억·할 일·일정도 정수 id 라 두 기기에서 따로 만들면 번호가 겹친다.
- 세션 목록·요약·이름·성격이 localStorage 에 있어 Rust 가 못 읽는다.
- 선물함은 배열 하나를 통째로 덮어쓴다. 두 기기가 따로 받으면 한쪽 선물이 사라진다.
- 메시지의 `attachments`·`meta.images` 에 그림이 dataUrl(base64)로 통째로 들어 있다. 한 줄이 수 MB 가 될 수 있다.

### 1.2 산책

- 조건(`src/lib/walk.ts`, 이 브랜치에 이미 들어와 있다)
  - 정기 산책: 아침 7–9시·점심 12–14시·저녁 18–20시(로컬) 한 번씩. 그 시간대에 졸고 있으면(5분 조용, `SLEEPY_MS`) 바로 나간다.
  - 추가 산책: 졸기 시작하고 5–20분 더 조용하고, 지난 산책이 끝나고 2시간(`WALK_GAP_MS`) 지났을 때.
  - 꺼져 있던 시간대는 따라잡지 않는다.
- 출발(`src/App.tsx` `departRef`): 게임 중·밥 먹는 중·Claude 프로필 아님·예산 초과·지난 보고 대기 중이면 안 나간다.
  - 위치 `hereOnce()`(`src/components/MapCard.tsx`) → `mapApi.places`(반경 800m) → `pickPlaces` → `mapApi.walkRoute`(MapKit 걷기 경로).
  - 길을 못 구하면 `fallbackLegs()`(지도 없는 대체 경로). 산책은 30분(`WALK_MS`).
  - 경로는 떠날 때 다 정해 `neko_walk` 에 저장한다. 지금 자리는 시각만으로 구한다(`positionAt`).
- 머리(`src/agent/walk.ts` `startWalkBrain`)
  1. 조사: `runSubagent`(도구는 `web.search`·`weather.get` 만). 입력은 네코 이름, 지나온 곳 이름, 성격 글, `neko` 종류 기억 최근 5개.
  2. 선물 종류를 코드가 굴린다(`rollGift`). 재료도 코드가 마련한다(장소·날씨·사용자 기억 하나).
  3. 보고: `walk_report` 툴 한 번(알게 된 것·일지·선물 글·선물 모양).
     주운 것·기념품이면 모양을 캔버스에 그려 PNG 로 보여 주고 한 번 고치게 한다(`refineShape`).
  4. 그림 선물이면 `image.generate` 로 그려 임시 보관함(shelf)에 넣는다.
  5. 인상 깊은 것 하나를 기억(`neko` 종류)으로 저장한다.
- 도착: 일지를 **지금 열린 세션**에 assistant 메시지로 붙이고(`meta.prompt` 에 단기기억), 선물은 선물함에 넣는다.
- 사용자가 돌아오면 남은 길을 버리고 1–2분 안에 온다(`hurryHome`). 머리는 그때까지 모은 것으로 보고한다.

### 1.3 LLM 호출

- 나가는 문은 `src/agent/llm-transport.ts` 하나다. Claude 프로필이면 공식 SDK(`@anthropic-ai/sdk`)로 요청을 만들고, 전송만 Rust `claude_proxy`(`src-tauri/src/claude.rs`)가 한다. Rust 가 키체인의 키를 붙인다.
- 웹 검색은 Claude 프로필이면 Claude 내장 검색(`claudeWebSearch`, 모델은 `WEB_SEARCH_MODEL = claude-haiku-5-5`, 툴 `web_search_20250305`). 아니면 Rust `web_search`(Brave 키).
- 날씨는 Rust `http/weather.rs` 가 open-meteo 를 부른다(키 없음).
- 툴 목록은 `ToolName`(`src/agent/types.ts`)과 `tool-registry.ts` 의 REGISTRY 에만 있다.

### 1.4 빌드 환경

- Tauri 2.10, 식별자 `com.nekodesk.desktop`. 창 둘(`main`, `quick`) + 실행 중 만드는 창들.
- `Cargo.toml`: `tauri` 에 `macos-private-api`, 플러그인 global-shortcut·drag·updater·notification. MapKit·CoreLocation·AppKit 의존은 `cfg(target_os = "macos")` 아래.
- `src-tauri/gen/apple` 없음(`tauri ios init` 을 한 적 없다).
- 이 맥에는 **Xcode 앱이 없다**(명령줄 도구만). Rust 타깃도 `aarch64-apple-darwin` 하나다. wrangler 도 전역 설치돼 있지 않다(`npx` 로 쓰면 된다).

---

## 2. 동기화 모델

### 2.1 기록 하나로 본다

서버는 종류를 모른다. 전부 같은 모양의 기록이다.

| 칸 | 뜻 | 서버가 읽나 |
|---|---|---|
| `coll` | 종류: `session`·`msg`·`memory`·`todo`·`event`·`gift`·`setting` | 읽음 |
| `id` | 기록 번호(UUID). `setting` 은 키 이름 | 읽음 |
| `parent` | `msg` 만: 세션 id | 읽음 |
| `ts` | 마지막으로 바꾼 시각(ms, 기기 시계) | 읽음 |
| `device` | 마지막으로 바꾼 기기 id | 읽음 |
| `deleted` | 지움 표시(tombstone) | 읽음 |
| `cut` | `session` 만: 이 시각까지의 메시지는 지워졌다 | 읽음 |
| `blob` | 내용(암호문) | **못 읽음** |
| `seq` | 서버가 매기는 순번 | 서버가 만듦 |

- 기기는 마지막으로 받은 `seq` 를 기억하고 "그 뒤로 바뀐 것"만 받는다.
- `ts` 는 `max(지금, 내가 마지막으로 쓴 ts + 1)` 로 매긴다. 시계가 잠깐 뒤로 가도 자기 기록끼리는 순서가 안 뒤집힌다.
- 겨루기: `(ts, device)` 가 큰 쪽이 이긴다. 서버가 판정한다(진 쓰기는 버리고, 이긴 현재 값을 돌려준다).

### 2.2 무엇을 어떻게 맞추나

| 종류 | 단위 | 규칙 | 암호문 안에 든 것 |
|---|---|---|---|
| 대화 메시지 `msg` | 메시지 하나 | **덧붙기만.** 한번 올린 것은 안 고친다. 지우는 건 세션의 `cut`·`deleted` 로만 | role, content, created_at, attachments, meta |
| 세션 `session` | 세션 하나 | 나중 쓴 쪽이 이김 | title, createdAt, 수동 요약(summary) |
| 기억 `memory` | 기억 하나 | 나중 쓴 쪽이 이김. 받은 뒤 **같은 내용이면 하나로 합친다**(id 가 작은 쪽을 남기고 다른 쪽은 지움 표시) | kind, content, created_at |
| 할 일 `todo` | 할 일 하나 | 나중 쓴 쪽이 이김 | content, status, due_at, completed_at … |
| 일정 `event` | 일정 하나 | 나중 쓴 쪽이 이김 | title, start_at, end_at … |
| 선물 `gift` | 선물 하나 | 나중 쓴 쪽이 이김 | title, body, shape, play, size, at, placed |
| 설정 `setting` | 키 하나 | 나중 쓴 쪽이 이김 | 값 |

맞추는 설정 키

- `neko_appearance`(외형), `neko_name`(이름), `neko_persona`(성격과 말투), `user_profile`(사용자 프로필), `session_retention`(오래된 대화 지우기).
- 이름·성격·프로필·지우기 설정은 지금 localStorage 에 있다. 2단계에서 settings DB 로 옮기고, 화면은 nekoStore 처럼 localStorage 를 먼저 읽고 DB 값으로 덮는다.

맞추지 않는 것

- 네코 자리(`neko_stage`): 기기 화면에 묶인 값이다.
- 지금 열린 세션, 지도 접힘 같은 화면 상태.
- 모델 프로필·API 키·Claude 예산과 장부(§10 에 물음).
- 기억의 `use_count`·`last_used_at`, 선물의 `lastPlayed`: 자주 바뀌고 기기마다 달라도 된다. 이것만 바뀌면 올리지 않는다.
- 실행 기록(`exec_history`), 임시 보관함(shelf), 용어집(`terms`): 맥 전용이다.

할 일·일정은 요청에 "할 일"만 있었지만 같은 방식이라 일정도 넣었다. 빼도 된다(§10).

### 2.3 메시지 순서

- 한 세션의 메시지는 `(ts, device, id)` 순으로 늘어놓는다.
- 두 기기가 오프라인에서 같은 세션에 각자 말하면, 만났을 때 시각순으로 섞인다. 고치지 않는다. 한 사람이 쓰는 앱이라 드물다.
- 스트리밍 중인 답은 올리지 않는다. 지금처럼 DB 에 저장되는 시점(답이 끝난 뒤)에 올린다.

### 2.4 지우기

- 세션 삭제(사용자가 지움): `session` 기록에 `deleted = 1`. 서버는 그 세션의 메시지를 지운다. 다른 기기는 받으면 로컬 메시지·요약을 지운다. **지운 쪽이 이긴다.**
- 수동 요약: `session` 기록의 summary 를 바꾸고 `cut = 지금`. 서버와 다른 기기는 `ts <= cut` 인 그 세션 메시지를 지운다.
- 지움 표시는 서버에 90일 둔다. 그보다 오래 안 맞춘 기기는 처음부터 다시 받는다(서버가 `reset` 을 돌려준다).
- 세션당 5000개 자르기는 지금처럼 기기 안에서만 한다. 서버 쪽은 자르지 않는다(§9 위험).

### 2.5 "30일 지난 대화 자동 삭제"와의 관계

지금은 앱을 켤 때 `pruneOldSessions` 가 마지막 메시지가 N일 지난 세션을 지운다(열린 세션·빈 세션·기억은 남김).

- 위험: 오래 꺼 둔 기기(예: 13 미니를 40일 만에 켬)가 자기 눈에 오래된 세션을, 다른 기기가 어제 쓴 줄 모르고 지울 수 있다.
- 규칙
  1. **이번 실행에서 동기화를 한 번 끝낸 뒤에만** 자동 삭제를 돈다. 오프라인이면 그날은 안 지운다.
  2. 자동 삭제의 지움 표시에는 `reason: "prune"` 과 기준 시각을 붙인다. 서버는 그 세션에 기준보다 새 메시지가 있으면 거절한다(메시지의 `ts` 는 서버가 읽을 수 있다).
  3. 자동 삭제 지움 표시를 받았는데 아직 못 올린 새 메시지가 그 세션에 있으면, 세션을 되살려 올린다. 사용자가 직접 지운 것은 되살리지 않는다.
  4. 지우기 설정(끔·30·90일)은 기기끼리 맞춘다. 안 맞추면 가장 짧은 기기가 다 지운다.
- 다른 기기에서 열려 있던 세션이 지워져 오면, 그 기기는 남은 세션(없으면 새 대화)으로 옮긴다.

### 2.6 기기 쪽 구현 방향 (2단계)

- 동기화는 **Rust** 에서 한다. DB·HTTP(`reqwest`)·키체인이 다 Rust 에 있고, 열쇠가 화면으로 안 넘어온다.
- 기존 표는 고치지 않는다(`db/mod.rs` 의 규칙: 배포된 마이그레이션은 안 고친다). 마이그레이션 4번으로 표를 더한다.
  - `sync_meta(coll, local_key, uid, ts, device, deleted, dirty)`: 로컬 행 ↔ 기록 번호. 지움 표시와 "아직 안 올림"도 여기 둔다.
  - `sync_state(key, value)`: 기기 id, 마지막 seq.
  - `sessions(id, title, created_at, summary)`: localStorage 의 세션 목록·수동 요약을 옮긴다. 처음 한 번 localStorage 에서 옮겨 온다.
- 선물함은 저장 모양(`neko_gifts` 배열)을 그대로 두고, 동기화할 때만 선물 하나씩으로 쪼개고 합친다.
- 쓰는 곳(`conversations::save`, `memories::save` …)이 `sync_meta` 에 dirty 를 찍는다. 주기 작업이 dirty 를 모아 올리고, 받은 것을 적용한 뒤 화면에 Tauri 이벤트 `sync-changed` 를 보낸다. 스토어는 그걸 듣고 다시 읽는다.
- 주기: 앱을 쓰는 중엔 15초마다 + 로컬에서 쓴 직후. 조용하면 5분마다. 앱이 앞에 나올 때 한 번.
- 처음 켤 때: 지금 있는 대화·기억을 전부 dirty 로 찍고 나눠 올린다. 중간에 끊겨도 이어서 한다.

---

## 3. 암호화

### 3.1 열쇠

- **동기화 열쇠** 하나(무작위 32바이트). 맥이 처음 동기화를 켤 때 만들어 키체인에 넣는다(`sync_key`, DB 열쇠처럼 화면에서 못 읽는 이름).
- 기록마다 XChaCha20-Poly1305 로 잠근다(무작위 24바이트 nonce). Rust 크레이트 `chacha20poly1305` 를 더한다. 암호를 손으로 짜지 않는다.
- 머리 정보(`coll|id|parent|ts|device`)를 덧붙임 자료(AAD)로 묶는다. 서버가 암호문을 다른 기록에 바꿔 끼우면 풀리지 않는다.
- DB 열쇠(`db_key`)와는 다른 열쇠다. DB 열쇠는 기기 밖으로 안 나간다.

### 3.2 폰에 넘기기 (짝 맞추기)

1. 맥 설정 › 동기화에서 '기기 추가'. 맥이 서버에 1회용 짝 코드를 받는다(10분 유효).
2. 맥이 **짝 문자열**을 만든다: 서버 주소 + 짝 코드 + 동기화 열쇠(+ 고르면 Claude API 키, §6.4).
3. 폰으로 넘긴다.
   - 기본: '복사' → 아이폰 앱의 입력 칸에 붙여넣기. 같은 Apple ID 면 공통 클립보드로 넘어간다. 새 코드가 필요 없다.
   - 선택: QR 로도 보여 준다. 아이폰 카메라로 찍어 앱을 여는 방식은 URL 스킴 등록이 필요하다(3단계에서 정함, §10).
4. 폰이 짝 코드로 서버에 기기를 등록하고 자기 토큰을 받는다. 열쇠·토큰을 iOS 키체인에 넣는다.

- 짝 문자열은 화면에 잠깐만 보이고, 서버에는 안 올라간다.
- 폰을 잃어버리면: 맥에서 그 기기 토큰을 끊는다. 열쇠는 폰에 남으므로 **열쇠 바꾸기**(서버 기록을 비우고 맥이 새 열쇠로 다시 올림)도 한다. 남은 폰은 다시 짝을 맞춘다.

### 3.3 무엇이 암호문이고 무엇이 평문인가

| 서버가 가진 것 | 형태 | 왜 |
|---|---|---|
| 대화 내용·첨부·도구 기록 | 암호문 | |
| 세션 제목·수동 요약 | 암호문 | |
| 기억·할 일·일정 내용 | 암호문 | |
| 선물(이름·글·모양·놓인 자리) | 암호문 | |
| 설정 값(외형·이름·성격·사용자 프로필) | 암호문 | |
| 기록의 종류·번호·세션 묶음·시각·기기·크기·지움 여부 | **평문** | 순번을 매기고 겨루기·삭제를 하려면 필요하다. "언제 몇 개의 메시지가 어느 묶음에"는 드러난다 |
| 기기 이름·마지막 접속/사용 시각, 토큰의 해시 | **평문** | 인증, 서버 산책 조건 |
| 산책 프로필: 집 위치(소수 셋째 자리까지), 시간대, 네코 이름, 성격 글, 근처 장소 목록 | **평문** | 서버가 산책하려면 필요하다(사용자 결정). 동기화 설정과 **따로** 올린다 |
| 서버 산책 결과(일지·선물 글·모양) | **평문, 잠깐** | 기기가 받아 가면 지운다. 웹에서 알아본 것뿐이고 대화·기억에서 온 건 없다 |
| 서버 산책 장부(쓴 돈·횟수), ntfy 토픽 | **평문** | |
| Claude API 키(서버용) | Worker secret | 사용자가 `wrangler secret put` 으로 넣는다 |

- 성격 글(`nekodesk_system_prompt`)은 사용자가 쓴 글이다. 서버 산책에 쓰려면 평문으로 올라간다. 싫으면 프로필에서 빼고 서버 산책은 기본 말투로 한다(§10).
- 사용자 프로필(`nekodesk_user_profile`)과 사용자 기억은 서버 산책에 쓰지 않는다. 평문으로 안 올린다.

---

## 4. Worker API

### 4.1 인증

- 기기마다 토큰(무작위 32바이트). 서버는 SHA-256 해시만 둔다. 요청에 `Authorization: Bearer <토큰>`.
- 첫 기기(맥) 등록: Worker secret `SETUP_TOKEN`(사용자가 배포 때 정함)을 맥 설정에 한 번 넣는다.
- 다음 기기: 이미 등록된 기기가 낸 1회용 짝 코드로 등록한다. 폰은 `SETUP_TOKEN` 을 모른다.
- 한 사람용 서버다. 계정 개념은 없다.

### 4.2 엔드포인트

| 메서드·경로 | 하는 일 |
|---|---|
| `GET /v1/health` | 살아 있나(인증 없음, 내용 없음) |
| `POST /v1/devices` | 기기 등록. `{name, setup_token \| pair_code}` → `{device_id, token}` |
| `POST /v1/pair` | 짝 코드 발급 → `{code, expires}` |
| `GET /v1/devices` · `DELETE /v1/devices/:id` | 기기 목록·끊기 |
| `POST /v1/sync` | 올리기 + 받기 한 번에. `{since, push: [기록…], active_at}` → `{records: […], seq, more, rejected: […], walk}` |
| `PUT /v1/walk/profile` | 산책 프로필(평문) 올리기. 서버 산책 켬/끔, ntfy 토픽 포함 |
| `POST /v1/walk/claim` | "내가 나간다" 찜. `{slot \| null, start, end}` → `{ok}` (§5.4) |
| `POST /v1/walk/hurry` | 서버 산책 중에 사용자가 돌아왔다. 곧 오게 한다 |
| `POST /v1/walk/ack` | 서버 산책 결과를 내가 받았다. 처음 부른 기기만 결과를 받고, 서버는 지운다 |
| `POST /v1/reset` | 열쇠 바꾸기용: 기록 전부 지우기(기기·프로필은 남김) |

- `sync` 한 번에 올리는 기록은 20개까지, 받는 것은 200개 또는 1MB 까지. 더 있으면 `more`.
- 기록 하나의 암호문은 1MB 까지(D1 한 행 2MB 한도 아래).
  - 넘으면 첨부·`meta.images` 의 그림 본문(dataUrl)을 빼고 이름·종류·크기만 올린다. 다른 기기에선 "맥에 있는 그림"으로 보인다(§10).
- `sync` 응답의 `walk` 에 산책 상태(나가 있나, 언제 오나, 지난 산책 시작·끝, 결과 대기)를 싣는다. 따로 묻는 요청을 줄인다.
- `active_at` 은 사용자가 마지막으로 앱을 만진 시각(`useNekoApp.lastActiveAt`)이다. 폴링 자체는 활동이 아니다.

### 4.3 D1 스키마

```sql
CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_seen INTEGER, last_active INTEGER, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE pair_codes (code_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
CREATE TABLE records (
  coll TEXT NOT NULL, id TEXT NOT NULL, parent TEXT,
  ts INTEGER NOT NULL, device TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, cut INTEGER,
  blob BLOB, seq INTEGER NOT NULL,
  PRIMARY KEY (coll, id)
);
CREATE INDEX records_seq ON records (seq);
CREATE INDEX records_parent ON records (parent, ts);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- seq 카운터, 산책 프로필, 서버 장부, ntfy 토픽
CREATE TABLE walks (
  slot TEXT PRIMARY KEY,           -- '2026-11-18/점심' 또는 'extra/<시작 ms>'
  by TEXT NOT NULL,                -- 기기 id 또는 'server'
  start INTEGER NOT NULL, "end" INTEGER NOT NULL,
  status TEXT NOT NULL,            -- away | ready | done
  result TEXT, cost_usd REAL
);
```

- `seq` 는 `meta` 의 카운터를 같은 batch 안에서 올려 매긴다.
- 지움 표시(90일)와 끝난 `walks` 행은 cron 이 하루 한 번 치운다.

### 4.4 무료 플랜 한도와 여유

2026-11-18 에 Cloudflare 문서에서 확인한 값이다. **배포 전에 다시 확인한다.**

| 한도 | 값 | 우리 쓰임(어림) | 여유 |
|---|---|---|---|
| Worker 요청 | 하루 100,000 | 기기 셋이 쓰는 중 15초 폴링 ≈ 하루 2,000–4,000, cron 144 | 넉넉 |
| CPU 시간 | 요청·cron 한 번에 10ms | 동기화는 JSON 풀기 + D1(대기는 CPU 가 아님). 서버 산책은 Claude 응답 풀기 | **빠듯할 수 있다. 배포 후 재야 한다**(§9) |
| cron 한 번의 벽시계 시간 | 15분 | 서버 산책 한 번 1–2분 | 넉넉 |
| 하위 요청 | 요청 한 번에 50 | 서버 산책: Claude 2–4번, 날씨 1번, ntfy 1번 | 넉넉 |
| Cron Trigger | 계정에 5개 | 1개(`*/10 * * * *`) | 기존 계정이 이미 몇 개 쓰는지 **미확인** |
| D1 크기 | DB 하나 500MB, 계정 5GB | 글 한 번 주고받기 ≈ 1–2KB | 글만이면 수십만 메시지. 그림을 올리면 금방 찬다 |
| D1 읽기 | 하루 500만 행 | 폴링마다 색인으로 몇 행 | 넉넉 |
| D1 쓰기 | 하루 10만 행 | 하루 수백 행. **처음 올릴 때**만 많다 | 처음 올리기는 하루 2만 행 아래로 나눠 올린다. 색인 쓰기가 따로 세지는지 **미확인** |
| D1 호출 수 | Worker 한 번에 50 쿼리 | `sync` 는 batch 로 묶는다 | batch 가 몇 쿼리로 세지는지 **미확인** |
| D1 바인딩 | 쿼리 하나에 100개 | 기록 하나에 9칸 | 한 문장에 10행까지 |
| D1 한 행 | 2MB | 암호문 1MB 상한 | 맞음 |

- 한도를 넘으면 D1 은 그날 쿼리를 거절한다(UTC 0시에 풀림). 기기는 혼자 동작하고 다음에 다시 맞춘다.

### 4.5 `server/` 폴더

```
server/
  wrangler.toml        # Worker 이름, D1 바인딩, cron, vars(WALK_MODEL, WALK_BUDGET_USD)
  schema.sql
  package.json         # wrangler, @anthropic-ai/sdk
  src/index.ts         # 라우팅 + 인증
  src/sync.ts          # 올리기·받기·겨루기·삭제
  src/walk.ts          # 4단계: cron, 산책 머리
  test/sync.mjs        # wrangler dev 에 대고 도는 확인 스크립트
```

- secret: `SETUP_TOKEN`(2단계), `ANTHROPIC_API_KEY`(4단계). 둘 다 사용자가 넣는다.
- 산책 경로 계산(`src/lib/walk.ts`)과 선물 굴리기(`giftWeights`·`rollGift`)는 순수 함수라 앱 코드를 그대로 가져다 쓴다. 복사하지 않는다.

---

## 5. 서버 산책

### 5.1 언제 나가나

cron 이 10분마다 깬다. 아래가 다 맞을 때만 나간다.

1. 산책 프로필에서 서버 산책이 켜져 있다.
2. 프로필의 시간대로 지금이 끼니 시간대다(7–9, 12–14, 18–20시 — `ROUTINE_HOURS` 를 같이 쓴다).
3. 시간대가 시작하고 **15분이 지났다.** 깨어 있는 맥이 졸다가 먼저 나갈 틈을 준다.
4. 그 끼니(`날짜/이름`)를 아무도 안 나갔다(`walks` 에 행이 없다). 진행 중인 산책도 없다.
5. 어느 기기도 최근 10분 안에 사용자가 만지지 않았다(`devices.last_active`).
6. 이번 달 서버 예산이 남았다(§5.6).

- 서버는 **정기 산책만** 한다(하루 최대 3번). 2시간 간격 추가 산책은 지금처럼 켜져 있는 맥만 한다(§10).
- 지나간 끼니는 따라잡지 않는다(기기 규칙과 같다).
- 폰 앱은 스스로 산책을 내보내지 않는다. iOS 는 앱이 뒤에 있으면 멈추므로 서버가 맡는다.

### 5.2 흐름

1. `walks` 에 `INSERT`(slot 이 기본 키라 한 번만 된다). `start = 지금`, `end = 지금 + 30분`, `status = away`.
2. 경로: 프로필의 근처 장소로 `pickPlaces`, 길은 `fallbackLegs()`(서버엔 MapKit 길 찾기가 없다). `Walk` 모양 그대로 만든다(`onMap: false`).
3. 날씨: open-meteo 를 직접 부른다(위치는 프로필).
4. 조사: Claude 호출 한 번. 내장 웹 검색 툴을 붙여 "궁금한 것 하나를 골라 알아보고 출처와 함께 짧게"를 시킨다.
   - 입력: 네코 이름, 지나온 곳 이름, 성격 글, 서버가 전에 알아본 것 최근 5줄.
   - 기기의 `runSubagent` 루프(최대 8단계)는 옮기지 않는다. 내장 검색은 Anthropic 쪽에서 돌아 호출 한 번으로 끝난다.
5. 선물 종류를 굴린다. 서버가 줄 수 있는 것만: 주운 것·가 본 곳·날씨 쪽지·읽을거리·놀이.
6. 보고: `walk_report` 툴 스키마를 앱과 같이 써서 한 번 부른다.
7. 결과(조사 요약·종류·재료·보고·장소·경로)를 `walks.result` 에 평문으로 둔다. 쓴 돈을 장부에 더한다.
8. `end` 가 지난 뒤 첫 cron 에서 `status = ready` 로 바꾸고 알림을 보낸다(§7).

- 모델: `wrangler.toml` 의 `WALK_MODEL`. 기본은 앱의 `WEB_SEARCH_MODEL` 과 같은 `claude-haiku-5-5`(§10).
- 검색 툴 버전은 앱이 쓰는 `web_search_20250305` 를 따른다. 더 새 버전(`web_search_20260209`)을 Haiku 5.5 가 받는지는 **미확인**.
- 호출은 공식 SDK(`@anthropic-ai/sdk`)로 한다. Workers 에서 도는지는 4단계 첫날 `wrangler dev` 로 확인한다.
- 실패하면(키 없음·오류·시간 초과) 그 끼니는 건너뛴다. `walks` 행은 지워 다음 끼니에 영향을 안 준다.

### 5.3 서버로 옮길 수 있는 것 / 없는 것

| `src/agent/walk.ts` 의 일 | 서버 | 대신 |
|---|---|---|
| 조사(웹 검색) | 됨 | Claude 내장 검색 한 번 |
| 날씨 | 됨 | open-meteo 직접 |
| 선물 굴리기·재료 | 됨 | 같은 함수. 종류 이력은 서버가 따로 든다 |
| 보고(`walk_report`) | 됨 | 같은 스키마 |
| 근처 장소 찾기(MapKit) | **안 됨** | 맥이 산책할 때 찾은 장소(이름·분류·좌표, 30곳까지)를 산책 프로필에 올려 둔다. 없으면 장소 선물은 안 나온다 |
| 걷기 경로(MapKit) | **안 됨** | `fallbackLegs()`. 지도 카드는 동심원 위에 그린다 |
| 사용자 기억 선물(`memory`) | **안 함** | 서버는 기억을 못 읽는다 |
| 그림 선물(`drawing`) | **안 함** | 그림 API 키와 보관함이 맥에 있다 |
| 모양 점검(`refineShape`) | **안 됨** | 캔버스가 없다. 건너뛴다. 모양 검사(`validateShape`)는 받은 기기가 한다 |
| 오래 기억하기(`saveMemory`) | **안 함** | 받은 기기가 한다 |
| 일지를 대화에 붙이기 | **안 함** | 받은 기기가 한다 |

### 5.4 겹치지 않게

- 기기가 나가기 전에 `POST /v1/walk/claim` 을 부른다.
  - 끼니 산책: 그 `slot` 이 비어 있고 진행 중인 산책이 없으면 된다.
  - 추가 산책(`slot = null`): 진행 중인 산책이 없고 지난 산책이 끝난 지 2시간이 지났으면 된다.
  - 안 되면 나가지 않는다. 서버나 다른 기기가 이미 나갔다.
- 기기는 `sync` 응답의 `walk`(지난 산책 시작·끝)로 `nextWalkAt` 의 `lastWalk` 를 채운다. 서버가 다녀온 끼니를 맥이 또 나가지 않는다.
- 오프라인인 맥은 지금처럼 혼자 나간다. 그사이 서버도 나갔으면 일지가 둘 남는다. 드물고, 고치지 않는다.

### 5.5 결과를 기기에 내려주기

- 서버 산책 중에 기기를 열면: `walk.status = away` 를 보고 지금의 산책 화면(`NekoAway`, 지도)을 그대로 보여 준다. 경로는 결과에 든 `Walk` 로 그린다.
  - 사용자가 만지면 `POST /v1/walk/hurry`. 서버가 `end` 를 1–2분 뒤로 당긴다(`hurryHome` 과 같은 뜻). 이 경우 알림은 안 보낸다.
- 다 왔으면(`ready`): 기기가 `POST /v1/walk/ack`. **처음 부른 기기만** 결과를 받는다.
  1. 앱의 `compose()` 로 일지 글을 만든다(지금 코드 그대로).
  2. 지금 열린 세션에 assistant 메시지로 붙인다(`meta.prompt` 포함). 보통 메시지라 암호화돼 다른 기기로 간다.
  3. 선물 모양을 검사해 선물함에 넣는다. 선물 기록으로 다른 기기에 간다.
  4. 인상 깊은 것 하나를 기억으로 저장한다.
  5. `neko_walk` 를 `done` 으로 적는다(지도 핀).
- 서버는 `ack` 뒤 결과를 지운다. 아무도 안 받으면 7일 뒤 지운다.

### 5.6 예산

- 서버는 응답의 usage 로 쓴 돈을 센다(가격표는 `src/lib/claude-models.ts` 를 같이 쓴다).
- `WALK_BUDGET_USD`(달 한도, 기본값은 §10)에 닿으면 그 달은 서버 산책을 안 한다. 달은 프로필의 갱신일을 따른다.
- 한 번 산책의 상한: 검색 3번, 호출 4번, 호출마다 `max_tokens` 고정.
- 어림(Haiku 5.5: 입력 $0.10, 출력 $0.50 / 100만 토큰, 검색 1회 $0.01): 검색 3번 $0.03 + 토큰 $0.01 안쪽 ≈ **한 번에 $0.03–0.04, 하루 3번이면 한 달 $3–4**. 대부분 검색값이다.
- 기기의 예산 장부(`nekodesk_claude_usage`)와는 따로다. 같은 API 키를 쓰면 Console 잔액은 같이 줄어든다(§10).

---

## 6. iOS 앱

### 6.1 그대로 쓰는 것 / 빠지는 것

같은 저장소에서 `tauri ios` 로 빌드한다. 화면(React)과 Rust 를 같이 쓴다.

| 그대로 | 고쳐야 쓰는 것 | 빠지는 것 |
|---|---|---|
| 대화 화면·에이전트 루프(`src/agent/`) | 키체인(`secrets.rs`): 지금은 macOS 전용. iOS 구현을 더한다 | 파일 도구(`fs.*`), `code.exec`, `skill.read` |
| 네코 엔진·감독(사이드바/독 자리) | `Cargo.toml`: `macos-private-api`, global-shortcut·drag·updater 를 데스크탑 전용으로 가른다 | 캡처, 빠른 질문 창, 화면 모드(`neko-screen`), glow |
| DB(SQLCipher)·기억·할 일·일정 | `tauri.conf.json`: 창 둘 → 폰은 창 하나 | AirDrop, 임시 보관함, `process.list`, `security.check` |
| Claude 중계(`claude.rs`, reqwest + rustls) | 툴 목록을 플랫폼으로 거른다(`tool-registry.ts`) | 로컬 모델(`llama.rs`), MCP |
| 웹 검색(Claude 내장)·스크랩·날씨 | 화면 배치(§6.2) | 자동 업데이트(스크립트가 대신한다) |
| 동기화(Rust) | 위치: CoreLocation 은 iOS 에도 있으나 지금 코드는 macOS 로 묶여 있다 | MapKit 지도·장소·길(1차엔 뺀다. 지도 카드는 동심원) |
| 선물함 보기 | | 그림 생성·`image.trace`(1차엔 뺀다) |

- 플랫폼은 Tauri CLI 가 빌드 때 주는 `TAURI_ENV_PLATFORM` 으로 가른다. 새 의존은 안 든다.
- SQLCipher 가 iOS 타깃에서 빌드되는지(지금은 "macOS 내장 CommonCrypto 로 빌드"에 기댄다)는 **미확인**. 3단계 첫 확인 거리다.
- 폰의 툴: `todo.*`, `schedule.*`, `web.search`, `web.scrape`, `weather.get`, `memory.*`, `user.ask`, `plan.*`, `game.*`, `agent.delegate`.
- 폰에서는 Claude 프로필만 쓴다.

### 6.2 화면

- 한 줄 세로 배치다. 사이드바와 오른쪽 패널은 없다.
  - 맨 위: 세션 제목(누르면 세션 목록이 아래에서 올라온다), 새 대화, 설정.
  - 가운데: 대화.
  - 그 아래: 네코 띠(지금의 `dock` 자리 = 거실). 접을 수 있다.
  - 맨 아래: 입력 칸. 키보드가 올라오면 입력 칸이 따라 올라온다(`visualViewport`).
- 안전 영역(`env(safe-area-inset-*)`)을 지킨다. 노치·홈 막대에 가리지 않게.
- **13 미니(375×812pt)** 가 기준이다. 여기서 되면 17(화면 크기 **미확인**, 더 크다)에서도 된다.
  - 네코 띠 높이는 `DOCK_H.min`(120) 근처. 키보드가 올라오면 네코 띠를 숨긴다.
  - 누르는 것은 44pt 이상. 도구 기록 패널은 접힌 채로 시작한다.
  - 표·코드 블록은 가로로 밀어 본다.
- 선물: 폰의 네코 자리를 어느 "장소"로 볼지는 §10 에서 정한다.
- 설정은 폰에 필요한 것만: 동기화(짝 맞추기), 모델, 예산, 네코 꾸미기, 기억 보기.

### 6.3 무료 계정 제약

- 설치한 앱은 7일 뒤 안 열린다. 데이터는 남고, 다시 설치하면 열린다. 앱을 지우지 않는 한 DB·키체인이 남는지는 **미확인**(남는 것으로 알려져 있다. 3단계에서 확인).
- APNs(푸시)·CloudKit·연결 도메인을 못 쓴다. 그래서 알림은 ntfy 앱이 받는다.
- 폰마다 개발자 모드를 켜고, 처음 한 번 설정에서 개발자를 신뢰해야 한다.
- 무료 계정의 앱 개수·App ID 개수 한도(기기당 3개, 7일에 10개로 알려져 있다)는 **미확인**.
- 뒤에서 도는 동기화는 기대하지 않는다. 앱이 앞에 나올 때 맞춘다.

### 6.4 API 키

- 폰은 Claude 를 직접 부른다(폰 → api.anthropic.com). Worker 를 거치면 대화가 서버를 평문으로 지나가서 안 된다.
- 키는 iOS 키체인에 둔다. 맥과 같이 화면에는 값을 안 준다.
- 넣는 방법: 짝 문자열에 같이 실어 한 번에 넘긴다(권장). 긴 키를 폰에서 치지 않아도 된다. 서버에는 안 올라간다(§10).

### 6.5 7일마다 다시 설치

- `scripts/ios-reinstall.sh` + launchd 에이전트(`~/Library/LaunchAgents/com.nekodesk.ios-reinstall.plist`, 날마다 한 번. 맥이 자고 있었으면 깰 때 돈다).
- 하는 일
  1. 마지막으로 만든 앱의 `embedded.mobileprovision` 에서 만료일을 읽는다(`security cms -D -i`).
  2. 3일 넘게 남았으면 끝. (`--force` 면 무조건 한다.)
  3. 빌드: `npm run tauri ios build`(또는 `xcodebuild … -allowProvisioningUpdates`). Xcode 자동 서명이 새 프로파일을 받는다.
  4. `xcrun devicectl list devices` 로 연결된 폰을 찾아, 폰마다 `xcrun devicectl device install app` 으로 덮어 설치한다.
  5. 못 찾은 폰이 있으면 macOS 알림("아이폰을 연결해줘")을 띄우고 내일 다시 한다. 3일 여유가 그래서 있다.
  6. 결과를 `~/Library/Logs/nekodesk-ios-reinstall.log` 에 남긴다.
- 덮어 설치라 폰의 데이터는 남는다.
- **미확인**
  - `xcodebuild` 가 명령줄에서 무료 계정 프로파일을 사람 손 없이 갱신하는지. 안 되면 Xcode 를 열어 한 번 눌러야 한다.
  - 폰이 Wi-Fi 로만 잡혀 있어도, 잠겨 있어도 설치되는지.
  - `tauri ios build` 의 내보내기 옵션 이름.
- 준비물: Xcode 앱(지금 없다), Xcode 에 Apple ID 로그인, `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`, CocoaPods(`brew install cocoapods`).

---

## 7. 알림

- 길: Worker → `https://ntfy.sh/<토픽>` → 아이폰의 ntfy 앱(App Store). 폰 앱 서명이 만료돼도 알림은 온다.
- **토픽이 곧 비밀번호다.** ntfy.sh 는 가입 없이 쓰고, 토픽을 아는 사람은 누구나 읽고 보낼 수 있다.
  - 맥이 무작위 토픽을 만든다(`neko-` + 32자 hex). 사람이 짓지 않는다.
  - 서버에는 산책 프로필과 함께 평문으로 둔다(보내려면 알아야 한다).
  - 폰에서는 ntfy 앱에 그 토픽을 구독한다. 맥 설정에서 토픽을 복사하거나 QR 로 보여 준다.
  - 새면 맥에서 토픽을 새로 만들고 폰에서 다시 구독한다.
- **본문 규칙**
  - 고정 문장만 보낸다: 제목 "NekoDesk", 본문 "네코가 돌아왔어".
  - 일지·선물 이름·대화·기억·위치·네코 이름은 싣지 않는다. ntfy.sh 와 Apple 을 평문으로 지난다.
  - 앱은 알림 내용을 믿지 않는다. 알림은 "앱을 열어 보라"는 신호일 뿐이고, 내용은 앱이 서버에서 직접 받는다.
- 언제: 서버 산책이 끝났을 때만. 사용자가 서둘러 부른 경우와 그 순간 기기를 쓰고 있는 경우엔 안 보낸다. 하루 최대 3번.
- ntfy.sh 무료 한도(하루 메시지 수)는 **미확인**. 하루 3번이라 걸릴 일은 없어 보인다. 메시지 크기 한도는 4,096바이트다.

---

## 8. 단계와 완료 조건

### 1단계 — 설계

- 이 문서. §10 의 물음에 답을 받으면 끝.

### 2단계 — Worker + 맥 동기화 (폰 없이 검증)

만드는 것

- `server/`: 인증, 기기 등록·짝 맞추기, `sync`, `reset`. D1 스키마.
- 맥: 마이그레이션 4번, Rust 동기화 모듈, 암호화, 세션 목록·요약·이름·성격을 DB 로 옮기기, 설정 › 동기화(서버 주소·`SETUP_TOKEN`·켬/끔·기기 목록·짝 문자열).

완료 조건

- `wrangler dev` + 로컬 D1 에 대고 `server/test/sync.mjs` 가 통과한다: 등록, 짝 맞추기, 올리기·받기, 겨루기(늦은 쓰기가 짐), 세션 삭제·`cut`, 자동 삭제 거절, 끊긴 토큰 거절.
- Rust 단위 테스트(메모리 DB): 모으기·적용·같은 내용 기억 합치기·암호화 왕복·AAD 가 다르면 실패.
- **두 번째 기기 흉내**: 데이터 폴더를 따로 쓰는 맥 앱을 하나 더 띄워(dev 빌드) 같은 열쇠로 짝을 맞춘다.
  - A 에서 한 대화가 B 에 보인다. B 에서 이어 말하면 A 에 보인다.
  - A 를 끄고 B 에서 말한 뒤 A 를 켜면 보인다.
  - 세션 삭제, 수동 요약, 기억·할 일·선물 추가가 넘어간다.
  - 네트워크를 끊고 양쪽에서 쓴 뒤 다시 이으면 둘 다 남는다.
- 로컬 D1 을 열어 `blob` 이 읽을 수 없는 바이트인지, 평문 칸에 내용이 없는지 눈으로 본다.
- 서버를 꺼도 맥 앱은 평소처럼 돈다. 기존 `npm run test:all` 이 그대로 통과한다.
- 사용자 몫: 실제 배포(`wrangler deploy`, D1 만들기, `SETUP_TOKEN`), 맥 설정에 주소 넣기.

### 3단계 — iOS 앱

완료 조건

- 시뮬레이터(13 미니 크기)에서 빌드되고 대화가 된다.
- 실제 13 미니·17 에 설치된다. 짝 문자열을 붙여넣으면 맥의 세션 목록과 대화가 보인다.
- 맥을 덮고 폰에서 이어 말한다. 맥을 열면 그 대화가 보인다.
- 키보드가 입력 칸을 가리지 않는다. 13 미니에서 가로로 넘치는 화면이 없다.
- 폰에 없는 툴은 모델에게 보이지 않는다.
- `scripts/ios-reinstall.sh --force` 로 두 폰에 다시 설치되고 데이터가 남는다. launchd 가 다음 날 돌아 로그를 남긴다.

### 4단계 — 서버 산책 + 알림

완료 조건

- `wrangler dev --test-scheduled` 로 cron 을 손으로 쏴서: 조건이 안 맞으면 안 나가고, 맞으면 한 번만 나간다. 같은 끼니에 두 번 쏴도 한 번이다.
- 맥이 찜한 끼니는 서버가 안 나간다. 서버가 다녀온 끼니는 맥이 안 나간다.
- 결과를 맥이 받으면 일지가 대화에 붙고, 선물이 선물함에 들어가고, 다른 기기에도 보인다. 서버의 결과는 지워진다.
- 예산을 0 으로 두면 안 나간다. 쓴 돈이 장부에 적힌다.
- ntfy 알림이 폰에 오고, 본문이 고정 문장이다.
- 배포 후(사용자): Cloudflare 대시보드에서 cron 의 CPU 시간이 한도 안인지 본다.

---

## 9. 위험·미확인

| 무엇 | 왜 문제인가 | 대책 |
|---|---|---|
| Worker CPU 10ms(무료) | 서버 산책은 큰 JSON 을 몇 번 푼다. `wrangler dev` 는 한도를 안 건다 | 스트리밍 없이 호출, 서버에서 검사·가공을 최소로. 넘으면 산책을 cron 여러 번에 나눠 한다(조사 → 보고). 그래도 안 되면 유료 플랜을 사용자와 상의 |
| 기기 시계 | 나중 쓴 쪽이 이기는 규칙이라 시계가 크게 틀린 기기가 이기거나 진다 | 서버가 `ts` 가 자기 시계보다 한참 앞선(예: 10분) 쓰기를 거절한다 |
| 메시지 섞임 | 오프라인 두 기기가 같은 세션에 쓰면 시각순으로 섞인다 | 받아들인다(§2.3) |
| 세션당 5000개 자르기 | 기기는 자르는데 서버는 안 자른다. 새 기기가 받으면 더 많이 갖는다 | 받을 때도 같은 상한으로 자른다. 서버 쪽 정리는 필요해지면 |
| 그림 첨부 | 암호문 1MB 를 넘으면 그림이 다른 기기에 안 간다 | 1차는 뺀다(§4.2). 필요하면 R2 에 따로 올린다(무료 한도 **미확인**) |
| 열쇠 분실 | 맥의 키체인 항목이 사라지면 서버 기록을 못 푼다 | 기기에 원본이 다 있다. 새 열쇠로 다시 올리면 된다. 모든 기기를 한꺼번에 잃으면 복구 못 한다 — 짝 문자열을 암호 관리자에 적어 두라고 안내한다 |
| 폰 분실 | 폰에 열쇠와 API 키가 있다 | 토큰 끊기 + 열쇠 바꾸기 + Console 에서 API 키 폐기 |
| 서버 침해 | 암호문은 못 읽지만 평문(위치·성격 글·산책 결과·활동 시각)은 읽힌다. 서버용 API 키도 쓴다 | 평문을 §3.3 표로 묶어 둔다. 서버용 키는 따로 발급하고 Console 에서 한도를 건다 |
| ntfy 토픽 유출 | 남이 가짜 알림을 보낼 수 있다 | 내용이 없고, 앱은 알림을 안 믿는다. 토픽을 바꾼다 |
| 산책 중 웹 글의 지시 | 서버 산책 결과가 대화에 들어간다 | 지금 기기 산책과 같은 방어: 도구는 검색·날씨뿐, 기억은 120자 한 문장만, 모양은 `validateShape` |
| Xcode 없음 | 3단계를 시작 못 한다 | 사용자가 설치(수 GB) |
| 무료 계정 자동 재서명 | 사람 손 없이 되는지 **미확인** | 안 되면 스크립트가 Xcode 를 열고 알림으로 알려 준다 |
| SQLCipher iOS 빌드 | **미확인** | 3단계 첫날 확인. 안 되면 OpenSSL 번들 기능으로 바꾼다 |
| 기존 Cloudflare 계정의 cron·D1 사용량 | **미확인** | 사용자가 대시보드에서 확인(§10) |
| D1 batch·색인의 한도 계산 | **미확인** | 2단계에 `wrangler dev` 와 문서로 확인, 배포 후 대시보드로 확인 |
| ntfy.sh 하루 한도, iOS 에서 `ntfy://` 링크 | **미확인** | 4단계에 확인 |
| 아이폰 17 화면 크기 | **미확인** | 13 미니 기준으로 만들면 영향 없다 |
| 다른 세션의 산책·자동 삭제 변경 | 이 문서는 `neko-v26` 의 `lib/walk.ts`·`pruneOldSessions` 를 전제로 한다 | 2·4단계 시작 때 다시 맞춰 본다 |

---

## 10. 사용자가 정해야 할 것

1. **성격 글을 서버에 평문으로 둘까.** 두면 서버 산책 일지가 네코 말투로 나온다. 안 두면 기본 말투다. (권장: 둔다)
2. **집 위치 정밀도.** 소수 셋째 자리(약 100m)로 올린다. 더 흐리게(둘째 자리, 약 1km) 하면 장소 선물의 거리가 어긋난다. (권장: 셋째 자리)
3. **그림 첨부.** 1차는 큰 그림을 빼고 올린다. 폰에서도 맥에서 붙인 그림을 봐야 하나? (권장: 1차는 뺀다)
4. **일정(`events`)도 맞출까.** 요청엔 할 일만 있었다. (권장: 같이 맞춘다)
5. **짝 맞추기.** 복사·붙여넣기만으로 충분한가, QR 로 찍기도 필요한가. (권장: 붙여넣기 먼저, QR 은 3단계에서 판단)
6. **Claude API 키를 짝 문자열에 실을까.** 아니면 폰에서 직접 넣을까. (권장: 싣는다)
7. **서버용 API 키.** 맥과 같은 키를 쓸까, 서버용을 따로 만들까. (권장: 따로 만들고 Console 에서 한도)
8. **서버 산책 모델과 달 예산.** (권장: `claude-haiku-5-5`, 한 달 $5)
9. **서버도 추가 산책(2시간 간격)을 할까.** (권장: 안 한다. 끼니 3번만)
10. **예산 합산.** 기기마다 따로 세는 지금 방식을 그대로 둘까, 기기 + 서버를 합쳐 볼까. (권장: 1차는 따로)
11. **폰의 네코 자리는 어느 장소인가.** 선물은 방(작은 것)·거실(중간까지)·마당(전부)에 놓는다. 폰을 '거실'로 볼까, 새 장소를 만들까. (권장: 거실로 본다)
12. **지금 있는 대화를 전부 올릴까.** 동기화를 켠 뒤의 대화만 올릴 수도 있다. (권장: 전부)
13. **Cloudflare**: Worker 이름, 기존 계정에서 이미 쓰는 Cron Trigger 수(5개 한도), 주소(workers.dev 그대로 쓸지).
14. **Xcode 설치와 Apple ID 로그인**, 두 폰의 개발자 모드 켜기 — 3단계 전에.
