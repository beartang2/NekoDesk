const DDG_HTML_SEARCH_URL = "https://html.duckduckgo.com/html/";

export class WebSearchClient {
  constructor(config = {}) {
    this.config = {
      enabled: config.enabled !== false,
      timeoutMs: Number.isFinite(Number(config.timeoutMs)) ? Number(config.timeoutMs) : 8000,
      resultLimit: Number.isFinite(Number(config.resultLimit)) ? Number(config.resultLimit) : 5,
      userAgent: config.userAgent || "NekoDesk/0.1 (+duckduckgo-search)"
    };
  }

  async search(query) {
    const trimmed = String(query || "").trim();
    if (!trimmed) {
      return {
        status: "missing_input",
        query: trimmed,
        results: []
      };
    }

    if (this.config.enabled !== true) {
      return {
        status: "disabled",
        query: trimmed,
        results: []
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(`${DDG_HTML_SEARCH_URL}?q=${encodeURIComponent(trimmed)}`, {
        method: "GET",
        headers: {
          "User-Agent": this.config.userAgent
        },
        signal: controller.signal
      });

      if (!response.ok) {
        return {
          status: "error",
          query: trimmed,
          results: [],
          error: `HTTP ${response.status}`
        };
      }

      const html = await response.text();
      const results = extractSearchResults(html, this.config.resultLimit);

      return {
        status: results.length ? "ok" : "empty",
        query: trimmed,
        results
      };
    } catch (error) {
      return {
        status: "error",
        query: trimmed,
        results: [],
        error: error?.name === "AbortError" ? `timeout after ${this.config.timeoutMs}ms` : error?.message || "unknown error"
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function extractSearchResults(html, resultLimit = 5) {
  const limit = Number.isFinite(Number(resultLimit)) ? Math.max(1, Number(resultLimit)) : 5;
  const anchors = [...String(html || "").matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const results = [];
  const seen = new Set();

  for (const match of anchors) {
    const href = decodeHtmlEntities(match[1] || "");
    const title = collapseWhitespace(stripTags(decodeHtmlEntities(match[2] || "")));
    const url = normalizeDuckDuckGoResultUrl(href);

    if (!url || !title || isDuckDuckGoUrl(url) || seen.has(url)) {
      continue;
    }

    seen.add(url);
    results.push({
      title,
      url,
      host: safeHostname(url)
    });

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function normalizeDuckDuckGoResultUrl(href) {
  if (!href) {
    return null;
  }

  const absolute = href.startsWith("//") ? `https:${href}` : href;
  try {
    const url = new URL(absolute, DDG_HTML_SEARCH_URL);
    const redirected = url.searchParams.get("uddg");
    return redirected ? decodeURIComponent(redirected) : url.toString();
  } catch {
    return null;
  }
}

function isDuckDuckGoUrl(url) {
  try {
    return new URL(url).hostname.includes("duckduckgo.com");
  } catch {
    return true;
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function stripTags(value) {
  return value.replace(/<[^>]+>/g, " ");
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
