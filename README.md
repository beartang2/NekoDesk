# NekoDesk

터미널에서 실행하는 ASCII 고양이 펫 + 개인 대시보드 프로젝트입니다.  
메모, 할 일, 일정, GitHub 상태 확인을 한곳에서 다루고, 로컬 LLM과 연결해 자연어 기반 상호작용까지 지원하는 것을 목표로 합니다.

## 현재 구현 범위

- ASCII 고양이 펫 상태 표시
- 자연어 기반 메모 추가 / 조회
- 자연어 기반 할 일 추가 / 완료 / 조회
- 로컬 일정 추가 / 조회
- `GITHUB_TOKEN` 기반 GitHub 읽기 전용 요약
- `llama.cpp` 서버(`localhost:8803`) 기반 대화 및 intent fallback
- SQLite 기반 로컬 저장

## 기본 실행

```bash
npm start
```

앱은 기본적으로 REPL/TUI 형태로 실행됩니다.

## 단일 명령 실행

스모크 체크나 빠른 확인용으로 한 번만 실행할 수도 있습니다.

```bash
node ./bin/nekodesk.js --once "도움말"
```

## 테스트

```bash
npm test
```

## 환경 변수

선택적으로 아래 환경 변수를 사용할 수 있습니다.

- `GITHUB_TOKEN`: GitHub 상태 요약 활성화
- `NEKODESK_HOME`: 기본 앱 데이터 디렉터리 변경
- `NEKODESK_DB_PATH`: SQLite DB 파일 경로 직접 지정
- `NEKODESK_LLM_URL`: LLM 서버 주소, 기본값 `http://127.0.0.1:8803`
- `NEKODESK_LLM_MODEL`: 모델 이름, 기본값 `Qwen3 8B Q4_K_M`
- `NEKODESK_LLM_TIMEOUT_MS`: LLM 요청 타임아웃 밀리초

기본 저장 위치는 `./.nekodesk/nekodesk.sqlite` 입니다.

## 사용 예시

- `메모 프로젝트 아이디어 정리`
- `할 일 README 정리 추가`
- `할 일 1번 완료`
- `내일 3시 회의 등록`
- `오늘 일정 보여줘`
- `내 GitHub 상태 요약해줘`
- `help`
- `exit`

## 프로젝트 방향

NekoDesk는 단순한 CLI 툴이 아니라, 터미널 안에서 함께 있는 펫 같은 감각과 실용적인 생산성 도구를 합치는 것을 지향합니다.

- 기본 펫은 ASCII 고양이
- 표정과 소품이 상태에 따라 조금씩 바뀌는 구조
- 이후 커스텀 ASCII 펫 확장 가능성 고려
- 장기적으로 메모 / 일정 / Todo / GitHub 흐름을 하나의 인터페이스로 연결
