import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../backend/services/github-client.js";

test("GitHubClient returns richer overview lines", async () => {
  const originalFetch = global.fetch;
  const responses = new Map([
    ["/user", { login: "kdh", public_repos: 12, total_private_repos: 3 }],
    ["/search/issues?q=is:open+assignee:@me+is:issue&per_page=5", {
      total_count: 2,
      items: [
        {
          title: "Fix onboarding bug",
          repository_url: "https://api.github.com/repos/acme/app"
        }
      ]
    }],
    ["/search/issues?q=is:open+author:@me+is:pr&per_page=5", {
      total_count: 1,
      items: [
        {
          title: "Refactor dashboard layout",
          repository_url: "https://api.github.com/repos/acme/app"
        }
      ]
    }],
    ["/search/issues?q=is:open+review-requested:@me+is:pr&per_page=5", {
      total_count: 1,
      items: [
        {
          title: "Review auth middleware",
          repository_url: "https://api.github.com/repos/acme/api"
        }
      ]
    }],
    ["/search/issues?q=is:open+mentions:@me&per_page=5", {
      total_count: 2,
      items: [
        {
          title: "Need your input on release checklist",
          repository_url: "https://api.github.com/repos/acme/ops"
        }
      ]
    }],
    ["/notifications?per_page=5", [
      {
        repository: { full_name: "acme/app" },
        subject: { type: "PullRequest", title: "Review auth middleware" }
      }
    ]],
    ["/user/repos?sort=updated&per_page=4", [
      {
        full_name: "acme/app",
        private: false,
        updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      }
    ]],
    ["/user/starred?per_page=3", [
      {
        full_name: "openai/openai-openapi"
      }
    ]]
  ]);

  global.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    return {
      ok: true,
      async json() {
        return responses.get(path);
      }
    };
  };

  try {
    const client = new GitHubClient({
      githubToken: "token",
      githubApiBaseUrl: "https://api.github.com"
    });

    const result = await client.getOverview();

    assert.equal(result.status, "ok");
    assert.ok(result.summaryLines.includes("account"));
    assert.ok(result.summaryLines.some((line) => line.includes("@kdh: 12 public")));
    assert.ok(result.summaryLines.some((line) => line.includes("Review requests: 1")));
    assert.ok(result.summaryLines.some((line) => line.includes("Mentions: 2")));
    assert.ok(result.summaryLines.some((line) => line.includes("notification · acme/app")));
    assert.ok(result.summaryLines.some((line) => line.includes("review · acme/api")));
    assert.ok(result.summaryLines.some((line) => line.includes("mention · acme/ops")));
    assert.ok(result.summaryLines.some((line) => line.includes("issue · acme/app")));
    assert.ok(result.summaryLines.some((line) => line.includes("pr · acme/app")));
    assert.ok(result.summaryLines.some((line) => line.includes("repo · acme/app")));
    assert.ok(result.summaryLines.some((line) => line.includes("starred · openai/openai-openapi")));
  } finally {
    global.fetch = originalFetch;
  }
});

test("GitHubClient keeps partial overview when one endpoint fails", async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const path = new URL(url).pathname + new URL(url).search;
    if (path === "/notifications?per_page=5") {
      return {
        ok: false,
        status: 403
      };
    }

    return {
      ok: true,
      async json() {
        if (path === "/user") {
          return { login: "kdh", public_repos: 1, total_private_repos: 0 };
        }
        if (path === "/search/issues?q=is:open+assignee:@me+is:issue&per_page=5") {
          return { total_count: 0, items: [] };
        }
        if (path === "/search/issues?q=is:open+author:@me+is:pr&per_page=5") {
          return { total_count: 0, items: [] };
        }
        if (path === "/search/issues?q=is:open+review-requested:@me+is:pr&per_page=5") {
          return { total_count: 0, items: [] };
        }
        if (path === "/search/issues?q=is:open+mentions:@me&per_page=5") {
          return { total_count: 0, items: [] };
        }
        if (path === "/user/repos?sort=updated&per_page=4") {
          return [];
        }
        if (path === "/user/starred?per_page=3") {
          return [];
        }
        return null;
      }
    };
  };

  try {
    const client = new GitHubClient({
      githubToken: "token",
      githubApiBaseUrl: "https://api.github.com"
    });

    const result = await client.getOverview();

    assert.equal(result.status, "ok");
    assert.ok(result.summaryLines.some((line) => line.includes("Unread notifications: unavailable (HTTP 403)")));
    assert.ok(result.summaryLines.some((line) => line.includes("notifications: unavailable (HTTP 403)")));
    assert.ok(result.summaryLines.some((line) => line.includes("@kdh: 1 public")));
  } finally {
    global.fetch = originalFetch;
  }
});

test("GitHubClient handles missing token", async () => {
  const client = new GitHubClient({
    githubToken: "",
    githubApiBaseUrl: "https://api.github.com"
  });

  const result = await client.getOverview();
  assert.equal(result.status, "unauthenticated");
  assert.equal(result.summaryLines[0], "GitHub token not configured.");
});
