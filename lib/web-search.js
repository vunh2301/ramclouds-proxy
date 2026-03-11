/**
 * Web Search — Multi-backend search integration.
 *
 * Backends (in priority order):
 *   1. Brave Search API  — BRAVE_API_KEY (paid, 2000 free/month with card)
 *   2. Tavily AI Search  — TAVILY_API_KEY (free 1000/month, no card, AI-optimized)
 *   3. Serper.dev         — SERPER_API_KEY (free 2500 queries, Google account only)
 *   4. Google News RSS    — Free, no key, news only
 *   5. DuckDuckGo HTML    — Free, no key, may get rate-limited
 *   6. Bing scrape        — Free, no key, may get captcha
 *   7. DuckDuckGo Lite    — Free, no key, may get blocked
 *   8. SearXNG            — WEB_SEARCH_URL (free, no key, public or self-hosted)
 *
 * Converts OpenAI `web_search_preview` hosted tool → function tool,
 * intercepts model's web_search calls, executes via search API,
 * and injects results back into the conversation.
 */

const BRAVE_API_KEY = (process.env.BRAVE_API_KEY || "").trim();
const TAVILY_API_KEY = (process.env.TAVILY_API_KEY || "").trim();
const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim();
const SEARXNG_URL = (process.env.WEB_SEARCH_URL || "").trim().replace(/\/+$/, "");
const WEB_SEARCH_COUNT = Math.max(1, Math.min(20, parseInt(process.env.WEB_SEARCH_COUNT || "5", 10) || 5));

const WEB_SEARCH_ENABLED = true;

const ACTIVE_BACKEND =
  BRAVE_API_KEY ? "brave" :
  TAVILY_API_KEY ? "tavily" :
  SERPER_API_KEY ? "serper" :
  "bing";

const WEB_SEARCH_FUNCTION_TOOL = {
  type: "function",
  name: "web_search",
  description: "Search the web for current information, news, documentation, or real-time data. Use when the user asks about recent events, needs up-to-date facts, or when your training data may be outdated.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/**
 * Detect and convert `web_search_preview` / `web_search` hosted tools
 * into a function tool the model can call.
 */
function convertWebSearchTools(tools) {
  if (!Array.isArray(tools)) return { tools, hasWebSearch: false };

  let hasWebSearch = false;
  const converted = [];

  for (const t of tools) {
    if (!t || typeof t !== "object") { converted.push(t); continue; }

    const ttype = t.type || "";
    if (ttype === "web_search_preview" || ttype === "web_search" ||
        ttype === "web_search_preview_2025_03_11") {
      hasWebSearch = true;
      continue;
    }

    const fname = t.function?.name || t.name || "";
    if (fname === "web_search" || fname === "web_search_preview") {
      hasWebSearch = true;
      continue;
    }

    converted.push(t);
  }

  if (hasWebSearch && WEB_SEARCH_ENABLED) {
    converted.push(WEB_SEARCH_FUNCTION_TOOL);
  }

  return { tools: converted.length > 0 ? converted : tools, hasWebSearch: hasWebSearch && WEB_SEARCH_ENABLED };
}

// ==================== Search backends ====================

/**
 * Bing Web Search — free, no key, scrape HTML results. Most reliable.
 */
async function searchBing(query, count) {
  const url = "https://www.bing.com/search?q=" + encodeURIComponent(query) + "&count=" + count;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log("[web-search/bing] error:", res.status);
      return null;
    }
    const html = await res.text();

    // Extract <li class="b_algo"> blocks
    const algoRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/g;
    const algos = [...html.matchAll(algoRe)].slice(0, count);
    if (!algos.length) return null;

    return algos.map((m, i) => {
      const block = m[1];
      const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
      if (!linkMatch) return null;

      let title = linkMatch[2].replace(/<[^>]+>/g, "").trim();
      // Bing wraps URLs via bing.com/ck/a - extract real URL from cite element
      const citeMatch = block.match(/<cite[^>]*>([\s\S]*?)<\/cite>/);
      let displayUrl = citeMatch ? citeMatch[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/›/g, "/").trim() : "";
      // Clean up: cite often shows "domain.com › path" format
      if (displayUrl && !displayUrl.startsWith("http")) displayUrl = "https://" + displayUrl;
      // Remove domain prefix from title if Bing appended it
      title = title.replace(/^[\w.-]+\.(?:com|org|net|edu|gov|io)\s*/i, "").trim() || title;
      const url = displayUrl || linkMatch[1];
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]+>/g, "").replace(/&#0183;&#32;/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()
        : "";
      return `[${i + 1}] ${title}\n    ${url}\n    ${snippet || "(no description)"}`;
    }).filter(Boolean).join("\n\n");
  } catch (e) {
    console.log("[web-search/bing] fetch error:", e?.message);
    return null;
  }
}

/**
 * DuckDuckGo Lite — free, no key, scrape HTML results.
 */
async function searchDuckDuckGo(query, count) {
  const url = "https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log("[web-search/ddg] error:", res.status);
      return null;
    }
    const html = await res.text();

    // Extract links: <a href="...uddg=REAL_URL..." class='result-link'>Title</a>
    const linkRe = /href="([^"]+)"[^>]*class='result-link'>([\s\S]*?)<\/a>/g;
    const links = [...html.matchAll(linkRe)].slice(0, count);

    // Extract snippets: <td class='result-snippet'>...</td>
    const snipRe = /class='result-snippet'>([\s\S]*?)<\/td>/g;
    const snippets = [...html.matchAll(snipRe)].slice(0, count);

    if (!links.length) return null;

    return links.map((m, i) => {
      const rawUrl = m[1];
      const title = m[2].replace(/<[^>]+>/g, "").trim();
      const uddg = rawUrl.match(/uddg=([^&]+)/);
      const realUrl = uddg ? decodeURIComponent(uddg[1]) : rawUrl;
      const snippet = snippets[i]
        ? snippets[i][1].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim()
        : "";
      return `[${i + 1}] ${title}\n    ${realUrl}\n    ${snippet || "(no description)"}`;
    }).join("\n\n");
  } catch (e) {
    console.log("[web-search/ddg] fetch error:", e?.message);
    return null;
  }
}

/**
 * Google News RSS — free, no key, returns real news with sources.
 * Most reliable backend: Google doesn't block RSS feeds.
 */
async function searchGoogleNews(query, count) {
  const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(query) + "&hl=en-US&gl=US&ceid=US:en";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log("[web-search/gnews] error:", res.status);
      return null;
    }
    const xml = await res.text();
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    const items = [...xml.matchAll(itemRe)].slice(0, count);
    if (!items.length) return null;

    return items.map((m, i) => {
      const block = m[1];
      const title = ((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "")
        .replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
      const link = ((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "").trim();
      const source = ((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "").trim();
      const pubDate = ((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "").trim();
      return `[${i + 1}] ${title}\n    Source: ${source} — ${pubDate}\n    ${link}`;
    }).join("\n\n");
  } catch (e) {
    console.log("[web-search/gnews] fetch error:", e?.message);
    return null;
  }
}

/**
 * DuckDuckGo HTML — POST to html.duckduckgo.com/html/ (more reliable than Lite).
 */
async function searchDuckDuckGoHTML(query, count) {
  const url = "https://html.duckduckgo.com/html/";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html",
      },
      body: "q=" + encodeURIComponent(query),
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log("[web-search/ddg-html] error:", res.status);
      return null;
    }
    const html = await res.text();

    // Extract result links: <a class="result__a" href="...">Title</a>
    const resultRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const links = [...html.matchAll(resultRe)].slice(0, count);
    if (!links.length) return null;

    // Extract snippets: <a class="result__snippet" ...>...</a>
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const snippets = [...html.matchAll(snipRe)].slice(0, count);

    return links.map((m, i) => {
      const rawUrl = m[1];
      const title = m[2].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").trim();
      const uddg = rawUrl.match(/uddg=([^&]+)/);
      const realUrl = uddg ? decodeURIComponent(uddg[1]) : rawUrl;
      const snippet = snippets[i]
        ? snippets[i][1].replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim()
        : "";
      return `[${i + 1}] ${title}\n    ${realUrl}\n    ${snippet || "(no description)"}`;
    }).join("\n\n");
  } catch (e) {
    console.log("[web-search/ddg-html] fetch error:", e?.message);
    return null;
  }
}

/**
 * SearXNG — free, self-hosted or public instances.
 */
async function searchSearXNG(query, count) {
  if (!SEARXNG_URL) return null;
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=general&language=auto`;
  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "ramclouds-proxy/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log("[web-search/searxng] error:", res.status);
      return null;
    }
    const data = await res.json();
    const results = (data.results || []).slice(0, count);
    if (!results.length) return null;
    return results.map((r, i) =>
      `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.content || "(no description)"}`
    ).join("\n\n");
  } catch (e) {
    console.log("[web-search/searxng] fetch error:", e?.message);
    return null;
  }
}

/**
 * Brave Search API — needs API key.
 */
async function searchBrave(query, count) {
  if (!BRAVE_API_KEY) return null;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&text_decorations=false`;
  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json", "X-Subscription-Token": BRAVE_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log("[web-search/brave] error:", res.status);
      return null;
    }
    const data = await res.json();
    const results = (data.web?.results || []).slice(0, count);
    if (!results.length) return null;
    return results.map((r, i) =>
      `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.description || "(no description)"}`
    ).join("\n\n");
  } catch (e) {
    console.log("[web-search/brave] fetch error:", e?.message);
    return null;
  }
}

/**
 * Serper.dev — free 2500 queries with Google account.
 */
async function searchSerper(query, count) {
  if (!SERPER_API_KEY) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": SERPER_API_KEY },
      body: JSON.stringify({ q: query, num: count }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.log("[web-search/serper] error:", res.status);
      return null;
    }
    const data = await res.json();
    const results = (data.organic || []).slice(0, count);
    if (!results.length) return null;
    return results.map((r, i) =>
      `[${i + 1}] ${r.title}\n    ${r.link}\n    ${r.snippet || "(no description)"}`
    ).join("\n\n");
  } catch (e) {
    console.log("[web-search/serper] fetch error:", e?.message);
    return null;
  }
}

/**
 * Tavily AI Search — designed for AI agents, returns clean extracted content.
 * Free 1000 queries/month, no credit card needed.
 */
async function searchTavily(query, count) {
  if (!TAVILY_API_KEY) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: count,
        include_answer: true,
        search_depth: "basic",
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      console.log("[web-search/tavily] error:", res.status);
      return null;
    }
    const data = await res.json();
    const results = (data.results || []).slice(0, count);
    if (!results.length && !data.answer) return null;

    let output = "";
    if (data.answer) {
      output += `AI Summary: ${data.answer}\n\n`;
    }
    output += results.map((r, i) =>
      `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.content || "(no description)"}`
    ).join("\n\n");
    return output;
  } catch (e) {
    console.log("[web-search/tavily] fetch error:", e?.message);
    return null;
  }
}

// ==================== Main search with fallback ====================

const FALLBACK_CHAINS = {
  brave:      [searchBrave, searchTavily, searchSerper, searchGoogleNews, searchDuckDuckGoHTML, searchBing, searchDuckDuckGo, searchSearXNG],
  tavily:     [searchTavily, searchSerper, searchGoogleNews, searchDuckDuckGoHTML, searchBing, searchDuckDuckGo, searchSearXNG],
  serper:     [searchSerper, searchTavily, searchGoogleNews, searchDuckDuckGoHTML, searchBing, searchDuckDuckGo, searchSearXNG],
  bing:       [searchGoogleNews, searchDuckDuckGoHTML, searchBing, searchDuckDuckGo, searchSearXNG],
  duckduckgo: [searchGoogleNews, searchDuckDuckGoHTML, searchDuckDuckGo, searchBing, searchSearXNG],
  searxng:    [searchSearXNG, searchGoogleNews, searchDuckDuckGoHTML, searchBing, searchDuckDuckGo],
};

/**
 * Search using configured backend with automatic fallback.
 */
async function search(query, count) {
  if (!query) return "[Empty search query]";
  count = count || WEB_SEARCH_COUNT;
  console.log("[web-search] query:", JSON.stringify(query), "backend:", ACTIVE_BACKEND);

  const chain = FALLBACK_CHAINS[ACTIVE_BACKEND] || [searchDuckDuckGo];

  for (const fn of chain) {
    const result = await fn(query, count);
    if (result) return result;
  }

  return "[No search results found]";
}

// ==================== Follow-up builder ====================

function buildWebSearchFollowUp(originalBody, interceptedCall, searchResults) {
  const body = { ...originalBody };

  const callItem = {
    type: "function_call",
    name: "web_search",
    call_id: interceptedCall.id,
    arguments: interceptedCall.function?.arguments || "{}",
  };

  const resultItem = {
    type: "function_call_output",
    call_id: interceptedCall.id,
    output: `Web search results for: "${extractQuery(interceptedCall)}"\n\n${searchResults || "[No results]"}`,
  };

  body.input = [...(Array.isArray(body.input) ? body.input : []), callItem, resultItem];

  if (Array.isArray(body.tools)) {
    body.tools = body.tools.filter(t => {
      const name = t?.name || t?.function?.name || "";
      return name !== "web_search";
    });
    if (body.tools.length === 0) delete body.tools;
  }

  return body;
}

function extractQuery(toolCall) {
  try {
    return JSON.parse(toolCall.function?.arguments || "{}").query || "";
  } catch { return ""; }
}

module.exports = {
  WEB_SEARCH_ENABLED,
  ACTIVE_BACKEND,
  WEB_SEARCH_FUNCTION_TOOL,
  convertWebSearchTools,
  search,
  searchBing,
  searchBrave,
  searchSerper,
  searchTavily,
  searchGoogleNews,
  searchDuckDuckGo,
  searchDuckDuckGoHTML,
  searchSearXNG,
  buildWebSearchFollowUp,
  extractQuery,
};
