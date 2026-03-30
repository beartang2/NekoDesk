const HELP_PATTERN = /(help|도움말|명령어)/i;
const EXIT_PATTERN = /^(exit|quit|종료)$/i;
const REFRESH_PATTERN = /(refresh|새로고침|갱신)/i;
const GITHUB_PATTERN = /(github|깃허브|git hub|pr|pull request|issue|알림|notification)/i;
const MEMO_PATTERN = /(memo|메모)/i;
const TODO_PATTERN = /(todo|할 일|할일|task)/i;
const SCHEDULE_PATTERN = /(일정|스케줄|calendar|schedule|약속|회의)/i;

export async function routeIntent(input, llmClient) {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      type: "help",
      confidence: 1,
      params: {},
      replyHint: "무엇을 도와줄지 알려줘."
    };
  }

  if (EXIT_PATTERN.test(trimmed)) {
    return { type: "system.exit", confidence: 1, params: {} };
  }

  if (HELP_PATTERN.test(trimmed)) {
    return { type: "help", confidence: 1, params: {} };
  }

  if (REFRESH_PATTERN.test(trimmed)) {
    return { type: "system.refresh", confidence: 0.95, params: {} };
  }

  const todoIntent = parseTodoIntent(trimmed);
  if (todoIntent) {
    return todoIntent;
  }

  const memoIntent = parseMemoIntent(trimmed);
  if (memoIntent) {
    return memoIntent;
  }

  const scheduleIntent = parseScheduleIntent(trimmed);
  if (scheduleIntent) {
    return scheduleIntent;
  }

  if (GITHUB_PATTERN.test(trimmed)) {
    return { type: "github.overview", confidence: 0.9, params: {} };
  }

  const llmIntent = await llmClient.parseIntent(trimmed);
  if (llmIntent) {
    return llmIntent;
  }

  return {
    type: "chat",
    confidence: 0.5,
    params: { message: trimmed }
  };
}

function parseMemoIntent(input) {
  if (!MEMO_PATTERN.test(input)) {
    return null;
  }

  if (/(보여|목록|list|최근)/i.test(input)) {
    return { type: "memo.list", confidence: 0.96, params: {} };
  }

  const content = extractAfterKeywords(input, ["메모", "memo"]);
  if (content) {
    return {
      type: "memo.add",
      confidence: 0.94,
      params: { content }
    };
  }

  return { type: "memo.list", confidence: 0.55, params: {} };
}

function parseTodoIntent(input) {
  if (!TODO_PATTERN.test(input)) {
    return null;
  }

  if (/(완료|끝|done|finish|체크)/i.test(input)) {
    const target = extractCompletionTarget(input);
    return {
      type: "todo.complete",
      confidence: target ? 0.95 : 0.6,
      params: { target }
    };
  }

  if (/(보여|목록|list|뭐 있어|남은)/i.test(input)) {
    return { type: "todo.list", confidence: 0.96, params: {} };
  }

  const content = extractAfterKeywords(input, ["할 일", "할일", "todo", "task"]);
  if (content) {
    return {
      type: "todo.add",
      confidence: 0.94,
      params: { content }
    };
  }

  return { type: "todo.list", confidence: 0.55, params: {} };
}

function parseScheduleIntent(input) {
  const dateInfo = parseDateTimeFromInput(input);
  if (/(오늘 일정|today schedule)/i.test(input)) {
    return { type: "schedule.listDay", confidence: 0.98, params: { day: "today" } };
  }

  if (/(내일 일정|tomorrow schedule)/i.test(input)) {
    return { type: "schedule.listDay", confidence: 0.98, params: { day: "tomorrow" } };
  }

  if (!SCHEDULE_PATTERN.test(input) && !dateInfo) {
    return null;
  }

  if (/(보여|목록|list|일정 뭐)/i.test(input) && !dateInfo) {
    return { type: "schedule.listUpcoming", confidence: 0.9, params: {} };
  }

  if (dateInfo) {
    const title = extractEventTitle(input);
    if (title) {
      return {
        type: "schedule.add",
        confidence: 0.93,
        params: {
          title,
          startAt: dateInfo.startAt,
          endAt: dateInfo.endAt,
          allDay: dateInfo.allDay
        }
      };
    }
  }

  return { type: "schedule.listUpcoming", confidence: 0.6, params: {} };
}

function extractAfterKeywords(input, keywords) {
  const sanitized = input
    .replace(/(추가해줘|추가|저장해줘|저장|등록해줘|등록|남겨줘|작성해줘)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const keyword of keywords) {
    const index = sanitized.toLowerCase().indexOf(keyword.toLowerCase());
    if (index === -1) {
      continue;
    }
    const tail = sanitized.slice(index + keyword.length).trim();
    const cleaned = tail.replace(/^(에|를|을|로|좀|하나|하나만)\s*/i, "").trim();
    if (cleaned) {
      return cleaned;
    }
  }

  return null;
}

function extractCompletionTarget(input) {
  const numberMatch = input.match(/(\d+)\s*(번|번째)?/);
  if (numberMatch) {
    return numberMatch[1];
  }

  const cleaned = input
    .replace(/(할 일|할일|todo|task|완료|끝|done|finish|체크|해줘|처리해줘)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function extractEventTitle(input) {
  const cleaned = input
    .replace(/(오늘|내일|모레|오전|오후|\d{1,2}시|\d{1,2}:\d{2}|일정|스케줄|약속|추가해줘|등록해줘|등록|추가)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "새 일정";
}

function parseDateTimeFromInput(input) {
  const now = new Date();
  const lower = input.toLowerCase();

  let dayOffset = 0;
  if (lower.includes("내일")) {
    dayOffset = 1;
  } else if (lower.includes("모레")) {
    dayOffset = 2;
  }

  const hourMatch = input.match(/(오전|오후)?\s*(\d{1,2})(?::(\d{2}))?\s*시?/);
  const hasTime = Boolean(hourMatch);
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);

  if (!hasTime && !/(오늘|내일|모레|\d{4}-\d{2}-\d{2})/.test(input)) {
    return null;
  }

  if (hasTime) {
    let hour = Number(hourMatch[2]);
    const minute = Number(hourMatch[3] || 0);
    if (hourMatch[1] === "오후" && hour < 12) {
      hour += 12;
    }
    if (hourMatch[1] === "오전" && hour === 12) {
      hour = 0;
    }
    date.setHours(hour, minute, 0, 0);
    const end = new Date(date);
    end.setHours(end.getHours() + 1);
    return { startAt: date.toISOString(), endAt: end.toISOString(), allDay: false };
  }

  const end = new Date(date);
  end.setDate(end.getDate() + 1);
  return { startAt: date.toISOString(), endAt: end.toISOString(), allDay: true };
}
