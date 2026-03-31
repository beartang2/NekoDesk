import { loadConfig } from "./config.js";
import { createDatabase } from "./storage/database.js";
import { createRepositories } from "./storage/repositories.js";
import { routeIntent } from "./services/intent-router.js";
import { LLMClient } from "./services/llm-client.js";
import { GitHubClient } from "./services/github-client.js";
import { buildDashboard } from "./services/dashboard-service.js";
import {
  buildConfirmationMessage,
  requiresConfirmation,
  validateIntent
} from "./services/intent-validator.js";

const HELP_TEXT = [
  "사용 예시",
  "- 메모 프로젝트 아이디어 정리",
  "- 할 일 README 정리 추가",
  "- 할 일 1번 완료",
  "- 내일 3시 회의 등록",
  "- 오늘 일정 보여줘",
  "- 내 GitHub 상태 요약해줘",
  "- /help",
  "- /exit"
].join("\n");

export async function createAppController(overrides = {}) {
  const config = overrides.config || loadConfig();
  const db = overrides.db || createDatabase(config.dbPath);
  const repositories = overrides.repositories || createRepositories(db);
  const llmClient = overrides.llmClient || new LLMClient(config.llm);
  const githubClient = overrides.githubClient || new GitHubClient({
    githubToken: config.githubToken,
    githubApiBaseUrl: config.githubApiBaseUrl
  });

  const state = {
    petMood: "idle",
    lastInteractionAt: Date.now(),
    lastReply: "냥. 준비됐어.",
    conversation: [],
    githubNotes: [],
    pendingConfirmation: null
  };

  return {
    async getViewModel(options = {}) {
      const dashboard = await buildDashboard(repositories, githubClient);
      const activeView = options.activeView || "chat";
      return {
        activeView,
        dashboard,
        panels: {
          memo: { title: "memo", lines: dashboard.memos.length ? dashboard.memos : ["(empty)"] },
          todo: { title: "todo", lines: dashboard.todos.length ? dashboard.todos : ["(empty)"] },
          schedule: { title: "schedule", lines: dashboard.events.length ? dashboard.events : ["(empty)"] },
          github: {
            title: "github",
            lines: buildGitHubPanelLines(dashboard.github, state.githubNotes)
          }
        },
        petMood: currentMood(state),
        lastReply: state.lastReply,
        pendingConfirmation: state.pendingConfirmation
          ? {
              message: buildConfirmationMessage(state.pendingConfirmation.intent),
              options: ["confirm", "cancel"]
            }
          : null,
        meta: {
          llmEndpoint: config.llm.baseUrl
        },
        hints: [
          "도움말: /help",
          "종료: /exit",
          "GitHub: GITHUB_TOKEN 필요"
        ]
      };
    },
    async handleInput(input, options = {}) {
      state.petMood = "working";
      const activeView = options.activeView || "chat";
      const currentDateTime = new Date().toISOString();
      const timezone = options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

      if (state.pendingConfirmation) {
        state.lastInteractionAt = Date.now();
        state.lastReply = "먼저 확인을 선택해줘.";
        state.petMood = "idle";
        return {
          reply: "먼저 확인을 선택해줘.",
          petMood: "idle",
          nextView: state.pendingConfirmation?.activeView || activeView,
          intent: { type: "chat", confidence: 1, params: {} }
        };
      }

      const intent = await routeIntent(input, llmClient, {
        activeView,
        currentDateTime,
        timezone
      });
      const validation = validateIntent(intent, input);

      if (!validation.ok) {
        intent.type = "chat";
        intent.params = { message: input.trim() };
        intent.confidence = 0.4;
      } else {
        intent.type = validation.intent.type;
        intent.params = validation.intent.params;
        intent.confidence = validation.intent.confidence;
      }

      if (intent.confidence < 0.65) {
        intent.type = "chat";
        intent.params = { message: input.trim() };
        intent.confidence = 0.5;
      }

      if (requiresConfirmation(intent)) {
        state.pendingConfirmation = {
          intent: {
            type: intent.type,
            confidence: intent.confidence,
            params: intent.params
          },
          rawInput: input,
          activeView
        };
        state.lastInteractionAt = Date.now();
        state.lastReply = buildConfirmationMessage(intent);
        state.petMood = "idle";
        return {
          reply: buildConfirmationMessage(intent),
          petMood: "idle",
          nextView: inferNextView(intent.type) || activeView,
          intent
        };
      }

      const result = await executeIntent(
        intent,
        repositories,
        githubClient,
        llmClient,
        config.llm,
        state,
        input,
        activeView,
        currentDateTime,
        timezone
      );
      const narratedResult = await maybeNarrateIntentResult(
        intent,
        result,
        llmClient,
        config.llm,
        input,
        activeView,
        currentDateTime,
        timezone
      );
      state.lastInteractionAt = Date.now();
      state.lastReply = narratedResult.reply;
      state.petMood = narratedResult.petMood;
      return {
        ...narratedResult,
        nextView: narratedResult.nextView || inferNextView(intent.type),
        intent
      };
    },
    async resolveConfirmation(action) {
      if (!state.pendingConfirmation) {
        return {
          reply: "확인할 작업이 없어.",
          petMood: "idle",
          nextView: null,
          intent: { type: "chat", confidence: 1, params: {} }
        };
      }

      if (action !== "confirm" && action !== "cancel") {
        return {
          reply: "확인 또는 취소를 선택해줘.",
          petMood: "idle",
          nextView: state.pendingConfirmation?.activeView || null,
          intent: { type: "chat", confidence: 1, params: {} }
        };
      }

      if (action === "cancel") {
        state.pendingConfirmation = null;
        state.lastInteractionAt = Date.now();
        state.lastReply = "취소했어.";
        state.petMood = "idle";
        return {
          reply: "취소했어.",
          petMood: "idle",
          nextView: pendingViewForAction("cancel", state.pendingConfirmation?.activeView),
          intent: { type: "chat", confidence: 1, params: {} }
        };
      }

      const confirmedIntent = state.pendingConfirmation.intent;
      const result = await executeIntent(
        confirmedIntent,
        repositories,
        githubClient,
        llmClient,
        config.llm,
        state,
        state.pendingConfirmation.rawInput,
        state.pendingConfirmation.activeView,
        currentDateTime(),
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      );
      const narratedResult = await maybeNarrateIntentResult(
        confirmedIntent,
        result,
        llmClient,
        config.llm,
        state.pendingConfirmation.rawInput,
        state.pendingConfirmation.activeView,
        currentDateTime(),
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      );
      state.pendingConfirmation = null;
      state.lastInteractionAt = Date.now();
      state.lastReply = narratedResult.reply;
      state.petMood = narratedResult.petMood;
      return {
        ...narratedResult,
        nextView: narratedResult.nextView || inferNextView(confirmedIntent.type),
        intent: confirmedIntent
      };
    }
  };
}

async function executeIntent(
  intent,
  repositories,
  githubClient,
  llmClient,
  llmConfig,
  state,
  rawInput,
  activeView,
  currentDateTime,
  timezone
) {
  switch (intent.type) {
    case "system.exit":
      return { reply: "다음에 또 불러줘.", petMood: "happy", shouldExit: true };
    case "system.refresh":
      return { reply: "대시보드를 새로 확인했어.", petMood: "idle" };
    case "help":
      return { reply: HELP_TEXT, petMood: "idle" };
    case "view.switch":
      return {
        reply: `${intent.params.view} 화면으로 바꿨어.`,
        petMood: "idle",
        nextView: intent.params.view
      };
    case "memo.add": {
      const memo = repositories.memos.add({ content: intent.params.content });
      return { reply: `메모 #${memo.id} 저장 완료: ${memo.content}`, petMood: "happy" };
    }
    case "memo.delete": {
      if (!intent.params.target) {
        return { reply: "어떤 메모를 지울지 번호나 내용 일부를 알려줘.", petMood: "error" };
      }
      const deleted = repositories.memos.delete(intent.params.target);
      if (!deleted) {
        return { reply: "지울 메모를 찾지 못했어.", petMood: "error" };
      }
      return { reply: `메모 #${deleted.id} 삭제 완료: ${deleted.content}`, petMood: "happy" };
    }
    case "memo.deleteAll": {
      const result = repositories.memos.deleteAll();
      if (!result.deletedCount) {
        return { reply: "지울 메모가 없어.", petMood: "idle" };
      }
      return { reply: `메모 ${result.deletedCount}개를 전부 지웠어.`, petMood: "happy" };
    }
    case "memo.list": {
      const memos = repositories.memos.listRecent(5);
      const reply = memos.length
        ? memos.map((memo) => `#${memo.id} ${memo.content}`).join("\n")
        : "저장된 메모가 아직 없어.";
      return { reply, petMood: "idle" };
    }
    case "todo.add": {
      const todo = repositories.todos.add({ content: intent.params.content });
      return { reply: `할 일 #${todo.id} 추가: ${todo.content}`, petMood: "happy" };
    }
    case "todo.list": {
      const todos = repositories.todos.list(8);
      const reply = todos.length
        ? todos.map((todo) => `${todo.status === "done" ? "[x]" : "[ ]"} ${todo.id}. ${todo.content}`).join("\n")
        : "할 일이 비어 있어.";
      return { reply, petMood: "idle" };
    }
    case "todo.delete": {
      if (!intent.params.target) {
        return { reply: "어떤 할 일을 지울지 번호나 내용 일부를 알려줘.", petMood: "error" };
      }
      const deleted = repositories.todos.delete(intent.params.target);
      if (!deleted) {
        return { reply: "지울 할 일을 찾지 못했어.", petMood: "error" };
      }
      return { reply: `할 일 #${deleted.id} 삭제 완료: ${deleted.content}`, petMood: "happy" };
    }
    case "todo.deleteAll": {
      const result = repositories.todos.deleteAll();
      if (!result.deletedCount) {
        return { reply: "지울 할 일이 없어.", petMood: "idle" };
      }
      return { reply: `할 일 ${result.deletedCount}개를 전부 지웠어.`, petMood: "happy" };
    }
    case "todo.deleteCompleted": {
      const result = repositories.todos.deleteCompleted();
      if (!result.deletedCount) {
        return { reply: "지울 완료된 할 일이 없어.", petMood: "idle" };
      }
      return { reply: `완료된 할 일 ${result.deletedCount}개를 지웠어.`, petMood: "happy" };
    }
    case "todo.complete": {
      if (!intent.params.target) {
        return { reply: "어떤 할 일을 완료할지 번호나 키워드를 알려줘.", petMood: "error" };
      }
      const completed = repositories.todos.complete(intent.params.target);
      if (!completed) {
        return { reply: "완료할 할 일을 찾지 못했어.", petMood: "error" };
      }
      return { reply: `할 일 #${completed.id} 완료: ${completed.content}`, petMood: "happy" };
    }
    case "schedule.add": {
      const event = repositories.events.add({
        title: intent.params.title,
        startAt: intent.params.startAt,
        endAt: intent.params.endAt,
        allDay: intent.params.allDay
      });
      return {
        reply: `일정 #${event.id} 등록: ${event.title} (${formatDateSummary(event.startAt, event.allDay)})`,
        petMood: "happy"
      };
    }
    case "schedule.delete": {
      if (!intent.params.target) {
        return { reply: "어떤 일정을 지울지 번호나 제목 일부를 알려줘.", petMood: "error" };
      }
      const deleted = deleteEventByTarget(repositories, intent.params.target);
      if (!deleted) {
        return { reply: "지울 일정을 찾지 못했어.", petMood: "error" };
      }
      return {
        reply: `일정 #${deleted.id} 삭제 완료: ${deleted.title}`,
        petMood: "happy"
      };
    }
    case "schedule.deleteAll": {
      const result = repositories.events.deleteAll();
      if (!result.deletedCount) {
        return { reply: "지울 일정이 없어.", petMood: "idle" };
      }
      return { reply: `일정 ${result.deletedCount}개를 전부 지웠어.`, petMood: "happy" };
    }
    case "schedule.listDay": {
      const day = intent.params.day === "tomorrow" ? offsetDay(1) : offsetDay(0);
      const nextDay = offsetDay(intent.params.day === "tomorrow" ? 2 : 1);
      const events = repositories.events.listForDay(day.toISOString(), nextDay.toISOString());
      const reply = events.length
        ? events.map((event) => `${formatDateSummary(event.startAt, event.allDay)} ${event.title}`).join("\n")
        : "그 날의 일정이 비어 있어.";
      return { reply, petMood: "idle" };
    }
    case "schedule.listUpcoming": {
      const events = repositories.events.listUpcoming(5);
      const reply = events.length
        ? events.map((event) => `${formatDateSummary(event.startAt, event.allDay)} ${event.title}`).join("\n")
        : "다가오는 일정이 없어.";
      return { reply, petMood: "idle" };
    }
    case "github.overview": {
      const overview = await githubClient.getOverview();
      return { reply: overview.summaryLines.join("\n"), petMood: overview.status === "ok" ? "idle" : "error" };
    }
    case "github.query": {
      const question = intent.params.question?.trim();
      if (!question) {
        return { reply: "GitHub에서 무엇을 확인할지 말해줘.", petMood: "error" };
      }

      const githubContext = await githubClient.getContext();
      const answer = await llmClient.chat(
        [
          {
            role: "user",
            content: buildGitHubQuestionPrompt(question, githubContext.contextLines || githubContext.summaryLines)
          }
        ],
        llmConfig.githubQuerySystemPrompt,
        { activeView }
      );

      state.githubNotes = appendGitHubNote(state.githubNotes, question, answer);
      return {
        reply: answer,
        petMood: githubContext.status === "error" ? "error" : "idle"
      };
    }
    case "chat":
    default: {
      state.conversation.push({ role: "user", content: rawInput });
      const toolIntent = await planToolIntent(llmClient, state.conversation, {
        activeView,
        currentDateTime,
        timezone
      });

      if (toolIntent) {
        if (requiresConfirmation(toolIntent)) {
          state.pendingConfirmation = {
            intent: {
              type: toolIntent.type,
              confidence: toolIntent.confidence,
              params: toolIntent.params
            },
            rawInput,
            activeView
          };
          const confirmationMessage = buildConfirmationMessage(toolIntent);
          return { reply: confirmationMessage, petMood: "idle", intent: toolIntent };
        }

        const toolResult = await executeIntent(
          toolIntent,
          repositories,
          githubClient,
          llmClient,
          llmConfig,
          state,
          rawInput,
          activeView,
          currentDateTime,
          timezone
        );

        if (shouldNaturalizeToolResult(toolIntent.type)) {
          const content = await llmClient.chat(
            buildToolAwareMessages(state.conversation.slice(-llmConfig.historyLimit), toolResult.reply),
            buildToolAwareSystemPrompt(llmConfig.chatSystemPrompt),
            { activeView, currentDateTime, timezone }
          );
          state.conversation.push({ role: "assistant", content });
          return { reply: content, petMood: toolResult.petMood || "idle" };
        }

        state.conversation.push({ role: "assistant", content: toolResult.reply });
        return toolResult;
      }

      const content = await llmClient.chat(
        state.conversation.slice(-llmConfig.historyLimit),
        undefined,
        { activeView, currentDateTime, timezone }
      );
      state.conversation.push({ role: "assistant", content });
      return { reply: content, petMood: "idle" };
    }
  }
}

async function planToolIntent(llmClient, conversation, context) {
  if (typeof llmClient.planToolUse !== "function") {
    return null;
  }

  const planned = await llmClient.planToolUse(conversation, context);
  if (!planned) {
    return null;
  }

  const validation = validateIntent(planned, conversation.at(-1)?.content || "");
  if (!validation.ok || !isExecutableToolIntent(validation.intent.type)) {
    return null;
  }

  if (validation.intent.confidence < 0.65) {
    return null;
  }

  return validation.intent;
}

async function maybeNarrateIntentResult(
  intent,
  result,
  llmClient,
  llmConfig,
  rawInput,
  activeView,
  currentDateTime,
  timezone
) {
  if (!shouldNarrateIntentReply(intent?.type, llmConfig)) {
    return result;
  }

  const narrated = await llmClient.chat(
    buildOutcomeAwareMessages(rawInput, result.reply),
    buildOutcomeAwareSystemPrompt(llmConfig.chatSystemPrompt),
    { activeView, currentDateTime, timezone }
  );

  if (!isUsableNarratedReply(narrated, llmConfig)) {
    return result;
  }

  return {
    ...result,
    reply: narrated
  };
}

function currentMood(state) {
  const idleMs = Date.now() - state.lastInteractionAt;
  if (state.petMood === "working" || state.petMood === "error" || state.petMood === "happy") {
    return state.petMood;
  }
  return idleMs > 1000 * 60 * 10 ? "hungry" : "idle";
}

function offsetDay(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date;
}

function formatDateSummary(isoString, allDay) {
  const date = new Date(isoString);
  if (allDay) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildGitHubPanelLines(summaryLines, notes) {
  const summary = summaryLines.length ? summaryLines : ["(empty)"];
  if (!notes.length) {
    return summary;
  }

  return [...summary, "", "notes", ...flattenGitHubNotes(notes)];
}

function appendGitHubNote(currentNotes, question, answer) {
  const nextNotes = [
    ...currentNotes,
    {
      question: question.trim(),
      answer: answer.trim()
    }
  ];

  return nextNotes.slice(-4);
}

function flattenGitHubNotes(notes) {
  return notes.flatMap((note, index) => {
    const answerLines = note.answer.split("\n").filter(Boolean);
    const formatted = [
      `  q${index + 1} · ${note.question}`,
      ...answerLines.map((line, lineIndex) => `${lineIndex === 0 ? "  a" : "   "}  · ${line}`)
    ];
    return formatted;
  });
}

function buildGitHubQuestionPrompt(question, contextLines) {
  return [
    "GitHub context:",
    ...contextLines,
    "",
    `Question: ${question}`
  ].join("\n");
}

function buildOutcomeAwareSystemPrompt(chatSystemPrompt) {
  return [
    chatSystemPrompt,
    "You may receive one internal assistant message that starts with 'NekoDesk internal outcome:'.",
    "Use it to answer the user naturally and briefly.",
    "Do not mention internal tools, hidden state, or system mechanics unless the user explicitly asks."
  ].join("\n");
}

function buildOutcomeAwareMessages(rawInput, resultReply) {
  return [
    { role: "user", content: rawInput },
    {
      role: "assistant",
      content: `NekoDesk internal outcome:\n${resultReply}`
    }
  ];
}

function inferNextView(intentType) {
  if (intentType === "view.switch") {
    return null;
  }

  if (intentType.startsWith("memo.")) {
    return "memo";
  }

  if (intentType.startsWith("todo.")) {
    return "todo";
  }

  if (intentType.startsWith("schedule.")) {
    return "schedule";
  }

  if (intentType.startsWith("github.")) {
    return "github";
  }

  return null;
}

function pendingViewForAction(_action, activeView) {
  return activeView || null;
}

function buildToolAwareSystemPrompt(chatSystemPrompt) {
  return [
    chatSystemPrompt,
    "You may receive one internal assistant message that starts with 'NekoDesk internal context:'.",
    "Use that context naturally to answer the user.",
    "Do not mention internal tools, hidden context, or system mechanics unless the user explicitly asks."
  ].join("\n");
}

function buildToolAwareMessages(messages, toolReply) {
  return [
    ...messages,
    {
      role: "assistant",
      content: `NekoDesk internal context:\n${toolReply}`
    }
  ];
}

function shouldNarrateIntentReply(type, llmConfig) {
  if (llmConfig?.narrateActionReplies !== true) {
    return false;
  }

  return (
    type === "system.exit" ||
    type === "system.refresh" ||
    type === "view.switch" ||
    type === "memo.add" ||
    type === "memo.delete" ||
    type === "memo.deleteAll" ||
    type === "todo.add" ||
    type === "todo.delete" ||
    type === "todo.deleteAll" ||
    type === "todo.deleteCompleted" ||
    type === "todo.complete" ||
    type === "schedule.add" ||
    type === "schedule.delete" ||
    type === "schedule.deleteAll"
  );
}

function isUsableNarratedReply(reply, llmConfig) {
  if (!reply || typeof reply !== "string") {
    return false;
  }

  if (llmConfig?.fallbackReply && reply === llmConfig.fallbackReply) {
    return false;
  }

  if (llmConfig?.connectionErrorReply && reply.startsWith(llmConfig.connectionErrorReply)) {
    return false;
  }

  return true;
}

function shouldNaturalizeToolResult(type) {
  return (
    type === "memo.list" ||
    type === "todo.list" ||
    type === "schedule.listDay" ||
    type === "schedule.listUpcoming" ||
    type === "github.overview"
  );
}

function isExecutableToolIntent(type) {
  return (
    type !== "chat" &&
    type !== "help" &&
    type !== "system.exit" &&
    type !== "system.refresh"
  );
}

function currentDateTime() {
  return new Date().toISOString();
}

function deleteEventByTarget(repositories, target) {
  const directMatch = repositories.events.delete(target);
  if (directMatch) {
    return directMatch;
  }

  const events = repositories.events.listUpcoming(100, "1970-01-01T00:00:00.000Z");
  const matched = events.find((event) => eventMatchesTarget(event, target));
  if (!matched) {
    return null;
  }

  return repositories.events.delete(String(matched.id));
}

function eventMatchesTarget(event, target) {
  const normalizedTarget = normalizeText(target);
  if (!normalizedTarget) {
    return false;
  }

  if (normalizeText(event.title).includes(normalizedTarget)) {
    return true;
  }

  return buildEventTargetAliases(event).some((alias) => normalizeText(alias).includes(normalizedTarget));
}

function buildEventTargetAliases(event) {
  const date = new Date(event.startAt);
  const hours24 = date.getHours();
  const minutes = date.getMinutes();
  const hours12 = hours24 % 12 || 12;
  const minuteText = String(minutes).padStart(2, "0");
  const ampmKo = hours24 < 12 ? "오전" : "오후";
  const ampmEn = hours24 < 12 ? "am" : "pm";

  const aliases = new Set([
    String(event.id),
    event.title,
    `${hours24}시`,
    `${String(hours24).padStart(2, "0")}시`,
    `${hours24}:${minuteText}`,
    `${String(hours24).padStart(2, "0")}:${minuteText}`,
    `${hours12}시`,
    `${ampmKo} ${hours12}시`,
    `${ampmEn} ${hours12}:${minuteText}`
  ]);

  if (minutes > 0) {
    aliases.add(`${hours24}시 ${minutes}분`);
    aliases.add(`${hours12}시 ${minutes}분`);
    aliases.add(`${ampmKo} ${hours12}시 ${minutes}분`);
  }

  return [...aliases];
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}
