# NekoDesk

터미널에서 실행하는 ASCII 고양이 펫 + 개인 대시보드 프로젝트입니다.  
메모, 할 일, 일정, GitHub 상태 확인을 한곳에서 다루고, 로컬 LLM과 연결해 자연어 기반 상호작용까지 지원하는 것을 목표로 합니다.

## 현재 구현 범위

- ASCII 고양이 펫 상태 표시
- 자연어 기반 메모 추가 / 조회
- 자연어 기반 할 일 추가 / 완료 / 조회
- 로컬 일정 추가 / 조회
- `GITHUB_TOKEN` 기반 GitHub 읽기 전용 요약 및 follow-up 질의
- DuckDuckGo 기반 읽기 전용 웹 검색
- `FastAPI` 백엔드(`localhost:8000`)를 통한 대화 / intent 처리
- `llama.cpp` 서버(`localhost:8803`)를 FastAPI 뒤에서 사용
- SQLite 기반 로컬 저장

## 준비 사항

- Node.js 22+
- Python 3.11+
- 로컬 `llama.cpp` 서버 실행 환경
- 선택: `GITHUB_TOKEN`

## 설치

Node 패키지:

```bash
npm install
```

Python 패키지:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 실행 순서

### 1. llama.cpp 서버 실행

예시는 현재 프로젝트 기본값인 `localhost:8803` 기준입니다.

```bash
llama-server \
  -m ~/models/Qwen3-8B-Q4_K_M.gguf \
  --host 127.0.0.1 \
  --port 8803
```

### 2. FastAPI 백엔드 실행

프로젝트 루트에서:

```bash
source .venv/bin/activate
uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
```

확인:

```bash
curl http://127.0.0.1:8000/health
```

### 3. NekoDesk TUI 실행

```bash
npm start
```

앱은 기본적으로 REPL/TUI 형태로 실행됩니다.

정리하면 실행 순서는 아래와 같습니다.

1. `llama.cpp`
2. `FastAPI`
3. `npm start`

## 단일 명령 실행

스모크 체크나 빠른 확인용으로 한 번만 실행할 수도 있습니다.

```bash
node ./bin/nekodesk.js --once "/help"
```

## 테스트

```bash
npm test
```

FastAPI 파일 문법만 빠르게 확인하려면:

```bash
python3 -m py_compile backend/main.py backend/routers/chat.py backend/routers/github.py
```

## 환경 변수

선택적으로 아래 환경 변수를 사용할 수 있습니다.

- `GITHUB_TOKEN`: GitHub 상태 요약 활성화
- `NEKODESK_LLM_GITHUB_QUERY_SYSTEM_PROMPT`: GitHub follow-up 답변용 system prompt 텍스트
- `NEKODESK_LLM_GITHUB_QUERY_SYSTEM_PROMPT_FILE`: GitHub follow-up 답변 prompt 파일 경로
- `NEKODESK_HOME`: 기본 앱 데이터 디렉터리 변경
- `NEKODESK_DB_PATH`: SQLite DB 파일 경로 직접 지정
- `NEKODESK_CONVERSATION_MEMORY_LIMIT`: 메모리에 유지할 최근 대화 메시지 개수
- `NEKODESK_WEB_SEARCH_ENABLED`: 웹 검색 tool 활성화 여부, 기본값 `true`
- `NEKODESK_WEB_SEARCH_TIMEOUT_MS`: 웹 검색 타임아웃 밀리초, 기본값 `8000`
- `NEKODESK_WEB_SEARCH_RESULT_LIMIT`: 웹 검색 결과 최대 개수, 기본값 `5`
- `NEKODESK_LLM_URL`: 내부 llama.cpp 주소용 설정값, 기본값 `http://127.0.0.1:8803`
- `NEKODESK_LLM_API_PATH`: 내부 llama.cpp endpoint 경로, 기본값 `/v1/chat/completions`
- `NEKODESK_LLM_MODEL`: 모델 이름, 기본값 `Qwen3 8B Q4_K_M`
- `NEKODESK_LLM_TIMEOUT_MS`: LLM 요청 타임아웃 밀리초
- `NEKODESK_LLM_HISTORY_LIMIT`: 대화 컨텍스트에 포함할 최근 메시지 개수
- `NEKODESK_LLM_CHAT_TEMPERATURE`: 일반 대화 temperature
- `NEKODESK_LLM_INTENT_TEMPERATURE`: intent 분류 temperature
- `NEKODESK_LLM_INTENT_MAX_TOKENS`: intent 분류 응답 최대 토큰 수, 기본값 `48`
- `NEKODESK_LLM_TOOL_PLAN_TEMPERATURE`: chat 경로에서 내부 tool 계획용 temperature
- `NEKODESK_LLM_TOOL_PLAN_MAX_TOKENS`: chat 경로에서 내부 tool 계획 응답 최대 토큰 수
- `NEKODESK_LLM_TOOL_PLAN_SYSTEM_PROMPT`: 내부 tool planner system prompt 텍스트
- `NEKODESK_LLM_MAX_TOKENS`: 최대 출력 토큰 수
- `NEKODESK_LLM_HEADERS_JSON`: 추가 HTTP 헤더 JSON
- `NEKODESK_LLM_BODY_JSON`: 추가 request body JSON
- `NEKODESK_LLM_CHAT_SYSTEM_PROMPT`: 기본 대화 system prompt 텍스트
- `NEKODESK_LLM_INTENT_SYSTEM_PROMPT`: intent 분류 system prompt 텍스트
- `NEKODESK_LLM_TOOL_PLAN_SYSTEM_PROMPT_FILE`: tool planner prompt 파일 경로
- `NEKODESK_LLM_CHAT_SYSTEM_PROMPT_FILE`: 대화 prompt 파일 경로
- `NEKODESK_LLM_INTENT_SYSTEM_PROMPT_FILE`: intent prompt 파일 경로
- `NEKODESK_LLM_FALLBACK_REPLY`: 모델 응답이 비었을 때 사용할 문구
- `NEKODESK_LLM_CONNECTION_ERROR_REPLY`: LLM 연결 실패 시 문구

기본 저장 위치는 `./.nekodesk/nekodesk.sqlite` 입니다.

현재 Node 앱의 LLM 호출은 FastAPI `POST http://127.0.0.1:8000/chat`을 사용하고, FastAPI가 다시 `llama.cpp`로 요청을 전달합니다.

## 사용 예시

- `메모 프로젝트 아이디어 정리`
- `할 일 README 정리 추가`
- `할 일 1번 완료`
- `내일 3시 회의 등록`
- `오늘 일정 보여줘`
- `내 GitHub 상태 요약해줘`
- `OpenAI 최신 뉴스 검색해줘`
- `이 오류 메시지 웹에서 찾아봐`
- `/github` 뷰에서 `지금 뭘 먼저 봐야 해?`
- `/github` 뷰에서 `리뷰 요청 있는 PR이 뭐야?`
- `/help`
- `/exit`

## 프로젝트 방향

NekoDesk는 단순한 CLI 툴이 아니라, 터미널 안에서 함께 있는 펫 같은 감각과 실용적인 생산성 도구를 합치는 것을 지향합니다.

- 기본 펫은 ASCII 고양이
- 표정과 소품이 상태에 따라 조금씩 바뀌는 구조
- 이후 커스텀 ASCII 펫 확장 가능성 고려
- 장기적으로 메모 / 일정 / Todo / GitHub 흐름을 하나의 인터페이스로 연결
