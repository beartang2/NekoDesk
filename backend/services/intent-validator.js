const ALLOWED_TYPES = new Set([
  "chat",
  "help",
  "system.exit",
  "system.refresh",
  "view.switch",
  "memo.add",
  "memo.delete",
  "memo.deleteAll",
  "memo.list",
  "todo.add",
  "todo.delete",
  "todo.deleteAll",
  "todo.deleteCompleted",
  "todo.list",
  "todo.complete",
  "schedule.add",
  "schedule.delete",
  "schedule.deleteAll",
  "schedule.listUpcoming",
  "schedule.listDay",
  "github.overview",
  "github.query"
]);

export function validateIntent(intent, rawInput = "") {
  if (!intent || typeof intent.type !== "string" || !ALLOWED_TYPES.has(intent.type)) {
    return invalidIntent();
  }

  const normalized = {
    type: intent.type,
    confidence: Number.isFinite(Number(intent.confidence)) ? Number(intent.confidence) : 0.4,
    params: isPlainObject(intent.params) ? intent.params : {}
  };

  switch (normalized.type) {
    case "chat":
    case "help":
    case "system.exit":
    case "system.refresh":
      return { ok: true, intent: normalized };
    case "view.switch":
      return ["chat", "memo", "todo", "schedule", "github"].includes(normalized.params.view)
        ? { ok: true, intent: normalized }
        : invalidIntent();
    case "memo.list":
    case "todo.list":
    case "schedule.listUpcoming":
    case "github.overview":
    case "memo.deleteAll":
    case "todo.deleteAll":
    case "todo.deleteCompleted":
    case "schedule.deleteAll":
      return { ok: true, intent: normalized };
    case "memo.add":
    case "todo.add":
      return hasText(normalized.params.content)
        ? { ok: true, intent: normalized }
        : invalidIntent();
    case "memo.delete":
    case "todo.delete":
    case "todo.complete":
    case "schedule.delete":
      return hasText(normalized.params.target)
        ? { ok: true, intent: normalized }
        : invalidIntent();
    case "github.query":
      return hasText(normalized.params.question)
        ? {
            ok: true,
            intent: {
              ...normalized,
              params: { question: normalized.params.question.trim() }
            }
          }
        : invalidIntent();
    case "schedule.listDay":
      return ["today", "tomorrow"].includes(normalized.params.day)
        ? { ok: true, intent: normalized }
        : invalidIntent();
    case "schedule.add":
      return isValidScheduleAdd(normalized.params)
        ? { ok: true, intent: normalized }
        : invalidIntent();
    default:
      return invalidIntent();
  }
}

export function requiresConfirmation(intent) {
  return (
    intent?.type === "memo.deleteAll" ||
    intent?.type === "todo.deleteAll" ||
    intent?.type === "todo.deleteCompleted" ||
    intent?.type === "schedule.deleteAll"
  );
}

export function buildConfirmationMessage(intent) {
  if (intent?.type === "memo.deleteAll") {
    return "메모를 전부 지울까?";
  }

  if (intent?.type === "todo.deleteAll") {
    return "할 일을 전부 지울까?";
  }

  if (intent?.type === "todo.deleteCompleted") {
    return "완료된 할 일을 전부 지울까?";
  }

  if (intent?.type === "schedule.deleteAll") {
    return "일정을 전부 지울까?";
  }

  return "이 작업을 진행할까?";
}

function invalidIntent() {
  return { ok: false };
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isValidScheduleAdd(params) {
  if (!hasText(params.title) || !isValidIsoLike(params.startAt)) {
    return false;
  }

  if (params.endAt !== undefined && params.endAt !== null && params.endAt !== "" && !isValidIsoLike(params.endAt)) {
    return false;
  }

  return true;
}

function isValidIsoLike(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
