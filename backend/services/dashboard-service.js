function formatEvent(event) {
  const start = new Date(event.startAt);
  const hour = event.allDay
    ? "all day"
    : start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${hour} ${event.title}`;
}

export async function buildDashboard(repositories, githubClient) {
  const memos = repositories.memos.listRecent(4);
  const todos = repositories.todos.list(6);
  const events = repositories.events.listUpcoming(5);
  const github = await githubClient.getOverview();

  return {
    memos: memos.map((memo) => `#${memo.id} ${memo.content}`),
    todos: todos.map((todo) => {
      const marker = todo.status === "done" ? "[x]" : "[ ]";
      return `${marker} ${todo.id}. ${todo.content}`;
    }),
    events: events.map(formatEvent),
    github: github.summaryLines
  };
}
