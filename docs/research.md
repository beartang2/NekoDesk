# NekoDesk — 프로젝트 심층 분석

> 작성일: 2026-04-06  
> 분석 대상: `/Users/kdh_38/Documents/MyProject/GitHub/NekoDesk` (branch: `dev`)

> ⚠️ **역사적 자료 (2026-08 기준)**  
> 이 문서는 TUI/CLI 시절 구조를 정리한 분석 노트다. 현재 코드와 다르다.
> - 메모 기능, GitHub 대시보드, Ink 기반 TUI, FastAPI 백엔드는 모두 제거됐다.
> - 현재는 Tauri 2 + React 19 데스크톱 앱이며, 일정은 캘린더 카드로 재구성됐고 코드 실행 도구가 추가됐다.
>
> 현재 확정 스코프는 `docs/plan.md`의 `## 0. Settled Scope (2026-08)`를 볼 것.
> 이 문서는 설계 의도와 초기 맥락을 남겨두기 위해 그대로 보존한다.

---

## 1. 프로젝트 정체성과 비전

**NekoDesk**는 터미널 기반 **ASCII 고양이 반려 앱 + 개인 생산성 대시보드**다.  
단순한 생산성 도구가 아니라 "함께 일하는 동반자"라는 감성을 터미널 위에서 구현하고자 했다.

### 핵심 아이디어

- 터미널에서 하루 종일 작업하는 개발자 옆에 **항상 존재하는 작은 고양이 친구**를 두고 싶었다
- 그 고양이가 단순히 귀엽기만 한 게 아니라 **실제로 생산적인 도움**을 주길 원했다
- 메모 / 할 일 / 일정 / GitHub 현황 / 웹 검색을 **자연어 한 마디**로 처리하길 원했다
- 외부 클라우드 서비스 없이 **로컬 LLM (llama.cpp)** 으로 프라이버시를 지키면서도 AI 경험을 제공하려 했다
- **한국어 우선** 인터페이스 — 한국어로 말을 걸면 자연스럽게 대화가 된다

---

## 2. 전체 아키텍처

```
┌─────────────────────────────────────────────┐
│          NekoDesk Terminal App               │
│       (Ink/React + Node.js CLI)              │
│   terminal-ui.js ── pet-renderer.js          │
│   5 views: chat / memo / todo / schedule     │
│            / github                          │
└──────────────┬──────────────────────────────┘
               │ HTTP POST /chat, GET /github/*
               ▼
┌─────────────────────────────────────────────┐
│        FastAPI Backend (Python)              │
│  routers/chat.py  ── routers/github.py       │
│  POST /chat → llama.cpp 프록시               │
│  GET /github/* → GitHub API 집계             │
└────────────┬────────────────┬────────────────┘
             │                │
     ┌───────▼──────┐  ┌──────▼────────┐
     │  llama.cpp   │  │  GitHub API   │
     │ :8803        │  │ api.github.com│
     │ /v1/chat/    │  │ (Bearer token)│
     │  completions │  │               │
     └──────────────┘  └───────────────┘

Node.js 레이어 (JavaScript):
  app-controller.js
    ├── services/llm-client.js
    ├── services/intent-router.js
    ├── services/intent-validator.js
    ├── services/github-client.js
    ├── services/web-search-client.js
    ├── services/dashboard-service.js
    ├── services/llm-defaults.js
    ├── storage/database.js
    └── storage/repositories.js
```

### 데이터 흐름 요약

1. 사용자가 터미널에 텍스트 입력
2. `intent-router.js`가 **결정론적 패턴 매칭** 시도 → 실패 시 **LLM 인텐트 분류**
3. `intent-validator.js`가 24개 인텐트 스키마 검증
4. `app-controller.js`가 인텐트 종류에 따라 분기 실행
   - 로컬 데이터 (메모/할 일/일정) → SQLite CRUD
   - GitHub → github-client.js → FastAPI → GitHub API
   - 웹 검색 → web-search-client.js → DuckDuckGo
   - 일반 대화 → LLM tool planning → LLM chat 응답
5. 응답에서 `[[PET_STATE:mood]]` 토큰 파싱 → 고양이 기분 업데이트
6. 터미널 UI 갱신

---

## 3. 고양이 (Pet) 시스템 — 프로젝트의 심장

고양이는 단순 장식이 아니라 **앱의 정체성** 그 자체다.

### 10가지 기분 상태

| 기분 | 트리거 | 시각적 특징 |
|------|--------|------------|
| `idle` | 기본 상태 | 평온한 표정 |
| `happy` | 작업 성공 | 반짝임, 쿠키 |
| `playful` | 경쾌한 대화 | 실뭉치, 움직임 |
| `curious` | 궁금한 질문 | 큰 눈, 돋보기 |
| `sleepy` | 오랫동안 비활성 | 졸린 표정, 커피 |
| `proud` | 할 일 완료 등 성취 | 트로피, 반짝임 |
| `shy` | 수줍은 상황 | 쿠키 뒤에 숨음 |
| `hungry` | 오류나 문제 | 슬픈 표정 |
| `working` | LLM 처리 중 | 집중하는 표정 |
| `error` | 심각한 오류 | 당황한 표정 |

### 기분 변화 메커니즘

- LLM이 응답 텍스트 내에 `[[PET_STATE:happy]]` 같은 토큰을 숨겨서 반환
- `llm-client.js`가 이 토큰을 파싱하고 UI에 적용
- 토큰은 사용자에게 보이지 않게 제거됨
- ASCII 프레임이 프레임별로 애니메이션 (2–3 프레임 사이클)

### 의도한 감성

고양이는 터미널 왼쪽에 항상 자리 잡고, 무언가 처리 중일 때 `working` 표정을 짓고, 할 일을 완료하면 `proud`해진다. **"나 혼자 작업하는 게 아니다"** 라는 느낌을 주는 것이 핵심 감성 목표였다.

---

## 4. LLM 통합 — 3단계 구조

로컬 LLM (llama.cpp, 기본 Qwen3 8B Q4_K_M)을 세 가지 용도로 구분하여 사용한다.

### 1단계: 인텐트 분류 (parseIntent)

```
입력: 사용자 텍스트 + 현재 뷰 컨텍스트
출력: { type, confidence, params }
Temperature: 0.1 (결정론적)
Max Tokens: 48
```

24개 인텐트 타입을 분류:

| 카테고리 | 인텐트 예시 |
|----------|------------|
| 시스템 | `system.help`, `system.quit` |
| 뷰 전환 | `view.chat`, `view.memo`, `view.todo`, `view.schedule`, `view.github` |
| 메모 | `memo.add`, `memo.list`, `memo.find`, `memo.delete`, `memo.deleteAll` |
| 할 일 | `todo.add`, `todo.complete`, `todo.list`, `todo.delete`, `todo.deleteAll`, `todo.deleteCompleted` |
| 일정 | `schedule.add`, `schedule.list`, `schedule.delete`, `schedule.deleteAll` |
| GitHub | `github.overview`, `github.query` |
| 웹 검색 | `web.search` |
| 대화 | `chat` |

신뢰도 < 0.65이면 `chat`으로 폴백.

### 2단계: 도구 계획 (planToolUse)

```
입력: 대화 히스토리
출력: { useTool: bool, intent: {...} }
Temperature: 0.1
Max Tokens: 96
```

일반 대화(`chat` 인텐트) 중에도 LLM이 "도구를 쓸지 말지" 결정한다.  
예: "요즘 날씨 어때?" → web.search 실행 결정.

### 3단계: 대화 응답 (chat)

```
입력: 시스템 프롬프트 + 대화 히스토리 (기본 최근 12개)
출력: 자연어 응답 + [[PET_STATE:mood]] 토큰
Temperature: 0.7 (창의적)
Max Tokens: 설정값
```

**시스템 프롬프트 핵심 내용:**
- "NekoDesk야, 따뜻하고 고양이다운 성격을 가진 어시스턴트"
- 한국어가 기본, 사용자가 다른 언어 쓰면 그 언어로
- 1–6 문장 이내 답변, 표현 다양하게
- 거짓 행동 주장 금지 ("저장했어!" → 실제 저장된 경우만)
- 응답에 `[[PET_STATE:mood]]` 반드시 포함

### 특수 처리

- **한국어 재시도**: LLM이 중국어로 응답할 경우 자동 재시도 (Qwen 계열 모델 특성 대응)
- **내부 추론 제거**: `<thinking>`, `<reasoning>` 태그 자동 스트리핑
- **오프라인 폴백**: LLM 서버 연결 불가 시 "로컬 기능은 계속 사용 가능" 메시지

---

## 5. 생산성 기능 상세

### 5-1. 메모 (Memo)

- 추가: 제목 없이 내용만 저장 가능, 태그 지원 (JSON 배열)
- 목록: 최근 수정순, 최대 4개 표시
- 검색: 내용 LIKE 검색
- 삭제: 개별 / 전체 (전체 삭제 시 확인 다이얼로그)

### 5-2. 할 일 (Todo)

- 추가: 내용, 우선순위, 마감일(ISO-8601) 지원
- 완료 처리: `open` → `done` 상태 전환, `completed_at` 기록
- 목록: 미완료 먼저, 마감일 순 정렬
- 삭제: 개별 / 완료된 항목만 / 전체 (모두 확인 다이얼로그)

### 5-3. 일정 (Schedule)

- 추가: 제목, 시작 시간(ISO-8601), 종료 시간, 메모, 종일 여부
- 목록: 오늘 / 내일 / 전체 예정 일정
- 자연어 날짜 파싱: "내일 오전 10시" → ISO-8601 변환 (LLM 담당)
- 삭제: 개별 / 전체

### 5-4. GitHub 대시보드

인증: `GITHUB_TOKEN` 환경변수 (읽기 전용)

병렬 요청으로 수집하는 데이터:

| 섹션 | 내용 | 최대 수 |
|------|------|---------|
| 계정 정보 | 사용자명, 아바타 | — |
| Assigned Issues | 나에게 할당된 이슈 | 5 |
| 내 PR | 내가 작성한 오픈 PR | 5 |
| 리뷰 요청 | 나에게 리뷰 요청된 PR | 5 |
| 멘션 | 내가 언급된 이슈/PR | 5 |
| 알림 | 미확인 알림 | 5 |
| 최근 업데이트 저장소 | | 4 |
| 즐겨찾기 저장소 | | 3 |

- 상대 시간 표시 ("2시간 전", "1일 전")
- 긴 제목 48자 + "…" 자동 자름
- 팔로업 질문 (`github.query`): "리뷰 요청된 PR이 뭐야?" → LLM이 컨텍스트 기반 답변

### 5-5. 웹 검색

- 소스: DuckDuckGo HTML 검색 (API 키 불필요)
- 자동 트리거 패턴:
  - **명시적**: "웹에서 찾아줘", "검색해줘"
  - **트러블슈팅**: "오류", "error", "exception", "stack trace" 포함 시
  - **최신 정보**: "최신", "뉴스", "날씨", "주가" + 의문문
- 로컬 앱 데이터 관련 쿼리는 웹 검색 제외 (메모/할 일/일정 등)

---

## 6. 터미널 UI 설계

### 레이아웃 구조

```
┌─────────────────────────────────────────┐
│  Header: NekoDesk + 상태 표시기          │
├─────────────────────────────────────────┤
│  탭: [chat] [memo] [todo] [schedule]    │
│      [github]                           │
├──────────────┬──────────────────────────┤
│   ASCII 고양이│   메인 콘텐츠 패널        │
│   (22–30칸)  │   (chat / list / github) │
│              │                          │
│   기분 상태  │                          │
│   애니메이션 │                          │
├──────────────┴──────────────────────────┤
│  입력 필드 + 키보드 힌트                  │
└─────────────────────────────────────────┘
```

### 반응형 레이아웃

| 터미널 너비 | 레이아웃 |
|------------|---------|
| < 96칸 | 고양이가 메인 패널 위에 쌓임 (스택) |
| ≥ 96칸 | 고양이 좌측, 메인 패널 우측 (나란히) |
| 최소 요구 | 72칸 × 22행 |

### 키보드 조작

- `1`–`5` 또는 `c/m/t/s/g`: 뷰 전환
- 화살표 키: 채팅/목록 스크롤
- 숫자 키: 항목 선택/확장
- Enter: 입력 전송

### 메시지 표시 스타일

- 사용자 메시지: 오른쪽 정렬 또는 `you:` 접두사
- 어시스턴트 메시지: 왼쪽 정렬
- 시스템 메시지: 회색, 중앙 힌트
- pet state 토큰은 표시 전 제거

---

## 7. 저장소 설계

**엔진**: Node.js 내장 `node:sqlite` (DatabaseSync) + WAL 모드

**데이터베이스 위치**: `./.nekodesk/nekodesk.sqlite` (기본값)

### 스키마 5개 테이블

```sql
memos (id, title, content, tags[JSON], created_at, updated_at)
todos (id, content, status, priority, due_at, created_at, completed_at)
events (id, title, start_at, end_at, notes, all_day, created_at)
conversation_messages (id, role, content, created_at)
settings (key PRIMARY KEY, value[JSON], updated_at)
```

**대화 메모리**: 최근 40개 메시지 보존 (설정 가능), LLM에는 최근 12개 전달

---

## 8. 설정 시스템

40개 이상의 환경변수 + `.env` 파일 지원:

| 카테고리 | 주요 설정 |
|----------|---------|
| LLM 서버 | `NEKODESK_LLM_URL`, `NEKODESK_LLM_MODEL`, `NEKODESK_LLM_TIMEOUT` |
| 프롬프트 | `NEKODESK_CHAT_PROMPT_FILE`, `NEKODESK_INTENT_PROMPT_FILE` |
| 대화 | `NEKODESK_CHAT_HISTORY_LIMIT`, `NEKODESK_CHAT_MAX_TOKENS` |
| 저장소 | `NEKODESK_DB_PATH`, `NEKODESK_HOME` |
| GitHub | `GITHUB_TOKEN` |
| 웹 검색 | `NEKODESK_WEB_SEARCH_ENABLED`, `NEKODESK_WEB_SEARCH_TIMEOUT` |

---

## 9. 기술 스택

| 영역 | 기술 |
|------|------|
| 터미널 UI | Ink 6.8 (React for terminal) + React 19 |
| 백엔드 오케스트레이션 | Node.js 22+ (ESM) |
| LLM 프록시 | FastAPI + uvicorn + httpx |
| 로컬 LLM | llama.cpp (Qwen3 8B Q4_K_M 기본값) |
| 데이터베이스 | SQLite3 (node:sqlite WAL 모드) |
| 외부 API | GitHub REST API, DuckDuckGo HTML |
| 테스트 | node:test (내장), node:assert/strict |

---

## 10. 테스트 구조

| 테스트 파일 | 검증 대상 |
|------------|---------|
| `config.test.js` | 환경변수 로딩, 파싱, 병합 |
| `intent-router.test.js` | 인텐트 라우팅, 웹 검색 패턴 |
| `llm-client.test.js` | LLM 통신, 한국어 재시도 |
| `repositories.test.js` | SQLite CRUD 전체 |
| `app-controller.test.js` | 인텐트 실행 엔드투엔드 |
| `terminal-ui.test.js` | 레이아웃 계산, 뷰 전환 |
| `pet-renderer.test.js` | 기분별 프레임 선택 |
| `web-search-client.test.js` | DuckDuckGo 파싱, 오류 처리 |

- 외부 서비스 모두 Mock 처리
- 테스트마다 임시 SQLite DB 사용 (격리)
- `npm test` 하나로 전체 실행

---

## 11. 만들고 싶었던 것 — 종합 해석

코드 전체를 읽고 나면 이 프로젝트가 단순히 "CLI 생산성 도구"가 아니라는 걸 알 수 있다.

**핵심 욕구:**

1. **감성 + 실용의 결합** — 고양이 한 마리가 옆에 있어 주는 것 자체가 가치다. 기분이 반응하고, 대화가 따뜻하고, 한국어로 자연스럽게 소통한다.

2. **터미널을 벗어나지 않아도 되는 세계** — IDE/터미널에 있는 개발자가 메모, 할 일, 일정, GitHub, 심지어 웹 검색까지 전부 터미널 안에서 처리할 수 있다.

3. **프라이버시 우선 AI** — 로컬 LLM을 쓴다. 내 메모와 일정이 클라우드로 나가지 않는다. AI 경험을 포기하지 않으면서도 개인 데이터를 내 컴퓨터 안에만 둔다.

4. **자연어가 명령어보다 쉽다** — "내일 오후 3시에 팀 미팅 있어" 라고 말하면 알아서 일정에 추가된다. 복잡한 플래그나 커맨드를 기억할 필요가 없다.

5. **한국어 사용자를 위한 도구** — 대부분의 CLI 도구가 영어 중심인 것에 반해, NekoDesk는 처음부터 한국어가 기본 언어다.

이 모든 것이 합쳐져서 **"내가 진짜 매일 쓰고 싶은 터미널 동반자"** 를 만들려는 시도였다고 볼 수 있다.

---

## 12. 현재 상태와 미완성 부분

`dev` 브랜치 기준, 신규 파일로 보아 현재 진행 중인 작업:

- `backend/services/web-search-client.js` — 신규 (untracked)
- `tests/web-search-client.test.js` — 신규 (untracked)

즉 **웹 검색 기능이 막 추가되는 시점**이다. 인텐트 라우터에 이미 web.search 패턴이 있고, app-controller에서 실행 분기도 보이지만 실제 클라이언트 구현이 방금 추가된 상태.

나머지 수정된 파일들(M)은 웹 검색 통합 과정에서 함께 업데이트된 것으로 보인다.
