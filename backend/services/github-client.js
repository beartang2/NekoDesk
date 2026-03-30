export class GitHubClient {
  constructor(config) {
    this.config = config;
  }

  async getOverview() {
    if (!this.config.githubToken) {
      return {
        status: "unauthenticated",
        summaryLines: [
          "GitHub token not configured.",
          "Set GITHUB_TOKEN to enable read-only overview."
        ]
      };
    }

    try {
      const [viewer, issues, pulls, notifications] = await Promise.all([
        this.#request("/user"),
        this.#search("/search/issues?q=is:open+assignee:@me+is:issue&per_page=5"),
        this.#search("/search/issues?q=is:open+author:@me+is:pr&per_page=5"),
        this.#request("/notifications?per_page=5")
      ]);

      return {
        status: "ok",
        summaryLines: [
          `@${viewer.login}: ${viewer.public_repos} public repos`,
          `Open issues assigned: ${issues.total_count}`,
          `Open PRs authored: ${pulls.total_count}`,
          `Unread notifications: ${Array.isArray(notifications) ? notifications.length : 0}`
        ]
      };
    } catch (error) {
      return {
        status: "error",
        summaryLines: [`GitHub API error: ${error.message}`]
      };
    }
  }

  async #search(path) {
    return this.#request(path);
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
