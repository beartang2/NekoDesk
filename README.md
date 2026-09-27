# NekoDesk

🐱 픽셀 고양이 펫 + 로컬 LLM 에이전트 데스크톱 앱 (macOS)

로컬 `llama.cpp` 모델을 두뇌로 쓰는 데스크톱 에이전트입니다. 한국어로 말을 걸면 할 일·일정을 정리하고,
필요하면 직접 스크립트를 짜서 실행하고, 웹을 찾아보고, 그 사이 고양이가 옆에서 반응합니다.
데이터는 전부 로컬 SQLite에 남고 외부 클라우드로 나가지 않습니다.

## 기능

### 에이전트 도구

모델이 상황에 따라 직접 호출하는 도구 목록입니다.

| 도구 | 설명 |
|------|------|
| `todo.list` / `todo.list_done` / `todo.add` / `todo.complete` | 할 일 관리 |
| `schedule.list` / `schedule.add` / `schedule.delete` | 캘린더 일정 기록·조회·삭제 |
| `code.exec` | Python / Shell / AppleScript 스크립트를 로컬에서 실행 (30초 상한, 위험 패턴 차단) |
| `file` | 로컬 파일 읽기/쓰기/폴더 목록 (`action` 으로 분기, 접근 범위 제한됨) |
| `clipboard` | 클립보드 읽기/쓰기 |
| `math.eval` | 수식 계산과 단위 변환 (`3 kg to lb`) |
| `web.search` / `web.scrape` | 웹 검색과 페이지 본문 추출 |
| `weather.get` | 현재 날씨와 단기 예보 |
| `file.upload` | 첨부 파일을 HTTP 엔드포인트로 업로드 |
| `game.start` | 미니게임 (그림 맞추기 / 끝말잇기) |

모든 도구는 실행 전에 zod 스키마로 파라미터를 검증한다. 검증에 걸리면 어떤 필드가
왜 잘못됐는지가 모델에게 되돌아가서 스스로 고쳐 재호출한다.

일정·마감 날짜는 한국어 상대 표현("다음 주 화요일", "내일 오후 3시")을 앱이
결정론적으로 ISO로 변환한다. 모델의 날짜 산수를 신뢰하지 않는다.

추가로 MCP(SSE 전송) 서버를 연결하면 그 서버의 도구도 같은 루프에서 쓸 수 있습니다.

### UI

- **좌측**: 픽셀 고양이 스테이지 — 스프라이트 애니메이션, 기분 상태, 트랙패드 쓰다듬기, RPG 레이어
- **중앙**: 채팅 — 스트리밍 응답, 에이전트 단계 아코디언, 마크다운/표 렌더링
- **우측 패널**: 할 일 카드 / 캘린더 카드 / 뽀모도로 / 코드 실행 결과
- `⌘K` 커맨드 팔레트, `⌘N` 새 대화

### 모델 라이프사이클

- 앱이 `llama-server`를 직접 기동/종료합니다 (`~/models`의 `.gguf` 스캔).
- 앱 종료 시 자식 프로세스를 확실히 정리하고, 시작 시 고아 프로세스를 청소합니다.
- 시스템 프롬프트는 정적으로 유지해 llama.cpp의 프롬프트 캐시가 살아있게 합니다 (TTFT 약 10.7s → 0.36s).
- 기동 직후 에이전트 시스템 프롬프트를 미리 처리(워밍업)해 두어, 첫 질문부터 캐시를 탑니다.
- llama-server 기본값(슬롯 4개·슬롯당 체크포인트 32개·프롬프트 캐시 8GiB)은 1인용 앱에 과해서
  `--parallel 1 --ctx-checkpoints 4 --cache-ram 1024`로 호스트 RAM 상한을 둡니다.
  Qwen3.5 같은 하이브리드 모델은 체크포인트 1개가 약 52.7MB라, 기본값이면 모델과 별개로 최대 ~10GB가 쌓일 수 있습니다.
- 도구 호출 JSON은 GBNF 문법으로 강제해 파싱 실패를 원천 차단합니다.

## 기술 스택

| 영역 | 스택 |
|------|------|
| 셸 | Tauri 2 |
| 프론트엔드 | React 19 + TypeScript + Vite |
| 상태 관리 | Zustand (`messageStore` / `sessionStore` / `settingsStore` / `catStore`) |
| 백엔드 | Rust (rusqlite, reqwest, scraper) |
| 저장소 | SQLite (todos / events / conversations / exec_history / settings) |
| 모델 | 로컬 llama.cpp (OpenAI 호환 엔드포인트, 기본 `http://127.0.0.1:8803`) |
| 테스트 | Vitest (프론트) + `cargo test` (Rust) |

## 준비 사항

- macOS
- Node.js 20+
- Rust 1.77.2+
- `llama-server` (Homebrew의 `llama.cpp` 등)
- `~/models` 아래에 `.gguf` 모델 파일

## 실행

```bash
npm install
npm run tauri dev
```

앱 안에서 설정 모달을 열어 모델을 고르고 기동하면 됩니다. LLM 주소 기본값은 `http://127.0.0.1:8803`입니다.

## 테스트

```bash
npm run test        # Vitest
npm run test:rust   # cargo test --lib
npm run typecheck   # tsc --noEmit
npm run test:all    # 위 세 가지 전부
```

## 평가 (로컬 모델 성능 측정)

실제 llama-server에 실제 에이전트 프롬프트를 보내고, 첫 스텝에서 **어떤 도구를 어떤 값으로
부르려 했는지** 채점합니다. 도구는 실행하지 않으므로 음악 재생·파일 쓰기 같은 부작용이 없습니다.

```bash
npm run eval                               # 전체 (앱에서 모델을 켜둔 상태로)
NEKO_EVAL_ONLY=음악 npm run eval           # 카테고리 또는 케이스 id로 골라서
NEKO_EVAL_RUNS=3 npm run eval              # 케이스마다 3번씩 (답이 흔들리는지)
NEKO_EVAL_URL=http://127.0.0.1:8803        # 서버 주소 (기본값)
NEKO_EVAL_PROFILE_FILE=profile.txt         # 앱의 "사용자 프로필"과 같은 내용 (선택)
```

결과는 `eval/results/latest.md`(요약)와 타임스탬프 JSON(모델 응답 원본)으로 남습니다.
케이스는 `eval/cases.ts`에 있고, 프롬프트나 설정을 바꾸기 전후로 돌려서 점수를 비교하면 됩니다.

## 문서

| 문서 | 내용 |
|------|------|
| `docs/plan.md` | 제품 계획 (0번 섹션이 현재 확정 스코프) |
| `docs/packages.md` | 에이전트 확장용 패키지 조사 및 도입 우선순위 |
| `docs/agentic-loop.md` | 에이전틱 루프 설계 |
| `docs/cat-rpg.md` | 고양이 RPG 레이어 설계 |
| `docs/minigame-design.md` | 미니게임 설계 |
| `docs/research.md` | TUI 시절 구조 분석 (역사적 자료) |

## 스코프에서 빠진 것

초기 계획에 있었지만 현재는 제외된 기능입니다.

- **메모** — 제거됨 (할 일과 역할이 겹침)
- **GitHub API 연동** — 제거됨
- **터미널 TUI/CLI** — 데스크톱 앱으로 완전히 대체됨

이전 CLI/TUI 버전 코드는 `feat/pet-tui`, `feat/github-llm`, `dev` 브랜치에 보존되어 있습니다.
