# NekoDesk

macOS 데스크톱 앱. ASCII 고양이 펫과 로컬 LLM 에이전트를 한 창에 담았다.

할 일·일정, 파일 다루기, 웹 검색, 맥 조작을 자연어로 시킬 수 있다. 로컬 모델을
쓰면 대화는 전부 맥 안에서 돈다 — 외부로 나가는 건 사용자가 요청한 웹 검색뿐이다.
원하면 Claude API 로 바꿔 쓸 수도 있다(아래 [Claude 로 돌리기](#claude-로-돌리기)).

## 구성

```
React + TypeScript  ─ 에이전트 루프, 툴 호출, UI
        │ Tauri IPC
Rust                ─ SQLite, 파일 접근, 코드 실행, MCP stdio, llama-server 관리
        │ HTTP
llama-server        ─ 로컬 모델 (기본 127.0.0.1:8803)
```

에이전트 루프는 프런트엔드에 있고, Rust 는 능력(파일·실행·DB)과 그 경계를 맡는다.

## 필요한 것

- macOS
- Node.js 22+
- Rust 1.77+ (`rustup`)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) 의 `llama-server` (`brew install llama.cpp`)
- GGUF 모델 파일 — `~/models/` 에 두면 설정 화면에서 목록으로 잡힌다

## 실행

```bash
npm install
npm run tauri dev
```

llama-server 는 따로 띄우지 않아도 된다. 앱 **설정 → 로컬 LLM 모델 실행** 에서
모델을 고르고 실행하면 앱이 자식 프로세스로 관리하고, 앱을 끄면 같이 정리한다.

직접 띄우고 싶으면 `--jinja` 를 꼭 붙인다. 이게 있어야 모델이 툴을 네이티브로
호출한다(없으면 앱이 알아서 JSON 폴백 모드로 내려간다).

```bash
llama-server -m ~/models/<모델>.gguf --host 127.0.0.1 --port 8803 -c 8192 -ngl 99 --jinja
```

## 할 수 있는 일

| 분류 | 내용 |
|---|---|
| 할 일·일정 | 추가·조회·완료·삭제. 대화 중 나온 할 일은 지시 없이도 알아서 저장 |
| 파일 | 읽기·쓰기·정확한 문자열 치환·목록·glob·grep |
| 코드 실행 | Python / Shell / AppleScript. 볼륨·Music·Finder·Messages·브라우저 등 맥 조작 |
| 웹 | 검색(DuckDuckGo, Brave 키 있으면 Brave)·페이지 읽기·날씨 |
| 기억 | 취향·습관을 세션 너머로 저장하고 관련될 때 자동으로 떠올림 |
| 계획 | 다단계 작업을 스스로 체크리스트로 쪼개고 진행 표시 |
| 공유 | AirDrop 선택 시트 열기 (받는 기기는 사람이 고른다) |
| 게임 | 끝말잇기, 그림 맞추기 |
| MCP | HTTP(SSE)·stdio 서버 연결. 붙이면 그 서버 툴이 목록에 합류 |

이미지를 첨부하면 모델이 직접 본다(mmproj 필요).

### 지식 추가하기

`~/.nekodesk/skills/*.md` 에 넣어두면 키워드가 걸릴 때만 프롬프트에 붙는다.
내장 지식(AppleScript 8종)과 같은 자리에 합류하고, 겹치면 사용자 것이 먼저 온다.

```markdown
---
name: 회사 배포 절차
keywords: 배포, deploy, 릴리스
---
1. main 에서 태그를 찍는다
2. ...
```

`keywords` 가 없으면 영원히 안 걸리므로 무시한다. 앱 시작 시 한 번 읽는다.

## Claude 로 돌리기

Claude 프로필은 처음부터 목록에 있다(처음 설치면 활성, 기존 사용자는 키를 넣어 두면 다음
실행부터 활성). **설정 → 모델 → 모델 프로필** 에서 API 키를 넣고, 제목 표시줄의 모델
칩에서 로컬 모델과 Claude 를 오간다. 이 프로필을 고르면 대화가 Anthropic 으로 나간다.
로컬 프로필과 로컬용 프롬프트·설정은 그대로 남는다.

두뇌에 따라 다른 것(`activeBackend()`): 로컬은 작은 모델용 규칙·grammar·반복 차단·게임
키워드 라우팅을 쓰고, Claude 는 그런 돌보기 없이 native 툴 호출로 가며 툴 결과를 더 길게
(4,000자) 받는다.

- **모델** — Haiku 5.5(기본) · Sonnet 5.5 · Opus 5.5
- **키** — 다른 API 키처럼 macOS 키체인에만 둔다. 화면은 저장 여부만 알고, 키를 붙여
  `api.anthropic.com` 으로 보내는 건 Rust(`src-tauri/src/claude.rs`) 다. 주소가 코드에
  박혀 있어 키가 다른 곳으로 새지 않는다
- **예산** — 응답의 토큰 사용량으로 금액을 추정해 쌓고, 정한 월 예산(기본 $80)을 넘으면
  다음 갱신일까지 요청을 보내지 않는다. 갱신일은 claude.ai 결제일에 맞춘다. 정확한
  청구액은 Console 의 Cost 페이지가 기준이다
- **컨텍스트** — 64K 로 묶는다. Haiku 5.5 는 프롬프트가 10만 토큰을 넘는 요청이 통째로
  5배 가격이 되기 때문이다

Max 5x·20x 요금제에는 매달 API 크레딧이 들어 있다. claude.ai **설정 → 결제 → API
credits** 에서 Console 조직을 연결하고, 그 조직에서 만든 키를 넣으면 거기서 차감된다.
크레딧이 바닥나면 auto-reload 를 켜지 않은 한 요청이 멈출 뿐 청구되지 않는다. 같은
조직의 다른 키(다른 서비스)와 잔액을 나눠 쓰므로, 다른 서비스는 별도 워크스페이스에
지출 한도를 걸어 두는 게 좋다.

Anthropic 의 OpenAI 호환 엔드포인트를 쓰므로 프롬프트 캐싱은 없다. 툴 호출은 늘
native 모드로 간다(json 모드는 llama.cpp 의 grammar 에 기대는 방식이라 성립하지 않는다).

## 안전 장치

- **하드 차단** — `~/.ssh`, `~/.aws`, 키체인, `.env`, `*.pem` 접근과 `sudo`·`rm -rf /`·
  디스크 포맷은 사용자가 승인해도 실행되지 않는다. 파일 툴과 코드 실행이 같은
  목록을 공유한다
- **승인** — 파일 쓰기와 코드 실행은 확인을 받는다. "이 세션 동안" / "항상" 을
  고르면 기억하고, 무엇을 열어뒀는지는 설정에서 보고 취소할 수 있다. 확인 없이 도는
  건 메타문자 없는 한 줄 조회(`date`, `whoami` …)와 알림·볼륨 AppleScript 뿐이다
- **기억할 수 없는 것** — 규칙은 정확히 그 명령만 연다. Python 전체, `;`·`|`·`$()` 가
  든 복합 셸, `python3 -c`·`sh -c` 같은 인터프리터, 앱을 안 고른 AppleScript,
  메시지·메일·System Events·브라우저를 조종하는 스크립트, 홈 바로 아래 파일 쓰기는
  "항상" 버튼이 없다. 밖으로 보내는 코드(메시지·메일·HTTP 전송)는 오토모드여도 매번 묻는다
- **쓰기 검증** — 파일을 쓰거나 고치면 되읽어 대조하고, 실제로 저장된 내용을
  모델에게 돌려준다
- **유출 경로 차단** — 답변 속 원격 이미지는 그리지 않는다(이미지 한 줄로 읽은 내용을
  내보낼 수 있다). 링크는 바깥 브라우저로만 열리고 앱 창은 앱 페이지만 보여준다.
  웹뷰에 CSP 를 건다

## 개발

```bash
npm run typecheck     # 타입 검사
npm test              # 프런트엔드 단위 테스트
npm run test:rust     # Rust 단위 + 통합 테스트
npm run test:all      # 위 셋
npm run test:integration   # 실제 llama-server 를 띄운 채로만 의미 있음
```

`npm run tauri build` 로 `.app` 을 만든다.

## 데이터

- SQLite: `~/Library/Application Support/com.nekodesk.desktop/nekodesk.sqlite`
  (개발 빌드는 그 옆의 `nekodesk-dev/` 를 따로 쓴다 — 실사용 데이터와 안 섞인다)
- 스키마는 `PRAGMA user_version` 으로 버전을 추적한다. 컬럼을 더할 때는
  `db::MIGRATIONS` 끝에 추가하고, 이미 배포된 항목은 고치지 않는다

## 라이선스

MIT
