import { loadConfig } from "./config.js";
import { createDatabase } from "./storage/database.js";
import { createRepositories } from "./storage/repositories.js";
import { routeIntent } from "./services/intent-router.js";
import { LLMClient } from "./services/llm-client.js";
import { GitHubClient } from "./services/github-client.js";
import { WebSearchClient } from "./services/web-search-client.js";
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

const PET_MOODS = new Set([
  "idle",
  "happy",
  "playful",
  "curious",
  "sleepy",
  "proud",
  "shy",
  "hungry",
  "working",
  "error"
]);
const PET_STATE_TAG_PATTERN = /\[\[PET_STATE:([a-z_]+)\]\]/gi;

export async function createAppController(overrides = {}) {
  const config = overrides.config || loadConfig();
  const db = overrides.db || createDatabase(config.dbPath);
  const repositories = overrides.repositories || createRepositories(db);
  const llmClient = overrides.llmClient || new LLMClient(config.llm);
  const conversationMemoryLimit = resolveConversationMemoryLimit(config);
  const githubClient = overrides.githubClient || new GitHubClient({
    githubToken: config.githubToken,
    githubApiBaseUrl: config.githubApiBaseUrl
  });
  const webSearchClient = overrides.webSearchClient || new WebSearchClient(config.webSearch);
  const initialConversation = loadConversationState(repositories, conversationMemoryLimit);

  const state = {
    petMood: "idle",
    lastInteractionAt: Date.now(),
    lastReply: findLastAssistantReply(initialConversation),
    conversation: initialConversation,
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
        conversation: state.conversation.map((message) => ({
          role: message.role,
          text: message.content
        })),
        pendingConfirmation: state.pendingConfirmation
          ? {
              message: buildConfirmationMessage(state.pendingConfirmation.intent),
              options: ["confirm", "cancel"]
            }
          : null,
        meta: {
          llmEndpoint: config.llm.baseUrl,
          conversationMemoryLimit
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
      const trimmedInput = input.trim();

      if (state.pendingConfirmation) {
        if (trimmedInput) {
          appendConversationMessage(state, repositories, conversationMemoryLimit, {
            role: "user",
            content: trimmedInput
          });
        }
        state.lastInteractionAt = Date.now();
        state.lastReply = "먼저 확인을 선택해줘.";
        state.petMood = "idle";
        appendConversationMessage(state, repositories, conversationMemoryLimit, {
          role: "assistant",
          content: "먼저 확인을 선택해줘."
        });
        return {
          reply: "먼저 확인을 선택해줘.",
          petMood: "idle",
          nextView: state.pendingConfirmation?.activeView || activeView,
          intent: { type: "chat", confidence: 1, params: {} }
        };
      }

      if (trimmedInput) {
        appendConversationMessage(state, repositories, conversationMemoryLimit, {
          role: "user",
          content: trimmedInput
        });
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
        appendConversationMessage(state, repositories, conversationMemoryLimit, {
          role: "assistant",
          content: buildConfirmationMessage(intent)
        });
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
        webSearchClient,
        llmClient,
        config.llm,
        state,
        input,
        activeView,
        currentDateTime,
        timezone
      );
      const finalizedResult = await finalizeIntentResult(
        intent,
        result,
        llmClient,
        config.llm,
        input,
        activeView,
        currentDateTime,
        timezone
      );
      const normalizedResult = normalizePetReplyResult(finalizedResult);
      state.lastInteractionAt = Date.now();
      state.lastReply = normalizedResult.reply;
      state.petMood = normalizedResult.petMood;
      appendConversationMessage(state, repositories, conversationMemoryLimit, {
        role: "assistant",
        content: normalizedResult.reply
      });
      return {
        ...normalizedResult,
        nextView: normalizedResult.nextView || inferNextView(intent.type),
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
        const pendingView = state.pendingConfirmation?.activeView || null;
        appendConversationMessage(state, repositories, conversationMemoryLimit, {
          role: "system",
          content: "[cancel]"
        });
        state.pendingConfirmation = null;
        state.lastInteractionAt = Date.now();
        state.lastReply = "취소했어.";
        state.petMood = "idle";
        appendConversationMessage(state, repositories, conversationMemoryLimit, {
          role: "assistant",
          content: "취소했어."
        });
        return {
          reply: "취소했어.",
          petMood: "idle",
          nextView: pendingViewForAction("cancel", pendingView),
          intent: { type: "chat", confidence: 1, params: {} }
        };
      }

      const confirmedIntent = state.pendingConfirmation.intent;
      appendConversationMessage(state, repositories, conversationMemoryLimit, {
        role: "system",
        content: "[confirm]"
      });
      const result = await executeIntent(
        confirmedIntent,
        repositories,
        githubClient,
        webSearchClient,
        llmClient,
        config.llm,
        state,
        state.pendingConfirmation.rawInput,
        state.pendingConfirmation.activeView,
        currentDateTime(),
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      );
      const finalizedResult = await finalizeIntentResult(
        confirmedIntent,
        result,
        llmClient,
        config.llm,
        state.pendingConfirmation.rawInput,
        state.pendingConfirmation.activeView,
        currentDateTime(),
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      );
      const normalizedResult = normalizePetReplyResult(finalizedResult);
      state.pendingConfirmation = null;
      state.lastInteractionAt = Date.now();
      state.lastReply = normalizedResult.reply;
      state.petMood = normalizedResult.petMood;
      appendConversationMessage(state, repositories, conversationMemoryLimit, {
        role: "assistant",
        content: normalizedResult.reply
      });
      return {
        ...normalizedResult,
        nextView: normalizedResult.nextView || inferNextView(confirmedIntent.type),
        intent: confirmedIntent
      };
    }
  };
}

async function executeIntent(
  intent,
  repositories,
  githubClient,
  webSearchClient,
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
      return buildDirectReply("다음에 또 불러줘.", { petMood: "happy", shouldExit: true });
    case "system.refresh":
      return buildDirectReply("대시보드를 새로 확인했어.", { petMood: "idle" });
    case "help":
      return buildDirectReply(HELP_TEXT, { petMood: "idle" });
    case "view.switch":
      return buildToolResult(
        intent.type,
        "success",
        {
          view: intent.params.view
        },
        {
          petMood: "idle",
          nextView: intent.params.view
        }
      );
    case "memo.add": {
      const memo = repositories.memos.add({ content: intent.params.content });
      return buildToolResult(
        intent.type,
        "success",
        {
          item: {
            id: memo.id,
            content: memo.content
          }
        },
        {
          petMood: "happy"
        }
      );
    }
    case "memo.delete": {
      if (!intent.params.target) {
        return buildToolResult(
          intent.type,
          "missing_input",
          {
            required: "target",
            targetType: "memo"
          },
          {
            petMood: "error"
          }
        );
      }
      const deleted = repositories.memos.delete(intent.params.target);
      if (!deleted) {
        return buildToolResult(
          intent.type,
          "not_found",
          {
            target: intent.params.target,
            targetType: "memo"
          },
          {
            petMood: "error"
          }
        );
      }
      return buildToolResult(
        intent.type,
        "success",
        {
          item: {
            id: deleted.id,
            content: deleted.content
          }
        },
        {
          petMood: "happy"
        }
      );
    }
    case "memo.deleteAll": {
      const result = repositories.memos.deleteAll();
      return buildToolResult(
        intent.type,
        result.deletedCount ? "success" : "empty",
        {
          deletedCount: result.deletedCount
        },
        {
          petMood: result.deletedCount ? "happy" : "idle"
        }
      );
    }
    case "memo.list": {
      const memos = repositories.memos.listRecent(5);
      return buildToolResult(
        intent.type,
        memos.length ? "success" : "empty",
        {
          items: memos.map((memo) => ({
            id: memo.id,
            content: memo.content
          }))
        },
        {
          petMood: "idle"
        }
      );
    }
    case "todo.add": {
      const todo = repositories.todos.add({ content: intent.params.content });
      return buildToolResult(
        intent.type,
        "success",
        {
          item: {
            id: todo.id,
            content: todo.content,
            status: todo.status
          }
        },
        {
          petMood: "happy"
        }
      );
    }
    case "todo.list": {
      const todos = repositories.todos.list(8);
      return buildToolResult(
        intent.type,
        todos.length ? "success" : "empty",
        {
          items: todos.map((todo) => ({
            id: todo.id,
            content: todo.content,
            status: todo.status
          }))
        },
        {
          petMood: "idle"
        }
      );
    }
    case "todo.delete": {
      if (!intent.params.target) {
        return buildToolResult(
          intent.type,
          "missing_input",
          {
            required: "target",
            targetType: "todo"
          },
          {
            petMood: "error"
          }
        );
      }
      const deleted = repositories.todos.delete(intent.params.target);
      if (!deleted) {
        return buildToolResult(
          intent.type,
          "not_found",
          {
            target: intent.params.target,
            targetType: "todo"
          },
          {
            petMood: "error"
          }
        );
      }
      return buildToolResult(
        intent.type,
        "success",
        {
          item: {
            id: deleted.id,
            content: deleted.content,
            status: deleted.status
          }
        },
        {
          petMood: "happy"
        }
      );
    }
    case "todo.deleteAll": {
      const result = repositories.todos.deleteAll();
      return buildToolResult(
        intent.type,
        result.deletedCount ? "success" : "empty",
        {
          deletedCount: result.deletedCount
        },
        {
          petMood: result.deletedCount ? "happy" : "idle"
        }
      );
    }
    case "todo.deleteCompleted": {
      const result = repositories.todos.deleteCompleted();
      return buildToolResult(
        intent.type,
        result.deletedCount ? "success" : "empty",
        {
          deletedCount: result.deletedCount
        },
        {
          petMood: result.deletedCount ? "happy" : "idle"
        }
      );
    }
    case "todo.complete": {
      if (!intent.params.target) {
        return buildToolResult(
          intent.type,
          "missing_input",
          {
            required: "target",
            targetType: "todo"
          },
          {
            petMood: "error"
          }
        );
      }
      const completed = repositories.todos.complete(intent.params.target);
      if (!completed) {
        return buildToolResult(
          intent.type,
          "not_found",
          {
            target: intent.params.target,
            targetType: "todo"
          },
          {
            petMood: "error"
          }
        );
      }
      return buildToolResult(
        intent.type,
        "success",
        {
          item: {
            id: completed.id,
            content: completed.content,
            status: completed.status
          }
        },
        {
          petMood: "happy"
        }
      );
    }
    case "schedule.add": {
      const event = repositories.events.add({
        title: intent.params.title,
        startAt: intent.params.startAt,
        endAt: intent.params.endAt,
        allDay: intent.params.allDay
      });
      return buildToolResult(
        intent.type,
        "success",
        {
          item: {
            id: event.id,
            title: event.title,
            startAt: event.startAt,
            endAt: event.endAt,
            allDay: event.allDay
          }
        },
        {
          petMood: "happy"
        }
      );
    }
    case "schedule.delete": {
      if (!intent.params.target) {
        return buildToolResult(
          intent.type,
          "missing_input",
          {
            required: "target",
            targetType: "schedule"
          },
          {
            petMood: "error"
          }
        );
      }
      const deleted = deleteEventByTarget(repositories, intent.params.target);
      if (!deleted) {
        return buildToolResult(
          intent.type,
          "not_found",
          {
            target: intent.params.target,
            targetType: "schedule"
          },
          {
            petMood: "error"
          }
        );
      }
      return buildToolResult(
        intent.type,
        "success",
        {
          item: {
            id: deleted.id,
            title: deleted.title,
            startAt: deleted.startAt,
            endAt: deleted.endAt,
            allDay: deleted.allDay
          }
        },
        {
          petMood: "happy"
        }
      );
    }
    case "schedule.deleteAll": {
      const result = repositories.events.deleteAll();
      return buildToolResult(
        intent.type,
        result.deletedCount ? "success" : "empty",
        {
          deletedCount: result.deletedCount
        },
        {
          petMood: result.deletedCount ? "happy" : "idle"
        }
      );
    }
    case "schedule.listDay": {
      const day = intent.params.day === "tomorrow" ? offsetDay(1) : offsetDay(0);
      const nextDay = offsetDay(intent.params.day === "tomorrow" ? 2 : 1);
      const events = repositories.events.listForDay(day.toISOString(), nextDay.toISOString());
      return buildToolResult(
        intent.type,
        events.length ? "success" : "empty",
        {
          day: intent.params.day,
          items: events.map((event) => ({
            id: event.id,
            title: event.title,
            startAt: event.startAt,
            endAt: event.endAt,
            allDay: event.allDay
          }))
        },
        {
          petMood: "idle"
        }
      );
    }
    case "schedule.listUpcoming": {
      const events = repositories.events.listUpcoming(5);
      return buildToolResult(
        intent.type,
        events.length ? "success" : "empty",
        {
          items: events.map((event) => ({
            id: event.id,
            title: event.title,
            startAt: event.startAt,
            endAt: event.endAt,
            allDay: event.allDay
          }))
        },
        {
          petMood: "idle"
        }
      );
    }
    case "github.overview": {
      const overview = await githubClient.getOverview();
      return buildToolResult(
        intent.type,
        overview.status,
        {
          summaryLines: overview.summaryLines,
          contextLines: overview.contextLines
        },
        {
          petMood: overview.status === "ok" ? "idle" : "error"
        }
      );
    }
    case "github.query": {
      const question = intent.params.question?.trim();
      if (!question) {
        return buildToolResult(
          intent.type,
          "missing_input",
          {
            required: "question",
            targetType: "github"
          },
          {
            petMood: "error"
          }
        );
      }

      const githubContext = await githubClient.getContext();
      const rawAnswer = await llmClient.chat(
        [
          {
            role: "user",
            content: buildGitHubQuestionPrompt(question, githubContext.contextLines || githubContext.summaryLines)
          }
        ],
        llmConfig.githubQuerySystemPrompt,
        { activeView }
      );
      const answer = normalizePetTaggedReply(rawAnswer, githubContext.status === "error" ? "error" : "curious");

      state.githubNotes = appendGitHubNote(state.githubNotes, question, answer.reply);
      return buildDirectReply(answer.reply, {
        petMood: answer.petMood
      });
    }
    case "web.search": {
      const query = intent.params.query?.trim();
      if (!query) {
        return buildToolResult(
          intent.type,
          "missing_input",
          {
            required: "query",
            targetType: "web"
          },
          {
            petMood: "error"
          }
        );
      }

      const search = await webSearchClient.search(query);
      return buildToolResult(
        intent.type,
        search.status,
        {
          query: search.query,
          results: search.results,
          error: search.error || null
        },
        {
          petMood: search.status === "error" ? "error" : "idle"
        }
      );
    }
    case "chat":
    default: {
      const llmMessages = buildConversationContext(state.conversation, llmConfig.historyLimit);
      const toolIntent = await planToolIntent(llmClient, llmMessages, {
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
          return buildDirectReply(confirmationMessage, { petMood: "idle", intent: toolIntent });
        }

        const toolResult = await executeIntent(
          toolIntent,
          repositories,
          githubClient,
          webSearchClient,
          llmClient,
          llmConfig,
          state,
          rawInput,
          activeView,
          currentDateTime,
          timezone
        );
        const finalizedToolResult = await finalizeIntentResult(
          toolIntent,
          toolResult,
          llmClient,
          llmConfig,
          rawInput,
          activeView,
          currentDateTime,
          timezone
        );
        return finalizedToolResult;
      }

      const content = await llmClient.chat(
        llmMessages,
        undefined,
        { activeView, currentDateTime, timezone }
      );
      return buildDirectReply(content, { petMood: "idle" });
    }
  }
}

function buildDirectReply(reply, extras = {}) {
  return {
    ...extras,
    reply
  };
}

function buildToolResult(intentType, status, data, extras = {}) {
  return {
    ...extras,
    toolResult: {
      intentType,
      status,
      data
    }
  };
}

function loadConversationState(repositories, limit) {
  if (!repositories?.conversation?.listRecent) {
    return [];
  }

  return repositories.conversation.listRecent(limit).map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function appendConversationMessage(state, repositories, limit, message) {
  if (!message?.content || typeof message.content !== "string") {
    return;
  }

  const normalized = {
    role: normalizeConversationRole(message.role),
    content: message.content
  };

  if (repositories?.conversation?.add) {
    repositories.conversation.add(normalized);
  }

  state.conversation.push(normalized);
  trimConversationInMemory(state, limit);
}

function trimConversationInMemory(state, limit) {
  if (!Array.isArray(state.conversation) || state.conversation.length <= limit) {
    return;
  }

  state.conversation = state.conversation.slice(-limit);
}

function buildConversationContext(conversation, limit) {
  return conversation
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-limit);
}

function findLastAssistantReply(conversation) {
  const lastAssistant = [...conversation].reverse().find((message) => message.role === "assistant");
  return lastAssistant?.content || "";
}

function normalizeConversationRole(role) {
  return role === "assistant" || role === "system" ? role : "user";
}

function resolveConversationMemoryLimit(config) {
  const explicit = Number(config?.conversationMemoryLimit);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }

  const historyLimit = Number(config?.llm?.historyLimit);
  if (Number.isFinite(historyLimit) && historyLimit > 0) {
    return Math.max(historyLimit * 4, 40);
  }

  return 40;
}

async function finalizeIntentResult(
  _intent,
  result,
  llmClient,
  llmConfig,
  rawInput,
  activeView,
  currentDateTime,
  timezone
) {
  if (!result?.toolResult) {
    return result;
  }

  const reply = await llmClient.chat(
    buildToolNarrationMessages(rawInput, result.toolResult),
    buildToolNarrationSystemPrompt(llmConfig.chatSystemPrompt),
    { activeView, currentDateTime, timezone }
  );
  const normalizedReply = isUnusableNarratedReply(reply, llmConfig)
    ? buildDeterministicToolReply(result.toolResult)
    : reply;
  const finalizedReply = appendSearchSourcesToReply(normalizedReply, result.toolResult);

  return {
    ...result,
    reply: finalizedReply
  };
}

function buildToolNarrationSystemPrompt(chatSystemPrompt) {
  return [
    chatSystemPrompt,
    "You may receive one internal assistant message that starts with 'NekoDesk tool result JSON:'.",
    "Treat that JSON as the authoritative outcome of an executed internal tool or routed feature.",
    "Answer the user naturally and concisely based on that JSON.",
    "If the tool result says data is empty, missing, not found, unauthenticated, partial, or error, explain that accurately.",
    "If the tool result includes lists, summarize the useful items instead of dumping raw JSON.",
    "If the tool result intentType is web.search, only claim things that are directly supported by the provided search results.",
    "For web.search, avoid pretending you opened full articles unless the tool result explicitly contains article content.",
    "For web.search, prefer cautious wording when titles alone are ambiguous.",
    "For web.search, include brief source attribution based on the provided domains and URLs.",
    "Do not mention internal tools, JSON, hidden state, or system mechanics unless the user explicitly asks."
  ].join("\n");
}

function appendSearchSourcesToReply(reply, toolResult) {
  if (toolResult?.intentType !== "web.search") {
    return reply;
  }

  const results = Array.isArray(toolResult?.data?.results) ? toolResult.data.results.slice(0, 3) : [];
  if (!results.length) {
    return reply;
  }

  const sourceSummary = results
    .map((result) => `${result.title || "result"} (${result.host || "source"})`)
    .join(" | ");
  return [reply.trim(), `출처: ${sourceSummary}`].join("\n");
}

function isUnusableNarratedReply(reply, llmConfig) {
  if (!reply || typeof reply !== "string") {
    return true;
  }

  if (llmConfig?.fallbackReply && reply === llmConfig.fallbackReply) {
    return true;
  }

  if (llmConfig?.connectionErrorReply && reply.startsWith(llmConfig.connectionErrorReply)) {
    return true;
  }

  return false;
}

function buildDeterministicToolReply(toolResult) {
  if (toolResult?.intentType === "view.switch") {
    return buildDeterministicViewSwitchReply(toolResult);
  }

  if (toolResult?.intentType === "web.search") {
    return buildDeterministicWebSearchReply(toolResult);
  }

  return "결과는 확인했어.";
}

function buildDeterministicViewSwitchReply(toolResult) {
  const view = toolResult?.data?.view;
  if (typeof view === "string" && view.trim()) {
    return `${view} 화면으로 바꿨어.`;
  }

  return "화면을 바꿨어.";
}

function buildDeterministicWebSearchReply(toolResult) {
  const query = toolResult?.data?.query?.trim() || "검색어";
  const results = Array.isArray(toolResult?.data?.results) ? toolResult.data.results.slice(0, 3) : [];

  if (toolResult?.status === "missing_input") {
    return "무엇을 검색할지 먼저 알려줘.";
  }

  if (toolResult?.status === "disabled") {
    return "지금은 DuckDuckGo 검색 기능이 꺼져 있어.";
  }

  if (toolResult?.status === "error") {
    return `DuckDuckGo에서 "${query}" 관련 결과를 찾으려 했는데 검색 중 문제가 있었어.`;
  }

  if (!results.length) {
    return `DuckDuckGo에서 "${query}" 관련 결과를 뚜렷하게 찾지 못했어.`;
  }

  const headlines = results.map((result) => result.title).join(" / ");
  return `DuckDuckGo로 "${query}"를 검색했어. 눈에 띈 결과는 ${headlines} 이야.`;
}

function buildToolNarrationMessages(rawInput, toolResult) {
  return [
    { role: "user", content: rawInput },
    {
      role: "assistant",
      content: `NekoDesk tool result JSON:\n${JSON.stringify(toolResult, null, 2)}`
    }
  ];
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

function currentMood(state) {
  const idleMs = Date.now() - state.lastInteractionAt;
  if (state.petMood === "working" || state.petMood === "error") {
    return state.petMood;
  }

  if (idleMs > 1000 * 60 * 10) {
    return "hungry";
  }

  return PET_MOODS.has(state.petMood) ? state.petMood : "idle";
}

function normalizePetReplyResult(result) {
  if (!result || typeof result.reply !== "string") {
    return result;
  }

  const normalized = normalizePetTaggedReply(result.reply, result.petMood);
  return {
    ...result,
    reply: normalized.reply,
    petMood: normalized.petMood
  };
}

function normalizePetTaggedReply(reply, fallbackMood = "idle") {
  if (typeof reply !== "string") {
    return {
      reply,
      petMood: PET_MOODS.has(fallbackMood) ? fallbackMood : "idle"
    };
  }

  let detectedMood = null;
  const strippedReply = reply
    .replace(PET_STATE_TAG_PATTERN, (_match, mood) => {
      const normalizedMood = String(mood || "").trim().toLowerCase();
      if (PET_MOODS.has(normalizedMood)) {
        detectedMood = normalizedMood;
      }
      return "";
    })
    .trim();

  return {
    reply: strippedReply || reply.trim(),
    petMood: detectedMood || (PET_MOODS.has(fallbackMood) ? fallbackMood : "idle")
  };
}

function offsetDay(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date;
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
