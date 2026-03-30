# NekoDesk

ASCII cat pet + personal dashboard for the terminal.

## Features

- ASCII cat pet with mood-based face and tiny frame swaps
- Natural-language memo, todo, and local schedule management
- Read-only GitHub overview via `GITHUB_TOKEN`
- LLM-backed chat and intent fallback through `llama.cpp` on `localhost:8803`
- Local SQLite storage under `./.nekodesk/nekodesk.sqlite` by default

## Run

```bash
npm start
```

One-shot mode for smoke checks:

```bash
node ./bin/nekodesk.js --once "도움말"
```

## Environment

Optional environment variables:

- `GITHUB_TOKEN`: enables GitHub overview
- `NEKODESK_HOME`: overrides the default app data directory
- `NEKODESK_DB_PATH`: overrides SQLite file location
- `NEKODESK_LLM_URL`: defaults to `http://127.0.0.1:8803`
- `NEKODESK_LLM_MODEL`: defaults to `Qwen3 8B Q4_K_M`
- `NEKODESK_LLM_TIMEOUT_MS`: request timeout in milliseconds

## Examples

- `메모 프로젝트 아이디어 정리`
- `할 일 README 정리 추가`
- `할 일 1번 완료`
- `내일 3시 회의 등록`
- `오늘 일정 보여줘`
- `내 GitHub 상태 요약해줘`

## Tests

```bash
npm test
```
