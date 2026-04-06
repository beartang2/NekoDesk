import test from "node:test";
import assert from "node:assert/strict";
import { WebSearchClient, extractSearchResults } from "../backend/services/web-search-client.js";

test("extractSearchResults parses DuckDuckGo redirect links", () => {
  const html = `
    <html>
      <body>
        <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Falpha">Example Alpha</a>
        <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fbeta">Example Beta</a>
      </body>
    </html>
  `;

  const results = extractSearchResults(html, 5);

  assert.deepEqual(results, [
    {
      title: "Example Alpha",
      url: "https://example.com/alpha",
      host: "example.com"
    },
    {
      title: "Example Beta",
      url: "https://example.com/beta",
      host: "example.com"
    }
  ]);
});

test("WebSearchClient returns parsed DuckDuckGo results", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    async text() {
      return `
        <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">Result One</a>
        <a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo">Result Two</a>
      `;
    }
  });

  try {
    const client = new WebSearchClient({ timeoutMs: 1000, resultLimit: 2 });
    const result = await client.search("nekodesk");

    assert.equal(result.status, "ok");
    assert.equal(result.query, "nekodesk");
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].title, "Result One");
  } finally {
    global.fetch = originalFetch;
  }
});

test("WebSearchClient reports disabled search cleanly", async () => {
  const client = new WebSearchClient({ enabled: false });
  const result = await client.search("nekodesk");

  assert.equal(result.status, "disabled");
  assert.deepEqual(result.results, []);
});
