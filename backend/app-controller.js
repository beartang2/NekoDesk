import { loadConfig } from "./config.js";
import { createDatabase } from "./storage/database.js";
import { createRepositories } from "./storage/repositories.js";
import { routeIntent } from "./services/intent-router.js";
import { LLMClient } from "./services/llm-client.js";
import { GitHubClient } from "./services/github-client.js";
import { buildDashboard } from "./services/dashboard-service.js";

const HELP_TEXT = [
  "사용 예시",
  "- 메모 프로젝트 아이디어 정리",
  "- 할 일 README 정리 추가",
  "- 할 일 1번 완료",
  "- 내일 3시 회의 등록",
  "- 오늘 일정 보여줘",
  "- 내 GitHub 상태 요약해줘",
  "- exit"
].join("\n");

export async function createAppController() {
  const config = loadConfig();
  const db = createDatabase(config.dbPath);
  const repositories = createRepositories(db);
  const llmClient = new LLMClient(config.llm);
  const githubClient = new GitHubClient({
    githubToken: config.githubToken,
    githubApiBaseUrl: config.githubApiBaseUrl
  });

  const state = {
    petMood: "idle",
    lastInteractionAt: Date.now(),
    lastReply: "냥. 준비됐어.",
    conversation: []
  };

  return {
    async getViewModel() {
      const dashboard = await buildDashboard(repositories, githubClient);
      return {
        dashboard,
        petMood: currentMood(state),
        lastReply: state.lastReply,
        hints: [
          "도움말: help",
          "종료: exit",
          "GitHub: GITHUB_TOKEN 필요"
        ]
      };
    },
    async handleInput(input) {
      state.petMood = "working";
      const intent = await routeIntent(input, llmClient);

      if (intent.confidence < 0.65) {
        state.petMood = "error";
        state.lastReply = "조금 애매했어. 더 구체적으로 말해줄래?";
        return {
          reply: state.lastReply,
          petMood: state.petMood,
          intent
        };
      }

      const result = await executeIntent(intent, repositories, githubClient, llmClient, state, input);
      state.lastInteractionAt = Date.now();
      state.lastReply = result.reply;
      state.petMood = result.petMood;
      return {
        ...result,
        intent
      };
    }
  };
}

async function executeIntent(intent, repositories, githubClient, llmClient, state, rawInput) {
  switch (intent.type) {
    case "system.exit":
      return { reply: "다음에 또 불러줘.", petMood: "happy", shouldExit: true };
    case "system.refresh":
      return { reply: "대시보드를 새로 확인했어.", petMood: "idle" };
    case "help":
      return { reply: HELP_TEXT, petMood: "idle" };
    case "memo.add": {
      const memo = repositories.memos.add({ content: intent.params.content });
      return { reply: `메모 #${memo.id} 저장 완료: ${memo.content}`, petMood: "happy" };
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
    case "chat":
    default: {
      state.conversation.push({ role: "user", content: rawInput });
      const content = await llmClient.chat(
        state.conversation.slice(-8),
        [
          "You are NekoDesk, a cute but practical terminal cat assistant.",
          "Keep replies concise.",
          "You can chat, but never claim that you changed GitHub or calendar data unless the app explicitly did so."
        ].join("\n")
      );
      state.conversation.push({ role: "assistant", content });
      return { reply: content, petMood: "idle" };
    }
  }
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
