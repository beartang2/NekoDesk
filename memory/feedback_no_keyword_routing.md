---
name: 키워드 기반 라우팅 금지
description: 사용자는 키워드 매칭으로 에이전트 루프 여부를 결정하는 방식을 명시적으로 금지함
type: feedback
---

키워드 기반 라우팅(needsAgentLoop 등)을 절대 사용하지 말 것.

**Why:** 하드코딩된 키워드로 "에이전트 루프 실행 여부"를 결정하면 LLM의 판단을 무시하게 됨. 모든 입력은 에이전틱 루프로 처리하고 LLM이 tool: "none"으로 직접 판단해야 함.

**How to apply:** needsAgentLoop 같은 함수를 만들거나 키워드 목록으로 분기를 추가하는 코드를 작성하지 말 것. 항상 runAgentLoop를 호출할 것.
