# NekoDesk — 에이전트 확장 패키지 조사

> 작성일: 2026-08-26  
> 목적: 로컬 모델(llama.cpp, 4B~8B급)이 실제로 해낼 수 있는 일의 폭을 넓히기 위한 패키지 후보 정리  
> 전제: macOS 전용, Tauri 2 + React 19 + Rust, 프라이버시 우선(로컬 처리 기본)

---

## 0. 판단 기준

작은 로컬 모델은 **"할 수 있는 일이 많은 것"보다 "시킨 일을 틀리지 않는 것"**이 훨씬 어렵다.
그래서 패키지 선택 기준을 이렇게 잡는다.

1. **모델이 직접 안 해도 되게 만드는가** — 날짜 계산, 표 파싱, 수식 계산을 모델이 머리로 하면 틀린다. 코드로 확정한다.
2. **도구 하나가 늘면 프롬프트도 늘어난다** — 도구 설명이 길어질수록 4B 모델의 선택 정확도가 떨어진다. 도구는 적고 강해야 한다.
3. **로컬에서 끝나는가** — 외부 API 키가 필요한 건 후순위.
4. **Rust vs JS** — 파일/OS 접근은 Rust, 문서 파싱·표시는 JS 쪽이 편하다.

---

## 1. 현재 이미 있는 것

새로 깔 필요 없는 항목을 먼저 정리한다.

| 능력 | 현재 구현 |
|------|-----------|
| 스크립트 실행 | `code.exec` (Python / Shell / AppleScript), 30초 상한, 위험 패턴 차단 |
| 웹 검색·본문 추출 | Rust `reqwest` + `scraper` |
| DB | `rusqlite` (todos / events / conversations / exec_history / settings) |
| macOS 앱 제어 | AppleScript 지식 문서 + `code.exec` (Finder, Mail, Calendar, Music, Messages, 브라우저, UI) |
| 알림 | 자체 `notify_send` 커맨드 |
| 외부 도구 확장 | MCP(SSE) 클라이언트 |
| 창 상태 저장 | `tauri-plugin-window-state` |
| 로깅 | `tauri-plugin-log` |

즉 **"OS를 조작하는 능력" 자체는 이미 AppleScript + Shell로 상당히 열려 있다.**
남은 약점은 (1) 파일을 안전하게 다루기 (2) 문서를 읽기 (3) 계산·날짜를 틀리지 않기 (4) 결과를 잘 보여주기 쪽이다.

---

## 2. Tier 1 — 지금 넣으면 체감이 큰 것

### 2.1 파일 다루기

지금은 파일을 읽으려면 모델이 Python을 써야 한다. 4B 모델한테는 그게 실패 지점이 된다.
전용 도구로 빼면 성공률이 확 올라간다.

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `@tauri-apps/plugin-fs` + `tauri-plugin-fs` | 2.5.1 | 파일 읽기/쓰기/목록. capabilities로 접근 범위 제한 필수 |
| `@tauri-apps/plugin-dialog` + `tauri-plugin-dialog` | 2.7.2 | 파일 선택창, 저장창, 확인 다이얼로그 |

붙일 도구: `fs.read`, `fs.write`, `fs.list`, `fs.search`

> 보안: `capabilities/default.json`에 `fs:allow-*` 스코프를 홈 하위 특정 폴더로 좁힌다.
> 전체 디스크 권한을 주면 `code.exec`의 위험 패턴 차단이 의미 없어진다.

### 2.2 클립보드

데스크톱 비서에서 가장 자주 쓰는 통로인데 지금 없다.
"방금 복사한 거 정리해줘"가 한 번에 되면 체감이 크다.

| 패키지 | 버전 |
|--------|------|
| `@tauri-apps/plugin-clipboard-manager` + `tauri-plugin-clipboard-manager` | 2.3.2 |

붙일 도구: `clipboard.read`, `clipboard.write`

### 2.3 계산 정확도

작은 모델은 곱셈·단위 변환·퍼센트에서 자주 틀린다. `code.exec`로 Python을 띄우는 건 무겁다.

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `mathjs` | 15.2.0 | 수식 평가, 단위 변환(`3 kg to lb`), 통계 함수 |

붙일 도구: `math.eval` — 즉시 응답, 프로세스 안 뜸

### 2.4 도구 파라미터 검증

모델이 만든 JSON이 스키마에 안 맞으면 지금은 실행 중에 터진다.
GBNF로 형식은 잡았지만 **값의 의미**(필수 필드 누락, 타입 불일치)는 못 잡는다.

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `zod` | 4.4.3 | 도구 파라미터 런타임 검증. 실패 시 모델에게 교정 메시지를 돌려줌 |

이건 새 기능이 아니라 **기존 도구 전부의 성공률을 올리는 작업**이다. 우선순위 높음.

### 2.5 한국어 날짜 파싱 — 패키지 대신 자체 구현 권장

조사 결과 `chrono-node`(JS 표준 자연어 날짜 파서)는 **한국어를 지원하지 않는다**.
지원 언어는 en/fr/it/ja/nl/ru/uk/vi 등이고 ko는 없다.

지금은 프롬프트에 현재 시각(`현재 날짜/시각: ...`)을 넣고 모델이 ISO로 변환하는 방식인데,
"다음 주 화요일", "이번 달 말", "모레 오후 3시" 같은 상대 표현에서 작은 모델이 자주 틀린다.

권장: **작은 한국어 날짜 파서를 직접 만든다** (~200줄). 규칙이 좁아서 충분히 가능하다.
- 오늘/내일/모레/글피, N일 후, 다음 주 X요일, 이번/다음 달, 월/일 직접 표기
- 오전·오후·새벽·저녁 + 시/분
- 파싱 성공하면 그 값을 쓰고, 실패하면 모델 값으로 폴백

보조로 `date-fns` (4.4.0) 를 쓰면 주 단위 계산·포맷이 깔끔해진다.

---

## 3. Tier 2 — 문서를 읽게 만들기

"이 PDF 요약해줘", "이 엑셀에서 합계 내줘"는 로컬 비서에서 수요가 큰데 지금은 불가능하다.

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `papaparse` | 5.7.0 | CSV 파싱. 가볍고 스트리밍 지원 |
| `pdfjs-dist` | 6.2.108 | PDF 텍스트 추출 (브라우저 런타임에서 동작) |
| `mammoth` | 1.12.1 | .docx → 텍스트/HTML |
| `xlsx` 계열 | — | 엑셀. 라이선스·보안 이슈 이력이 있어 Rust `calamine` 쪽을 권장 |

Rust 대안 (더 빠르고 웹뷰 메모리를 안 먹음):

| crate | 용도 |
|-------|------|
| `calamine` | xlsx/xls/ods 읽기 |
| `lopdf` 또는 `pdf-extract` | PDF 텍스트 추출 |

붙일 도구: `doc.read` — 확장자를 보고 알아서 적절한 파서로 분기, 텍스트로 반환

> 주의: 문서 전체를 컨텍스트에 넣으면 4B 모델이 무너진다.
> 추출 후 **청크 + 요약** 단계를 반드시 끼워야 한다.

---

## 4. Tier 3 — 결과를 잘 보여주기

모델이 코드를 자주 쓰는데 지금 채팅의 코드 블록에 하이라이팅이 없다.

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `shiki` | 4.4.3 | VS Code 문법 하이라이팅. 정확도 최고, 번들 큼 |
| `highlight.js` | — | 더 가벼운 대안 |
| `dompurify` | 3.4.14 | 마크다운에서 HTML을 허용할 경우 XSS 방어 |

웹 스크랩 품질 개선:

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `@mozilla/readability` | 0.6.0 | 기사 본문만 추출 (광고·네비 제거) |
| `turndown` | 7.2.4 | HTML → Markdown. 모델이 읽기 훨씬 좋아짐 |

현재 Rust `scraper`로 뽑은 결과에 네비게이션·푸터가 섞이면 모델이 헛소리를 한다.
`readability` + `turndown` 조합은 **web.scrape 품질을 직접 끌어올리는** 작업이다.

검색·기억:

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `fuse.js` | 7.5.0 | 할 일·대화 이력·실행 기록 퍼지 검색 |

---

## 5. Tier 4 — 나중에

| 패키지 | 용도 | 보류 이유 |
|--------|------|-----------|
| `@tauri-apps/plugin-global-shortcut` (2.3.2) | 전역 단축키 빠른 캡쳐 | 있으면 좋지만 없어도 됨 |
| `@tauri-apps/plugin-notification` (2.3.3) | 표준 알림 | 자체 `notify_send`로 이미 동작 중 |
| `@tauri-apps/plugin-opener` (2.5.4) | URL/파일 열기 | 자체 `open_external_url`로 이미 동작 중 |
| `@tauri-apps/plugin-store` (2.4.4) | KV 설정 저장 | SQLite `settings` 테이블로 이미 동작 중 |
| `@tauri-apps/plugin-updater` | 자동 업데이트 | 배포 단계에서 |
| `@tauri-apps/plugin-os` (2.3.2) | 플랫폼 분기 | macOS 전용이라 불필요 |
| 임베딩 + 벡터 검색 | 장기 기억 | 로컬 임베딩 모델을 하나 더 띄워야 함. 비용 대비 나중 |

---

## 6. 권장 도입 순서

각 단계는 독립적으로 끝나고, 끝날 때마다 체감이 있다.

| 단계 | 내용 | 새 도구 |
|------|------|---------|
| 1 | `zod`로 기존 도구 전부 파라미터 검증 | — (기존 도구 성공률 상승) |
| 2 | 한국어 날짜 파서 자체 구현 + `date-fns` | — (`schedule.add` 정확도 상승) |
| 3 | `plugin-fs` + `plugin-dialog` | `fs.read` `fs.write` `fs.list` |
| 4 | `plugin-clipboard-manager` | `clipboard.read` `clipboard.write` |
| 5 | `mathjs` | `math.eval` |
| 6 | `readability` + `turndown` | — (`web.scrape` 품질 상승) |
| 7 | `papaparse` + PDF/docx 파서 | `doc.read` |
| 8 | `shiki` | — (UI 품질) |
| 9 | `fuse.js` | `memory.search` |

---

## 7. 설치 명령 (단계별)

```bash
# 1~2단계
npm i zod date-fns

# 3단계
npm i @tauri-apps/plugin-fs @tauri-apps/plugin-dialog
cargo add tauri-plugin-fs tauri-plugin-dialog --manifest-path src-tauri/Cargo.toml

# 4단계
npm i @tauri-apps/plugin-clipboard-manager
cargo add tauri-plugin-clipboard-manager --manifest-path src-tauri/Cargo.toml

# 5단계
npm i mathjs

# 6단계
npm i @mozilla/readability turndown @types/turndown

# 7단계
npm i papaparse @types/papaparse mammoth pdfjs-dist
# 또는 Rust 쪽:
cargo add calamine lopdf --manifest-path src-tauri/Cargo.toml

# 8~9단계
npm i shiki fuse.js
```

Tauri 플러그인은 npm 설치만으로 끝나지 않는다. 각각:

1. `src-tauri/Cargo.toml`에 crate 추가
2. `src-tauri/src/lib.rs`의 빌더에 `.plugin(tauri_plugin_xxx::init())`
3. `src-tauri/capabilities/default.json`에 권한 항목 추가 (**스코프를 반드시 좁힐 것**)

---

## 8. 도구 개수에 대한 경고

현재 도구가 13개다. 여기에 위 계획을 다 넣으면 20개가 넘는다.
4B급 모델은 도구가 15개를 넘어가면 **엉뚱한 도구를 고르는 빈도가 눈에 띄게 는다.**

대응책:

- 도구를 **묶는다**: `fs.read`/`fs.write`/`fs.list`를 `file` 하나로 두고 `action` 파라미터로 분기
- 상황별로 **도구 목록을 잘라서** 프롬프트에 넣는다 (파일 얘기가 없으면 파일 도구를 안 보여줌)
- 도구 설명을 짧게. 예시는 지식 문서(`src/agent/knowledge/`)로 뺀다

> 메모:
>
> 
