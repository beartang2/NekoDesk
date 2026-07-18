# NekoDesk — 고양이 에이전틱 루프 계획

> 작성일: 2026-04-19  
> 목적: 데스크톱 앱 전환 전, 에이전틱 루프를 NekoDesk에 통합하기 위한 설계 문서  
> 대상 모델: Qwen3.5-4B-Q4_K_M (llama.cpp)

---

## 1. 왜 에이전틱 루프인가

### 현재 구조의 한계

현재 NekoDesk는 선형 3단계 파이프라인이다.

```
User input
  → [1단계] Intent Classify (LLM, temp 0.1, 48 tokens)
  → [2단계] Tool Plan (LLM, temp 0.1, 96 tokens)
  → [3단계] Chat Response (LLM, temp 0.7)
```

이 구조는 단순하고 안정적이지만, 다음 상황을 처리하지 못한다.

- "오늘 할 일 중에 프로젝트 관련된 게 있으면 GitHub에서 관련 이슈도 찾아줘"
  → 할 일 조회 → 결과 해석 → GitHub 검색 → 종합 응답 (2단계 이상)
- "메모에서 회의 내용 찾아서 거기 적힌 링크 웹에서 검색해줘"
  → 메모 검색 → 링크 추출 → 웹 검색 → 응답 (3단계)
- "어제 추가한 할 일이 완료됐으면 자축 메모 남겨줘"
  → 할 일 조회 → 상태 확인 → 메모 추가 (조건 분기)

에이전틱 루프는 이런 **다단계, 조건 분기, 결과 의존형 작업**을 처리한다.

---

## 2. 루프 구조 설계

### 전체 흐름

```
User input
  │
  ▼
[AgentContext 초기화]
  │
  ▼
┌──────────────────────────────────┐
│  Loop (max 5 iterations)         │
│                                  │
│  [LLM Agent Step]                │
│   → thought + tool + params      │
│   또는 thought + finalAnswer     │
│                                  │
│  tool이 none → 루프 종료         │
│  tool이 있으면 → 실행            │
│                                  │
│  [Tool Execute]                  │
│   → result (truncated)           │
│                                  │
│  [Context Update]                │
│   → 결과 압축해서 주입           │
│                                  │
│  → 다음 iteration                │
└──────────────────────────────────┘
  │
  ▼
[Cat State Update]
[Step Log → UI Accordion]
[Final Response → Chat]
```

---

## 3. LLM 에이전트 스텝 설계

### 프롬프트 구조 (4B 모델 최적화)

소형 모델일수록 지시가 단순해야 한다. 매 스텝마다 LLM에 전달하는 메시지 구조:

```
[System]
너는 NekoDesk 고양이 어시스턴트야.
사용자를 도우려면 아래 툴 중 하나를 골라 JSON으로만 응답해.
툴이 필요 없으면 tool을 "none"으로 하고 finalAnswer에 최종 답변을 써.

사용 가능한 툴:
- memo.find(query): 메모 검색
- memo.add(content, tags?): 메모 추가
- todo.list(): 할 일 목록
- todo.add(content, due_at?): 할 일 추가
- todo.complete(id): 할 일 완료
- schedule.list(range?): 일정 조회
- schedule.add(title, start_at, end_at?): 일정 추가
- github.overview(): GitHub 현황
- web.search(query): 웹 검색

응답 형식 (JSON만, 다른 텍스트 없음):
{
  "thought": "한 문장 이내 생각",
  "tool": "툴이름 또는 none",
  "params": {},
  "finalAnswer": "tool이 none일 때만"
}

[User]
{사용자 입력}

[Tool Result - iteration N]
{이전 툴 결과 요약}
```

### Thinking Mode 활용

Qwen3 계열은 `/think` 모드를 지원한다. `<think>` 블록 내용을 로깅하되 사용자에게는 고양이 행동으로만 표현한다.

```
LLM 원본 출력:
<think>
할 일 목록을 먼저 가져온 다음, 프로젝트 관련 항목을 필터해야겠다.
</think>
{"thought": "할 일 먼저 확인", "tool": "todo.list", "params": {}}
```

- `<think>` 내용 → 고양이 `curious_look` 또는 `working_type` 트리거
- `<think>` 내용 → Accordion 패널의 "생각" 섹션에 노출 (접힌 상태)

---

## 4. Tool Registry 설계

기존 인텐트 시스템을 툴 인터페이스로 감싼다. 새로 만드는 게 아니라 래핑.

```js
// src/agent/tool-registry.js
export const TOOL_REGISTRY = {
  "memo.find": {
    description: "메모를 검색한다",
    params: { query: { type: "string", required: true } },
    execute: async (p, repos) => repos.memo.search(p.query),
    resultLimit: 3,           // 최대 3개 결과만 컨텍스트에 주입
    tokenEstimate: 200
  },
  "memo.add": {
    description: "메모를 추가한다",
    params: { content: { type: "string", required: true }, tags: { type: "array" } },
    execute: async (p, repos) => repos.memo.create(p),
    resultLimit: 1,
    tokenEstimate: 50
  },
  "todo.list": {
    description: "할 일 목록을 가져온다",
    params: {},
    execute: async (p, repos) => repos.todo.listOpen(),
    resultLimit: 5,
    tokenEstimate: 300
  },
  "todo.add": {
    description: "할 일을 추가한다",
    params: { content: { type: "string", required: true }, due_at: { type: "string" } },
    execute: async (p, repos) => repos.todo.create(p),
    resultLimit: 1,
    tokenEstimate: 50
  },
  "todo.complete": {
    description: "할 일을 완료 처리한다",
    params: { id: { type: "number", required: true } },
    execute: async (p, repos) => repos.todo.complete(p.id),
    resultLimit: 1,
    tokenEstimate: 50
  },
  "schedule.list": {
    description: "일정을 조회한다",
    params: { range: { type: "string" } },
    execute: async (p, repos) => repos.schedule.list(p.range),
    resultLimit: 5,
    tokenEstimate: 300
  },
  "schedule.add": {
    description: "일정을 추가한다",
    params: {
      title: { type: "string", required: true },
      start_at: { type: "string", required: true },
      end_at: { type: "string" }
    },
    execute: async (p, repos) => repos.schedule.create(p),
    resultLimit: 1,
    tokenEstimate: 50
  },
  "github.overview": {
    description: "GitHub 현황을 가져온다",
    params: {},
    execute: async (p, clients) => clients.github.getOverview(),
    resultLimit: 10,
    tokenEstimate: 500
  },
  "web.search": {
    description: "웹에서 정보를 검색한다",
    params: { query: { type: "string", required: true } },
    execute: async (p, clients) => clients.webSearch.search(p.query),
    resultLimit: 3,
    tokenEstimate: 400
  }
}
```

---

## 5. AgentContext 설계

컨텍스트 토큰 비용을 제어하면서 루프 상태를 관리한다.

```js
// src/agent/agent-context.js
class AgentContext {
  constructor(userInput, chatHistory) {
    this.userInput = userInput;
    this.chatHistory = chatHistory.slice(-6); // 최근 6개만
    this.steps = [];          // 각 iteration 결과 로그
    this.totalTokens = 0;
    this.MAX_CONTEXT_TOKENS = 3000; // 4B 모델 컨텍스트 예산
  }

  addStep(thought, tool, params, result) {
    const step = {
      id: this.steps.length + 1,
      timestamp: Date.now(),
      thought,
      tool,
      params,
      result,           // raw result (UI 표시용)
      summary: this.summarizeResult(tool, result) // 압축된 요약 (다음 LLM 입력용)
    };
    this.steps.push(step);
    return step;
  }

  summarizeResult(tool, result) {
    // 툴별 결과 압축 전략
    if (tool === "web.search") {
      return result.slice(0, 3).map(r => `- ${r.title}: ${r.snippet}`).join("\n");
    }
    if (tool === "todo.list") {
      return result.slice(0, 5).map(r => `- [${r.status}] ${r.content}`).join("\n");
    }
    return JSON.stringify(result).slice(0, 500); // 기본 500자 제한
  }

  toMessages() {
    // LLM에 전달할 메시지 배열 조립
    const messages = [
      { role: "system", content: AGENT_SYSTEM_PROMPT },
      ...this.chatHistory,
      { role: "user", content: this.userInput }
    ];

    // 이전 스텝 결과 주입
    for (const step of this.steps) {
      messages.push({
        role: "assistant",
        content: JSON.stringify({ thought: step.thought, tool: step.tool, params: step.params })
      });
      messages.push({
        role: "tool",
        content: `[${step.tool} 결과]\n${step.summary}`
      });
    }

    return messages;
  }
}
```

---

## 6. Loop Orchestrator 설계

```js
// src/agent/agent-loop.js
export async function runAgentLoop({ userInput, chatHistory, repos, clients, emitters }) {
  const MAX_ITERATIONS = 5;
  const context = new AgentContext(userInput, chatHistory);

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // 고양이 상태 업데이트
    emitters.catState('curious');
    emitters.loopStep({ type: 'thinking', iteration: i + 1 });

    // LLM 스텝 실행
    const raw = await llmClient.agentStep(context.toMessages());
    const step = parseAgentStep(raw); // JSON 파싱 + fallback 처리

    // 종료 조건: tool === "none" 또는 finalAnswer 존재
    if (step.tool === 'none' || step.finalAnswer) {
      emitters.catState(deriveCatEmotion(context.steps));
      emitters.loopDone({ steps: context.steps, answer: step.finalAnswer });
      return { answer: step.finalAnswer, steps: context.steps };
    }

    // 툴 실행
    emitters.catState('working');
    emitters.loopStep({ type: 'tool_call', tool: step.tool, params: step.params });

    const toolDef = TOOL_REGISTRY[step.tool];
    if (!toolDef) {
      // 알 수 없는 툴 → 루프 종료
      break;
    }

    const result = await toolDef.execute(step.params, { repos, clients });

    emitters.loopStep({ type: 'tool_result', tool: step.tool, result });

    // 컨텍스트에 스텝 기록
    context.addStep(step.thought, step.tool, step.params, result);
  }

  // 최대 반복 도달 — 지금까지 모은 정보로 응답 생성
  emitters.catState('sleepy');
  const fallback = await llmClient.chat(context.toMessages());
  return { answer: fallback, steps: context.steps };
}
```

---

## 7. 고양이 상태 ↔ 루프 단계 매핑

| 루프 단계 | 고양이 상태 | 설명 |
|----------|------------|------|
| 루프 시작 | `curious_look` | 뭘 해야 할지 생각 중 |
| LLM thinking | `working_type` | `<think>` 블록 처리 중 |
| 툴 실행 중 | `working_type` | 실제 데이터 가져오는 중 |
| 툴 성공 | `curious_look` | 결과 확인 후 다음 스텝 고민 |
| 루프 성공 종료 | `happy_bounce` | 작업 완료 |
| 루프 max 도달 | `sleepy_doze` | 힘들었다 |
| 툴 에러 | `error_freeze` | 뭔가 잘못됨 |

---

## 8. UI — 스텝 로그 아코디언

각 에이전트 루프 스텝을 **접힌 아코디언**으로 채팅 메시지 위에 표시한다.

### 아코디언 항목 구조

```
┌────────────────────────────────────────────┐
│ ▶ 1단계: todo.list 호출  [✓ 완료]  [펼치기]│
└────────────────────────────────────────────┘

펼치면:
┌────────────────────────────────────────────┐
│ ▶ 1단계: todo.list 호출  [✓ 완료]  [접기] │
│                                            │
│ 💭 생각                                    │
│   할 일 목록을 먼저 확인해야겠다           │
│                                            │
│ 📤 Request                                 │
│   ```json                                  │
│   { "tool": "todo.list", "params": {} }    │
│   ```                                      │
│                                            │
│ 📥 Response                                │
│   ```                                      │
│   - [open] 프로젝트 문서 작성 (D-3)        │
│   - [open] 코드 리뷰 (D-1)                 │
│   - [done] 회의 준비                       │
│   ```                                      │
└────────────────────────────────────────────┘
```

### 아코디언 헤더 상태

| 상태 | 아이콘 | 색상 |
|------|--------|------|
| 진행 중 | ⏳ | 회청 |
| 성공 | ✓ | 세이지 그린 |
| 실패 | ✗ | 브릭 레드 |

### 기본 동작 규칙

- **기본: 모두 접힘** — 채팅 영역을 많이 차지하지 않음
- **마지막 스텝만 자동으로 열림** — 현재 진행 상황 파악용
- 완료 후에는 모두 접힘
- "N개 스텝 펼치기" 버튼으로 전체 토글 가능
- 각 스텝은 독립적으로 열고 닫기 가능

### React 컴포넌트 구조

```tsx
// AgentStepLog.tsx
<AgentStepsContainer>
  {steps.map((step, i) => (
    <AgentStepAccordion
      key={step.id}
      step={step}
      defaultOpen={i === steps.length - 1 && isRunning}
    >
      <StepThought thought={step.thought} />
      <StepRequest tool={step.tool} params={step.params} />
      <StepResponse tool={step.tool} result={step.result} />
    </AgentStepAccordion>
  ))}
</AgentStepsContainer>
```

### 표시 형식 규칙

| 내용 | 표시 방식 |
|------|---------|
| `thought` | 일반 텍스트, 작은 폰트 |
| `params` (request) | JSON 코드블럭, 신택스 하이라이팅 |
| `result` (response) | 툴 종류별 포맷 (목록, 코드블럭, 링크 카드) |
| `<think>` 원본 | 별도 토글로 숨김 (디버그용) |

---

## 9. 컨텍스트 압축 전략

4B 모델의 컨텍스트 한계를 넘지 않도록:

### 예산 분배 (max 4096 tokens 기준)

| 구간 | 토큰 예산 |
|------|---------|
| System prompt | 400 |
| Chat history (최근 6개) | 800 |
| 현재 user input | 200 |
| 누적 tool 결과 (요약) | 1800 |
| LLM 출력 여유 | 600 |
| 버퍼 | 296 |

### 결과 요약 규칙

- 각 툴 결과는 `resultLimit` 개수로 자른다
- 텍스트는 최대 500자로 자른다
- 이전 스텝 결과는 iteration이 쌓일수록 더 짧게 요약

---

## 10. 에러 처리와 폴백

### JSON 파싱 실패

LLM이 유효하지 않은 JSON을 반환하면:

1. `response_format: json_schema` 강제 사용 (llama.cpp 지원)
2. 파싱 실패 시 regex로 JSON 블럭 추출 재시도
3. 2회 연속 실패 시 해당 스텝 스킵 후 루프 종료

### 툴 실행 실패

- 에러 메시지를 tool result로 LLM에 전달
- LLM이 다른 툴로 대체할 기회를 줌
- 동일 툴 실패 2회 → 강제 종료

### LLM 서버 오프라인

- 기존 폴백 유지: "로컬 기능은 계속 사용 가능"
- 고양이: `error_freeze`

---

## 11. 기존 코드와의 통합 경계

에이전틱 루프를 추가해도 기존 흐름을 완전히 교체하지 않는다.

### 분기 기준

```
User input
  │
  ├─ 단순 인텐트 (결정론적 패턴 매칭 성공)
  │    → 기존 intent-router 흐름 유지 (빠름)
  │
  ├─ 다단계 요청 감지 (키워드: "그리고", "다음에", "~하면", "~한 후에")
  │    → 에이전틱 루프 실행
  │
  └─ 단순 대화
       → 기존 chat 흐름 유지
```

에이전틱 루프는 **선택적 경로**로 추가된다. 기존 시스템을 건드리지 않음.

---

## 12. 구현 순서

### Phase 1 — 뼈대 (기존 CLI에서 검증)

- [ ] `src/agent/tool-registry.js` 작성 (기존 repos 래핑)
- [ ] `src/agent/agent-context.js` 작성
- [ ] `src/agent/agent-loop.js` 작성
- [ ] `llmClient.agentStep()` 메서드 추가
- [ ] 기존 `app-controller.js`에 루프 분기 연결
- [ ] 단위 테스트: 툴 레지스트리, 컨텍스트 압축, JSON 파싱 폴백

### Phase 2 — 데스크톱 UI 연결 (Tauri/React)

- [ ] `AgentStepAccordion` 컴포넌트 구현
- [ ] `AgentStepsContainer` (스텝 목록)
- [ ] `StepRequest` / `StepResponse` 코드블럭 뷰어
- [ ] emitter → Tauri event → React state 연결
- [ ] 고양이 상태 연동 (루프 단계별 emotion trigger)

### Phase 3 — 안정화

- [ ] 컨텍스트 토큰 예산 실측 조정
- [ ] 한국어 재시도 로직 에이전트 스텝에도 적용
- [ ] `<think>` 블록 파싱 및 UI 연동
- [ ] 아코디언 UX 실사용 피드백 반영

---

## 13. 열린 질문

- `response_format: json_schema`를 llama.cpp에서 4B 모델로 쓸 때 속도 저하가 얼마나 되는지 실측 필요
- Qwen3.5-4B에서 `/think` 모드가 툴 콜 JSON과 함께 안정적으로 작동하는지 확인 필요
- 다단계 요청 감지 기준이 너무 넓으면 단순 질문도 루프로 들어갈 수 있음 → 임계값 조정 필요
- 루프 진행 중 사용자가 Stop 누를 때 partial 상태 처리 방식

> 메모:
>
>
