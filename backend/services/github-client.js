export class GitHubClient {
  constructor(config) {
    this.config = config;
  }

  async getOverview() {
    return this.#buildOverview();
  }

  async getContext() {
    return this.#buildOverview();
  }

  async #buildOverview() {
    if (!this.config.githubToken) {
      return {
        status: "unauthenticated",
        summaryLines: [
          "GitHub token not configured.",
          "Set GITHUB_TOKEN to enable read-only overview."
        ],
        contextLines: [
          "GitHub token not configured.",
          "Set GITHUB_TOKEN to enable read-only overview."
        ]
      };
    }

    try {
      const [viewer, issues, pulls, reviewRequests, mentions, notifications, repositories, starred] =
        await Promise.all([
          this.#optionalRequest("/user"),
          this.#optionalSearch("/search/issues?q=is:open+assignee:@me+is:issue&per_page=5"),
          this.#optionalSearch("/search/issues?q=is:open+author:@me+is:pr&per_page=5"),
          this.#optionalSearch("/search/issues?q=is:open+review-requested:@me+is:pr&per_page=5"),
          this.#optionalSearch("/search/issues?q=is:open+mentions:@me&per_page=5"),
          this.#optionalRequest("/notifications?per_page=5"),
          this.#optionalRequest("/user/repos?sort=updated&per_page=4"),
          this.#optionalRequest("/user/starred?per_page=3")
        ]);

      return {
        status: viewer.ok ? "ok" : "partial",
        summaryLines: buildSummaryLines({
          viewer: viewer.value,
          issues: issues.value,
          pulls: pulls.value,
          reviewRequests: reviewRequests.value,
          mentions: mentions.value,
          notifications: notifications.value,
          repositories: repositories.value,
          starred: starred.value,
          errors: {
            viewer: viewer.error,
            issues: issues.error,
            pulls: pulls.error,
            reviewRequests: reviewRequests.error,
            mentions: mentions.error,
            notifications: notifications.error,
            repositories: repositories.error,
            starred: starred.error
          }
        }),
        contextLines: buildContextLines({
          viewer: viewer.value,
          issues: issues.value,
          pulls: pulls.value,
          reviewRequests: reviewRequests.value,
          mentions: mentions.value,
          notifications: notifications.value,
          repositories: repositories.value,
          starred: starred.value,
          errors: {
            viewer: viewer.error,
            issues: issues.error,
            pulls: pulls.error,
            reviewRequests: reviewRequests.error,
            mentions: mentions.error,
            notifications: notifications.error,
            repositories: repositories.error,
            starred: starred.error
          }
        })
      };
    } catch (error) {
      return {
        status: "error",
        summaryLines: [`GitHub API error: ${error.message}`],
        contextLines: [`GitHub API error: ${error.message}`]
      };
    }
  }

  async #search(path) {
    return this.#request(path);
  }

  async #optionalSearch(path) {
    return this.#optionalRequest(path);
  }

  async #optionalRequest(path) {
    try {
      const value = await this.#request(path);
      return { ok: true, value, error: null };
    } catch (error) {
      return { ok: false, value: null, error: error.message };
    }
  }

  async #request(path) {
    const response = await fetch(`${this.config.githubApiBaseUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.config.githubToken}`,
        "User-Agent": "NekoDesk"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }
}

function buildSummaryLines({ viewer, issues, pulls, reviewRequests, mentions, notifications, repositories, starred, errors }) {
  return buildSectionedLines({
    viewer,
    issues,
    pulls,
    reviewRequests,
    mentions,
    notifications,
    repositories,
    starred,
    errors,
    perSectionLimit: 3
  });
}

function buildContextLines({ viewer, issues, pulls, reviewRequests, mentions, notifications, repositories, starred, errors }) {
  return buildSectionedLines({
    viewer,
    issues,
    pulls,
    reviewRequests,
    mentions,
    notifications,
    repositories,
    starred,
    errors,
    perSectionLimit: 5
  });
}

function buildSectionedLines({
  viewer,
  issues,
  pulls,
  reviewRequests,
  mentions,
  notifications,
  repositories,
  starred,
  errors,
  perSectionLimit
}) {
  const lines = [];

  lines.push("account");
  lines.push(viewer ? formatViewer(viewer) : formatUnavailableLine("viewer", errors.viewer));

  lines.push("");
  lines.push("attention");
  lines.push(formatCountLine("Unread notifications", Array.isArray(notifications) ? notifications.length : null, errors.notifications));
  lines.push(formatCountLine("Review requests", reviewRequests?.total_count, errors.reviewRequests));
  lines.push(formatCountLine("Mentions", mentions?.total_count, errors.mentions));

  lines.push(...formatSection("notifications", formatNotifications(notifications, perSectionLimit), errors.notifications));
  lines.push(...formatSection("reviews", formatSearchItems("review", reviewRequests?.items, perSectionLimit), errors.reviewRequests));
  lines.push(...formatSection("mentions", formatSearchItems("mention", mentions?.items, perSectionLimit), errors.mentions));

  lines.push("");
  lines.push("work");
  lines.push(formatCountLine("Open issues assigned", issues?.total_count, errors.issues));
  lines.push(formatCountLine("Open PRs authored", pulls?.total_count, errors.pulls));
  lines.push(...formatSection("issues", formatSearchItems("issue", issues?.items, perSectionLimit), errors.issues));
  lines.push(...formatSection("pull requests", formatSearchItems("pr", pulls?.items, perSectionLimit), errors.pulls));

  lines.push("");
  lines.push("repos");
  lines.push(...formatSection("recent repos", formatRepositories(repositories, perSectionLimit), errors.repositories));
  lines.push(...formatSection("starred", formatStarredRepositories(starred, perSectionLimit), errors.starred));

  return trimTrailingBlankLines(lines);
}

function formatViewer(viewer) {
  const privateRepos = Number.isFinite(viewer.total_private_repos) ? viewer.total_private_repos : 0;
  return `@${viewer.login}: ${viewer.public_repos} public · ${privateRepos} private`;
}

function formatNotifications(notifications, limit = 3) {
  if (!Array.isArray(notifications) || notifications.length === 0) {
    return ["notifications: (empty)"];
  }

  return notifications.slice(0, limit).map((item) => {
    const repo = item.repository?.full_name || "unknown/repo";
    const subjectType = item.subject?.type || "Notification";
    const title = truncate(item.subject?.title || "(untitled)");
    return `notification · ${repo} · ${subjectType} · ${title}`;
  });
}

function formatSearchItems(label, items = [], limit = 3) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  return items.slice(0, limit).map((item) => {
    const repo = item.repository_url ? item.repository_url.split("/repos/")[1] : "unknown/repo";
    return `${label} · ${repo} · ${truncate(item.title || "(untitled)")}`;
  });
}

function formatStarredRepositories(repositories, limit = 3) {
  if (!Array.isArray(repositories) || repositories.length === 0) {
    return [];
  }

  return repositories.slice(0, limit).map((repo) => `starred · ${repo.full_name}`);
}

function formatRepositories(repositories, limit = 3) {
  if (!Array.isArray(repositories) || repositories.length === 0) {
    return [];
  }

  return repositories.slice(0, limit).map((repo) => {
    const visibility = repo.private ? "private" : "public";
    return `repo · ${repo.full_name} · ${visibility} · updated ${formatRelativeDate(repo.updated_at)}`;
  });
}

function formatRelativeDate(value) {
  if (!value) {
    return "unknown";
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "unknown";
  }

  const diffMs = Date.now() - timestamp;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  if (diffHours < 1) {
    return "just now";
  }

  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function truncate(text, length = 48) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function formatCountLine(label, count, error) {
  if (error) {
    return `${label}: unavailable (${error})`;
  }

  return `${label}: ${Number.isFinite(count) ? count : 0}`;
}

function formatUnavailableLine(label, error) {
  return `${label}: unavailable${error ? ` (${error})` : ""}`;
}

function formatSection(title, lines, error) {
  if (error) {
    return [`${title}: unavailable (${error})`];
  }

  if (!lines.length) {
    return [`${title}: (empty)`];
  }

  return [`${title}:`, ...lines.map((line) => `  ${line}`)];
}

function trimTrailingBlankLines(lines) {
  const trimmed = [...lines];
  while (trimmed.length && !trimmed[trimmed.length - 1]) {
    trimmed.pop();
  }
  return trimmed;
}
