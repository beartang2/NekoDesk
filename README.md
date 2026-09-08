# NekoDesk

macOS 데스크톱 앱. ASCII 고양이 펫과 로컬 LLM 에이전트를 한 창에 담았다.

할 일·일정, 파일 다루기, 웹 검색, 맥 조작을 자연어로 시킬 수 있고, 대화는 전부
로컬에서 돈다 — 외부로 나가는 건 사용자가 요청한 웹 검색뿐이다.

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

## 안전 장치

- **하드 차단** — `~/.ssh`, `~/.aws`, 키체인, `.env`, `*.pem` 접근과 `sudo`·`rm -rf /`·
  디스크 포맷은 사용자가 승인해도 실행되지 않는다. 파일 툴과 코드 실행이 같은
  목록을 공유한다
- **승인** — 파일 쓰기와 코드 실행은 확인을 받는다. "이 세션 동안" / "항상" 을
  고르면 기억하고, 무엇을 열어뒀는지는 설정에서 보고 취소할 수 있다
- **쓰기 검증** — 파일을 쓰거나 고치면 되읽어 대조하고, 실제로 저장된 내용을
  모델에게 돌려준다

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

- SQLite: `~/Library/Application Support/com.nekodesk.app/nekodesk.sqlite`
  (개발 빌드는 그 옆의 `nekodesk-dev/` 를 따로 쓴다 — 실사용 데이터와 안 섞인다)
- 스키마는 `PRAGMA user_version` 으로 버전을 추적한다. 컬럼을 더할 때는
  `db::MIGRATIONS` 끝에 추가하고, 이미 배포된 항목은 고치지 않는다

## 라이선스

MIT
