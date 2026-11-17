# 네코 P2 — 감독(Director) 설계

> 작성일: 2026-11-17
> 상위 문서: [`neko-v26-integration.md`](neko-v26-integration.md) — 이 문서는 그중 §5.2(루프 이벤트)·§5.3(도구)·§5.6(앱 상황)·§6(감독 규칙)을 실제로 만들 수 있게 자세히 정한다.
> 진행(2026-11-17): **구현 끝**. `src/neko/director/`(session·toolActivity·derive·scheduler + 테스트 49개), `src/neko/useNekoDirector.ts`, 루프의 `tool_start`. §10 은 모두 추천대로 정했다.
> P3(2026-11-17): 아래 'P3' 칸을 모두 새 활동으로 바꿨다 — 일정 조회 = 달력 보기, 일정 삭제 = 지우기, 파일 = 상자 뒤지기, 끝말잇기 = 골똘히,
> 기다림 층 = `wait`, 생각 층 = `think`(0.5초 이어질 때), 밥 = `meal`(끝까지) → 다 먹으면 세수(`groom`, 3.5초), 배고픔 = `hungry`, 신남 = 상자·털실·나비 중 하나.
> 게임 호환에서 '일하는 중(고양이 차례)'은 골똘히.
> 범위(P2 당시): 엔진은 그대로 두고 **지금 있는 활동 14개만** 쓴다. 새 활동(골똘히·기다림·밥 먹기·빈 그릇·상자 뒤지기·달력 보기)은 P3 이고, P2 에선 §4 의 '대신 쓰는 활동'으로 둔다.

---

## 0. 한눈에

- 지금(P1)은 App.tsx 가 감정 하나(`displayEmotion`)를 골라 주면, `emotionMap` 이 그걸 기분·자세·활동으로 바꾼다.
- P2 는 세 조각으로 나눈다. 셋 다 React 를 모르는 코드라 가짜 시계로 테스트할 수 있다.
  1. **세션 상태(reducer)**: 루프 이벤트를 세션마다 '네코 상태'(생각 중·도구 중·답 쓰는 중·기다림·결과)로 줄인다. 이때 일회성 **반응**(꼬리 탁탁 등)도 같이 낸다.
  2. **계획(derive)**: 활성 세션의 상태와 앱 상황(밥 먹는 중·놀이·게임·배고픔·무활동·상자)을 합쳐, 지금 보여 줄 **계획 하나**(기분·자세·활동·산책)를 만든다.
  3. **스케줄러**: 계획을 엔진에 천천히 적용한다. 최소 머무름, 마지막 것이 이기기, 한 번짜리 활동 끝까지, 결과 여운, 손(잡기) 뒤 다시 적용, 깨어날 때 기지개 같은 규칙을 맡는다.
- 에이전트 루프에 **`tool_start` 이벤트 하나**를 더한다. 지금은 도구 이름이 실행이 끝난 뒤(`step_done`)에야 와서, 도구를 쓰는 **동안** 그 도구의 활동을 보여 줄 수 없다.
- 덤으로 고치는 것: 지금은 생각·답 토큰마다 `setCatEmotion` 이 새 객체를 만들어 **App 전체가 토큰마다 다시 그려진다**. P2 에선 단계(phase)가 바뀔 때만 상태를 바꾼다.

---

## 1. 지금 모자란 것

| 문제 | 어디 | 결과 |
|---|---|---|
| 도구 이름이 `step_done`(실행 뒤)에야 온다 | `agent-loop.ts` | 도구 활동을 실행 중에 못 보여 준다. 끝난 뒤에 보여 주면 이미 다음 생각 중이다 |
| 감정 9개로 줄이면서 정보를 잃는다 | `useAgentLoop.ts` | 생각 중·답 쓰는 중이 다 `working`. 확인 대기·질문 대기는 고양이에 안 보인다 |
| 토큰마다 `setCatEmotions({...prev})` | `useAgentLoop.ts` | 값이 같아도 새 객체라 App 이 토큰마다 다시 렌더 |
| 결과 반응이 '감정이 바뀔 때'만 난다 | `useNekoBridge.ts` | `happy` → 다음 실행도 `happy` 면 반응이 안 난다 |
| 우선순위가 삼항식 한 줄 | `App.tsx` `displayEmotion` | 밥 먹기·확인 대기·게임·상자가 섞이면 무엇이 이기는지 알기 어렵고 테스트가 없다 |
| 상자·졸림 타이머가 App 에 흩어져 있다 | `App.tsx` | 고양이 행동 규칙이 화면 코드에 섞여 있다 |
| 게임이 `onEmotionChange(감정, 999999)` 로 덮는다 | 게임 훅 2개 | 게임이 끝나도 덮개가 남거나, 에이전트 결과를 가린다 |
| 무활동 = '마지막으로 보낸 때' | `markUserActivity` | 앱을 쓰고 있어도(스크롤·입력) 5분 뒤 잠든다 |

---

## 2. 구조

```
agent-loop ── LoopEvent (+ tool_start) ──▶ useAgentPool.handleEvent
                                              │ toSignal() — 단계가 같으면 보내지 않음
                                              ▼
                           nekoSessions (zustand, React 밖)
                           reduceSession(state, signal, now) → { state, reactions }
                                              │ 활성 세션 것만
앱 상황 ── nekoApp (zustand) ─────────────────┤  feeding · playCue · game · needs · lastActiveAt · box · 순간 신호
                                              ▼
                           deriveNeko(input, now) → { plan, recheckAt }
                                              ▼
                           scheduler.apply(plan, now) · scheduler.react(reactions)
                                              ▼
                           NekoController (엔진)
                              │ activity(null) · grab · drop · pet · nyang · annoyed
                              └──▶ scheduler(한 번짜리 끝·손) · rpg.pet() · 상자 나오기 셈
```

### 2.1 파일

```
src/neko/director/
  types.ts            # NekoSignal · NekoSessionState · DirectorInput · NekoPlan · Reaction
  session.ts          # reduceSession() · judgeResult() — 순수 함수
  session.test.ts
  toolActivity.ts     # 도구 → 활동 표(§4) — 순수 함수
  toolActivity.test.ts
  derive.ts           # deriveNeko() — 층과 우선순위(§5) — 순수 함수
  derive.test.ts
  scheduler.ts        # createScheduler(ctrl, clock) — 시간 규칙(§6)
  scheduler.test.ts   # 가짜 컨트롤러 + 가짜 타이머
  stores.ts           # nekoSessions · nekoApp (zustand)
src/neko/useNekoDirector.ts   # React 연결: 스토어 구독 → derive → scheduler. useNekoBridge 를 대신한다
```

`emotionMap.ts` 는 남긴다. LLM 의 `[[PET_STATE:x]]` 와 게임 호환(§5.4 '게임')에서 감정 → 반응·자세를 읽을 때 쓴다.

---

## 3. 세션 상태 (reduceSession)

### 3.1 신호

루프 이벤트를 그대로 넘기지 않고 고양이에 필요한 것만 담은 **신호**로 바꾼다. 신호는 `useAgentPool` 이 만든다.

| 신호 | 언제 | 담는 것 |
|---|---|---|
| `run_start` | `sendMessage` 시작 | — |
| `thinking` | `step_start`, `thinking_token` | — (단계가 이미 thinking 이면 보내지 않음) |
| `tool_start` | **새 루프 이벤트** `tool_start` | 도구 이름, 활동 판정에 필요한 것만(`code.exec` 의 언어·음악 앱 여부, `game.start` 의 게임 종류) |
| `tool_end` | `step_done` (도구가 `user.ask` 가 아닐 때) | 도구 이름, 쓰기 도구인지 |
| `step_error` | `step_error` | 도구 이름, 사용자가 취소했는지(`errorMessage` 가 취소 문구) |
| `answering` | `streaming_token` | — (이미 answering 이면 보내지 않음) |
| `wait` | `confirm_needed`, `clarify_needed` | 종류(confirm·clarify), 위험한지 |
| `wait_end` | 사용자가 확인·답함(`confirmResolve`·`clarifyResolve`) | 승인했는지 |
| `done` | `done` | `[[PET_STATE:x]]` 값(있으면) |
| `loop_error` | `error` | — |
| `abort` | `stop()` | — |

토큰 이벤트는 초당 수십 번 오지만 신호는 **단계가 바뀔 때 한 번**만 간다(풀이 세션마다 마지막 단계를 기억해서 거른다). 그래서 토큰마다 App 이 다시 그려지는 문제도 같이 사라진다.

### 3.2 상태

```ts
type NekoPhase = "idle" | "thinking" | "tool" | "answering" | "waiting" | "result";

interface NekoSessionState {
  phase: NekoPhase;
  since: number;                 // 이 단계가 시작된 시각(ms)
  tool: ToolCue | null;          // 지금 쓰는 도구
  lastTool: { cue: ToolCue; endedAt: number } | null; // 도구 사이 '생각' 동안 이어 갈지 볼 때
  wait: { kind: "confirm" | "clarify"; danger: boolean } | null;
  run: { startedAt: number; tools: number; wrote: boolean; errors: number; lastFailed: boolean } | null;
  result: { kind: ResultKind; petState: CatEmotion | null; at: number } | null;
}
interface ToolCue { name: string; activity: NekoActivity; oneShot: boolean }
type ResultKind = "wrote" | "used" | "plain" | "failed" | "cancelled" | "error" | "aborted";
```

### 3.3 전이와 반응

| 신호 | 상태 변화 | 반응(활성 세션이면 바로 낸다) |
|---|---|---|
| `run_start` | phase thinking, `run` 새로, `result` 지움 | — |
| `thinking` | phase thinking(`tool` → `lastTool` 로 옮김) | — |
| `tool_start` | phase tool, `tool` = 표 §4 로 정한 것 | — |
| `tool_end` | `run.tools++`, 쓰기 도구면 `run.wrote`. phase 는 그대로(곧 thinking 이 온다) | — |
| `step_error` | `run.errors++`, `lastFailed` | **탁탁(sulk)**. 3초 안에 또 오면 한 번만. 하던 활동은 이어 간다 |
| `answering` | phase answering | — |
| `wait` | phase waiting, `wait` 채움, 앞 도구(`tool`·`lastTool`)는 잊음(승인 뒤 엉뚱하게 이어 가지 않게) | 위험한 확인이면 **꼬리펑(startle)** |
| `wait_end` | phase thinking(승인) / 그대로(취소면 곧 `step_error`·`done` 이 온다) | — |
| `done` | phase result, `result = judgeResult(run, petState)` | 결과 반응은 스케줄러가 **0.6초 여운 뒤**에 낸다(§6-5) |
| `loop_error` | phase result, kind error | (여운 뒤) 꼬리펑 → 1.2초 뒤 내리기 |
| `abort` | phase idle, 다 지움 | 없음(소품만 쏙) |

### 3.4 결과 판정 (`deriveFinalEmotion` 을 대신함)

위에서부터 처음 맞는 것:

| 조건 | kind | 반응 | 결과 자세·기분(2.5초) |
|---|---|---|---|
| `abort` | aborted | — | 바로 기본 |
| `loop_error` | error | 꼬리펑 → 내리기 | 서기, 3초 |
| 사용자가 실행을 취소 | cancelled | 내리기 | 앉기, 2초 |
| 마지막 도구가 실패하고 끝남 | failed | 탁탁(sulk) | 서기, 3초 |
| 쓰기 도구 성공(`todo.add`·`todo.complete`·`schedule.add`·`schedule.delete`·`code.exec`·`file.upload`) | wrote | 떨기(cheer) | 행복, 서기 |
| 도구를 썼음 | used | 세우기(proud) | 행복, 앉기 |
| 도구 없이 답만 | plain | — | 기본 |

- 지금 판정은 '중간에 오류가 한 번이라도 있으면 error' 다. 하지만 에이전트는 오류 뒤에 다시 시도해서 성공하는 일이 많다. 그래서 **마지막 도구가 실패했을 때만** 실패로 본다. 중간 오류는 그때그때 탁탁으로 이미 보여 준다.
- `[[PET_STATE:x]]` 는 failed·cancelled·error·aborted 가 **아닐 때만** 반응을 바꾼다(모델이 실패를 '행복'으로 덮지 못하게). 표 5.1 대로: happy → 떨기, proud → 세우기, curious → 꼬리 물음표, sleepy → 졸린 기분 + 식빵, error → 탁탁, idle → 반응 없음.

---

## 4. 도구 → 활동 (toolActivity)

상위 문서 표 5.3 을 지금 있는 활동으로 맞춘 것이다. '한 번'은 엔진이 스스로 끝내는 활동이다(발도장·간식·기지개·벽 타기). 나머지는 바꿀 때까지 이어진다.

| 도구 | P2 활동 | 한 번 | P3 에서 바꿀 것 |
|---|---|---|---|
| `todo.list`, `todo.list_done` | 신문 읽기 `reading` | | |
| `todo.add` | 타이핑 `typing` | | |
| `todo.complete` | 발도장 `stamp` | ✓ | |
| `schedule.list` | 신문 읽기 | | 달력 보기 `calendar` |
| `schedule.add` | 발도장 | ✓ | |
| `schedule.delete` | 발도장 | ✓ | 지우기 변형 |
| `code.exec` | 타이핑 | | |
| `code.exec` (AppleScript·osascript 이고 코드에 Music·Spotify·iTunes) | 음악 듣기 `music` | | |
| `web.search` | 창밖 구경 `window` | | |
| `web.scrape` | 신문 읽기 | | |
| `weather.get` | 창밖 구경 | | (선택) 날씨 배경 |
| `game.start` drawing | 그림 그리기 `draw` | | 게임 상태가 이어받음 |
| `game.start` wordchain | 타이핑 | | 골똘히 `think` |
| `file`, `file.upload` | 상자 `box` | | 상자 뒤지기 `dig` |
| `clipboard` | 꾹꾹이 `knead` | | |
| `math.eval` | 그림 그리기 | | |
| MCP 도구·모르는 도구 | 타이핑 | | 서버별 설정(선택) |

`user.ask` 는 도구 활동을 쓰지 않는다. `clarify_needed` → 기다림으로 처리한다.

테스트: `tool-registry.ts` 의 도구 이름을 전부 돌면서 표에 빠진 도구가 없는지 확인한다(새 도구를 넣고 표를 잊으면 테스트가 실패).

---

## 5. 계획 만들기 (deriveNeko)

### 5.1 입력과 출력

```ts
interface DirectorInput {
  session: NekoSessionState;                  // 활성 세션
  feeding: { since: number } | null;          // 밥 주기(compact) 중
  playCue: { at: number; kind: "yarn" | "butterfly" } | null; // 놀아주기 버튼
  game: { emotion: CatEmotion; until: number } | null;        // 게임 호환(지금 onEmotionChange 를 그대로 받음)
  needs: { hunger: number; play: number };    // hunger = 화면에 보이는 배고픔(컨텍스트 사용량)
  lastActiveAt: number;                       // 사용자가 마지막으로 앱을 쓴 시각
  box: { since: number } | null;              // 신나서 상자에 들어간 중(§5.3 '신남')
}

interface NekoPlan {
  layer: Layer;                    // 어느 층이 정했나(디버그·테스트)
  mood: NekoMood;
  pose: NekoPose;
  activity: NekoActivity | null;
  oneShot: boolean;                // 엔진이 스스로 끝내는 활동인가
  repeat: boolean;                 // 한 번짜리를 이 층이 이어지는 동안 반복(밥 먹는 중 간식)
  dwell: boolean;                  // 최소 머무름을 지킬 활동인가(도구 활동)
  tailHold: NekoTailSign | null;   // 계속 유지할 꼬리(기다림 = 물음표)
  wander: boolean;                 // 산책 허용
}

deriveNeko(input, now) → { plan: NekoPlan; recheckAt: number | null }
```

`recheckAt` 은 '시간만 지나도 계획이 바뀌는 때'(결과 여운이 끝나는 때, 5분 무활동이 되는 때 등)다. 스케줄러가 그때 다시 부른다.

### 5.2 층과 우선순위

위에서부터 처음 맞는 층이 계획을 정한다(손 = 엔진이 직접 하므로 표에 없음).

| # | 층 | 조건 | 계획 |
|---|---|---|---|
| 1 | 기다림 | `session.phase === "waiting"` | 앉기, 궁금, 활동 없음, 꼬리 물음표 유지, 산책 끔 (P3: `wait`) |
| 2 | 밥 먹기 | `feeding` | 간식 `snack`, 반복 (P3: `meal`) |
| 3 | 도구 | phase tool | 표 §4 의 활동, 최소 머무름 |
| 3 | 생각 | phase thinking | 방금 끝난 도구가 2초 안이면 **그 활동을 이어 감**(도구 사이에 앉았다 섰다 하지 않게). 아니면 앉기 + 궁금 + 꼬리 살랑살랑 (P3: `think`) |
| 3 | 답 쓰기 | phase answering | 타이핑 |
| 3 | 결과 | phase result 이고 결과 시간 안(2~3초, §3.4) | §3.4 의 자세·기분, 활동 없음 |
| 4 | 놀이 | `playCue` 가 6초 안 | 털실·나비 |
| 5 | 게임 | `game` 이 아직 유효 | `emotionPlan(game.emotion)`(표 5.1) |
| 6 | 졸림 | 무활동 5분 이상 | 졸린 기분 + 식빵. 6분 넘으면 누워 자기(배고프거나 심심해도 결국은 잔다) |
| 7 | 힘없음 | `needs.hunger < 10` | 식빵, 기본, 산책 끔(눈은 뜸 — 졸림과 구분) |
| 7 | 배고픔 | `needs.hunger < 30` | 앉기, 산책 끔 (P3: 빈 그릇 `hungry`) |
| 7 | 심심 | `needs.play < 20` | 식빵, 산책 끔 |
| 8 | 신남 | `box` | 상자 `box` |
| 9 | 기본 | 그 밖 | 서기, 기본, 산책 켬 |

- 밥 먹기가 끝나면(요약 끝) 결과처럼 떨기 + 행복 2초. 요약할 대화가 없어 바로 끝나는 밥 주기는 간식 한 번 → 떨기.
- 지금 App 은 '배고픔 < 30 또는 놀이 < 20' 을 졸림으로 본다. P2 는 상위 문서 표 5.4 대로 **배고픔 낮음은 힘없음·배고픔, 놀이 낮음은 심심**으로 나눈다. 잠은 무활동일 때만 잔다.
- 신남(상자)은 지금 App 의 규칙을 옮긴다. 놀이 ≥ 80 이고 쉬는 중이면 30~120초 뒤 상자에 들어간다. 60초가 지나거나 3번 쓰다듬으면 나온다. 타이머는 `useNekoDirector` 가 갖고, `box` 입력만 derive 에 넘긴다.

---

## 6. 스케줄러

엔진에 무엇을 언제 시킬지 정한다. `ctrl` 과 `clock` 을 받아 만들어서, 테스트에선 가짜 둘을 넣는다.

| # | 규칙 | 값 |
|---|---|---|
| 1 | **최소 머무름**: `dwell` 활동은 시작하고 이만큼은 바꾸지 않는다. 그 사이 온 계획은 '다음'으로 하나만 기억한다(마지막 것이 이긴다) | 1.5초 |
| 2 | **같은 활동이면 이어 간다**: 다시 `act()` 하지 않는다(소품을 다시 뽑지 않음) | — |
| 3 | **바꿀 땐 엔진에 맡긴다**: `act(다음)` 하나면 엔진이 소품을 쏙 넣고 새 소품을 '뿅' 꺼낸다 | — |
| 4-b | **밀린 발도장은 꼭 찍는다**: 짧은 발도장 도구가 다른 활동의 머무름에 밀리면, 머무름이 끝날 때 계획이 이미 넘어갔어도 한 번은 찍는다(결과 반응은 그 뒤). 기다림·세션 전환이면 버린다 | — |
| 4 | **한 번짜리는 끝까지**: 발도장(약 4초)·간식(약 9초)·기지개(3초)는 엔진이 `activity: null` 을 낼 때까지 둔다. 기다림·손이 오면 끊는다. `repeat` 면 0.4초 쉬고 다시 시작 | 최대 12초 |
| 5 | **결과 여운**: `done` 뒤 이만큼 기다렸다가 결과 반응을 내고, 결과 자세로 바꾼다. 한 번짜리 활동이 돌고 있으면 그게 끝난 뒤에 | 0.6초 |
| 6 | **반응**: 같은 반응은 이 시간 안에 한 번만. 반응끼리는 이만큼 띄운다 | 0.8초 / 0.4초 |
| 7 | **손**: `grab` 이 오면 적용을 멈추고 '다음'만 기억한다. `drop` 뒤 털기가 끝날 때쯤 지금 계획을 다시 적용한다(잡혀서 끝난 활동이 다시 '뿅') | 0.9초 |
| 8 | **세션 전환**: 머무름·다음·쌓인 반응을 버리고 바로 새 세션의 계획을 적용한다 | — |
| 9 | **깨어남**: 졸림 층에서 다른 층으로 바뀔 때 먼저 기지개(`stretch`, 한 번)를 하고 인사(`greet`)한 뒤 계획으로 | — |
| 10 | **다시 보기**: `recheckAt`·머무름 끝·한 번짜리 최대 시간 중 가장 이른 때에 타이머 하나만 건다 | — |
| 11 | **꼬리 유지**: `tailHold` 가 있으면 2.5초마다 `tail(sign, 3)` 을 다시 건다(엔진 꼬리 언어는 잠깐짜리라서) | 2.5초 |

### 6.1 적용 순서

```
apply(plan, now):
  if 손에 잡힘: next = plan; return
  if 층이 sleep → 다른 층: 깨어남 순서(규칙 9) 끼워 넣기
  setMood(plan.mood) · setWander(plan.wander)        // 가벼워서 바로
  if 지금 활동이 머무름 중 && plan.activity !== 지금 활동: next = plan; 타이머(머무름 끝); return
  if 지금 활동이 한 번짜리이고 아직 안 끝남 && plan 이 기다림이 아니면: next = plan; return
  if plan.activity !== 지금 활동: act(plan.activity) (머무름 시작 시각 기록)
  if plan.activity 없음: setPose(plan.pose)
  꼬리 유지 갱신, 다시 보기 타이머 갱신
```

---

## 7. 앱에서 바뀌는 곳

| 파일 | 바꿈 |
|---|---|
| `agent/types.ts` | `LoopEvent` 에 `{ type: "tool_start"; tool: string; params: Record<string, unknown> }` 추가 |
| `agent/agent-loop.ts` | 도구를 실행하기 바로 앞(`try {` 앞, 확인을 받은 뒤)에서 `yield { type: "tool_start", … }`. `user.ask` 는 내지 않는다 |
| `hooks/useAgentLoop.ts` | `setCatEmotion` 을 모두 `nekoSessions.dispatch(sessionId, 신호)` 로 바꾼다. 단계가 같으면 보내지 않는다. `deriveFinalEmotion` 은 `judgeResult` 로 옮긴다. `catEmotion` 반환값은 지운다(쓰는 곳이 App 하나뿐). `confirmResolve`·`clarifyResolve` 에서 `wait_end` |
| `App.tsx` | `displayEmotion`·`actionEmotion`·`triggerActionEmotion`·`isBoxMode`·상자 타이머·`isGaugeSleepy` 를 지운다. 밥 주기는 `nekoApp.setFeeding(true/false)`, 놀아주기는 `nekoApp.playCue()`, 게임 훅에는 `nekoApp.gameEmotion` 을 넘긴다(모양이 같아 게임 훅은 안 바뀜). `useNekoBridge` 대신 `useNekoDirector` |
| `neko/useNekoBridge.ts` | 지운다(테마·탭 → 놀이 게이지 연결은 `useNekoDirector` 로) |
| `lib/events.ts` | `nekoCue` 를 지운다(밥·놀이는 `nekoApp` 상태로). 순간 신호 `nekoHint: { kind: "newChat" \| "attach" }` 추가 → 물음표 / 궁금 반응 |
| `hooks/useCatRpg.ts` | 그대로. `setNeeds` 로 엔진에도 값만 넘겨 둔다(P3 에서 씀) |

---

## 8. 테스트

| 파일 | 확인하는 것 |
|---|---|
| `session.test.ts` | 루프 이벤트 순서 → 상태·반응. 확인 대기(위험·보통), 취소, 중간 오류 후 성공, 마지막 실패, PET_STATE 가 실패를 덮지 못함, 토큰이 수백 번 와도 상태 변화는 한 번 |
| `toolActivity.test.ts` | 등록된 도구가 모두 표에 있다. 음악 앱 AppleScript → 음악 듣기. MCP·모르는 도구 → 타이핑 |
| `derive.test.ts` | §5.2 표의 모든 줄. 우선순위가 겹칠 때(밥 먹는 중 확인 대기 → 기다림 등). 도구 사이 생각 2초 이어 가기. `recheckAt` |
| `scheduler.test.ts` | 가짜 컨트롤러(부른 함수와 시각을 기록) + `vi.useFakeTimers()` 로 아래 시간표 |

### 8.1 시간표 예 (scheduler 테스트로 그대로 쓴다)

| # | 입력(시각) | 엔진에 보여야 할 것 |
|---|---|---|
| 1 | 0.0 `tool_start(web.search)` · 0.3 `thinking` · 0.4 `tool_start(web.scrape)` | 0.0 창밖 → **1.5 신문**(머무름 뒤 한 번만 바뀜, 앉았다 서지 않음) |
| 2 | 0.0 `thinking` · 0.8 `wait(confirm, 위험)` · 3.0 `wait_end(승인)` · 3.0 `tool_start(code.exec)` · 4.0 `tool_end` · 4.5 `done` | 0.0 앉기·궁금 → 0.8 꼬리펑 + 앉아서 물음표 → 3.0 타이핑 → **5.1 떨기**(여운 0.6) + 행복 → 7.6 기본 |
| 3 | 타이핑 중 2.0 `step_error` · 2.5 `step_error` | 2.0 탁탁 한 번(2.5 는 묶임), 타이핑은 계속 |
| 4 | 0.0 `tool_start(todo.complete)` · 0.2 `tool_end` · 0.3 `done` | 발도장을 끝까지(약 4초) → 그 뒤 0.6초 → 떨기 |
| 5 | 0.0 `answering` · 3.0 `done`(도구 없음) | 타이핑 → 3.6 기본(반응 없음) |
| 6 | 세션 A 타이핑 중 활성 세션을 B(쉬는 중)로 | 바로 활동 끝 → B 의 계획. A 의 반응은 버림 |
| 7 | 밥 주기 0~20초 (요약이 20초 걸림) | 간식(약 9초) → 0.4초 쉬고 다시 간식 → 20초에 요약이 끝나면 먹던 간식을 마저 먹고 → 떨기 + 행복 |
| 8 | 무활동 5분 → 6분 → 사용자 입력 | 졸림·식빵 → 누워 자기 → 기지개 → 인사 → 기본 |
| 9 | 타이핑 중 잡기 → 1초 뒤 놓기 | 잡히면 엔진이 타이핑을 끝냄 → 놓고 0.9초 뒤 타이핑 다시 '뿅'(아직 도구 중이면) |
| 10 | `tool_end(code.exec)` 뒤 1.2초 `thinking` · 2.5초 `tool_start(code.exec)` | 타이핑이 그대로 이어짐(생각 2초 이어 가기) |

### 8.2 앱에서 눈으로 확인

- 개발 빌드에서만 `window.__nekoDirector` 를 연다: `signal(sessionId, 신호)`, `log()`(적용한 것의 시간 기록).
- 가짜 Tauri 로 앱을 띄우고(P1 확인 스크립트) 신호를 넣어 시간표 1·2·7·8 을 찍는다. LLM 없이 돌릴 수 있다.

---

## 9. 작업 순서

| 단계 | 할 일 | 끝 기준 |
|---|---|---|
| P2-1 | `types` · `session` · `toolActivity` + 테스트 (앱은 아직 안 바꿈) | 테스트 통과 |
| P2-2 | `derive` · `scheduler` + 테스트 | 시간표 10개 통과 |
| P2-3 | `tool_start` 추가, 풀이 신호를 보냄, `useNekoDirector` 연결, App 정리(`displayEmotion` 등 지움), `useNekoBridge` 지움 | 타입 검사·전체 테스트·`qa:neko` 통과, 기존 기능(밥·놀이·쓰다듬기·상자·졸림·게임) 그대로 |
| P2-4 | 앱 확인(§8.2) + 문서 갱신(상위 문서 §6·§12·§13) | 스크린샷 |

P3 에서 새 활동을 만들면 §4·§5.2 의 'P3' 칸만 바꾸면 된다(감독 구조는 그대로).

---

## 10. 정할 것 — 모두 추천대로 정함(2026-11-17)

1. **`tool_start` 이벤트 추가**
   - 추천: 추가. 없으면 도구 활동이 도구가 끝난 뒤에야 나와서, 사실상 다음 생각 단계에 엉뚱한 활동을 보여 준다.
2. **'사용자가 앱을 쓰는 중'의 범위** (졸림·깨어남 기준)
   - 지금: 메시지를 보낼 때만.
   - 추천: 창 안의 키 입력·클릭·스크롤도 포함(3초에 한 번만 셈). 읽기만 해도 고양이가 잠들지 않고, 돌아오면 자연스럽게 깬다.
3. **뒤에서 돌던 다른 세션이 끝났을 때**
   - 추천: 활성 세션이 쉬는 중이면 인사(`greet`: 귀 쫑긋 + 꼬리 세우기) 한 번으로 알려 준다. 일하는 중이면 무시.
4. **놀아주기 버튼**
   - 지금: 털실·나비 신호와 무작위 게임을 같이 띄워서 게임 감정이 바로 덮는다.
   - 추천: 털실·나비를 6초 놀고 나서 게임이 이어받는다(§5.2 에서 놀이 층이 게임보다 위).
5. **게임 표현**
   - 추천: P2 에선 지금처럼 감정으로 받고(호환), 게임별 의미 상태(그리는 중·추리 중·맞힘·틀림)는 P3 에서 '골똘히·기다림' 활동과 같이 바꾼다.
