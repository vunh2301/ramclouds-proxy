/**
 * Ramclouds Cursor Proxy — Entry Point
 *
 * Thin Express server that routes requests to the appropriate handler:
 *   - Claude models → handlers/claude-handler.js
 *   - OpenAI models → handlers/openai-handler.js
 *
 * To add a new provider:
 *   1. Create lib/handlers/<provider>-handler.js
 *   2. Add detection in lib/router.js (+ env prefix)
 *   3. Add routing case below
 */

require("dotenv").config();
const express = require("express");
const { getConfig } = require("./lib/config");
const { loadModelConfig, resolveModel, loadAnthropicPrefixes, isAnthropicModel, loadAmpPrefixes, isAmpRequest } = require("./lib/router");
const { handleClaude } = require("./lib/handlers/claude-handler");
const { handleOpenAI } = require("./lib/handlers/openai-handler");
const { handleAmp } = require("./lib/handlers/amp-handler");
const { createToolBatchMiddleware } = require("./lib/middleware/tool-batch");
const { createAmpGuard } = require("./lib/middleware/amp-guard");
const { createAmpManagementRouter } = require("./lib/handlers/amp-management-proxy");
const { createAmpCliLoginRouter } = require("./lib/handlers/amp-cli-login-router");
const { createAmpProviderRouter } = require("./lib/handlers/amp-provider-router");
const session = require("./lib/session");

const config = getConfig();
const { modelMap, defaultModel, allModelIds } = loadModelConfig(config);
const anthropicPrefixes = loadAnthropicPrefixes();
const ampPrefixes = loadAmpPrefixes(config);

// ==================== EXPRESS ====================

const app = express();
app.use(express.json({ limit: "25mb" }));

const ampProxyReady = !!(config.AMP_PROXY_ENABLED && config.AMP_ORIGIN);
const ampCliReady = !!config.AMP_CLI_ENABLED;
if (config.AMP_PROXY_ENABLED && !config.AMP_ORIGIN) {
  console.log("[amp/proxy] disabled: AMP_BASE_URL is missing or invalid");
}
if (ampCliReady) {
  app.use("/api/amp-cli", createAmpGuard(config), createAmpCliLoginRouter(config));
}
if (ampProxyReady) {
  app.use("/api", createAmpGuard(config), createAmpManagementRouter(config));
}

// AMP provider routes: /api/provider/:provider/v1/...
const ampProviderRouter = createAmpProviderRouter(config, {
  handleClaude, handleOpenAI, handleAmp,
  resolveModel, modelMap, defaultModel,
  isAnthropicModel, anthropicPrefixes,
  isAmpRequest, ampPrefixes,
  buildAnthropicHeaders, pipeAnthropicStream, collectStreamToResponse, setContentTypeFromUpstream,
});
if (ampProxyReady) {
  app.use("/api/provider", createAmpGuard(config), ampProviderRouter);
} else {
  // Even without management proxy, provider routes should work
  app.use("/api/provider", ampProviderRouter);
}

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Root-level routes AMP CLI expects (proxy to upstream ampcode.com)
if (ampProxyReady) {
  const { pipeAmpUpstream } = require("./lib/handlers/amp-management-proxy");
  const rootAmpPaths = ["/threads", "/auth", "/docs", "/settings"];
  for (const rp of rootAmpPaths) {
    app.all(rp, (req, res) => pipeAmpUpstream(req, res, config, rp));
    app.all(rp + "/*", (req, res) => pipeAmpUpstream(req, res, config, rp + req.params[0]));
  }
  app.get("/threads.rss", (req, res) => pipeAmpUpstream(req, res, config, "/threads.rss"));
  app.get("/news.rss", (req, res) => pipeAmpUpstream(req, res, config, "/news.rss"));
}

app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: allModelIds.map(id => ({ id, object: "model", created: 0, owned_by: "ramclouds" })),
  });
});

app.use((req, _res, next) => {
  if (req.method === "POST") console.log(`[proxy] ${req.method} ${req.path}`);
  next();
});

function readHeader(req, name) {
  const v = req.headers?.[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === "string" ? v : "";
}

function buildAnthropicHeaders(req, config) {
  const authorization = readHeader(req, "authorization");
  const xApiKey = readHeader(req, "x-api-key");
  const anthropicVersion = readHeader(req, "anthropic-version") || "2023-06-01";
  const anthropicBeta = readHeader(req, "anthropic-beta");

  const headers = {
    "Content-Type": "application/json",
    "Accept-Encoding": "identity",
    "anthropic-version": anthropicVersion,
  };

  if (anthropicBeta) headers["anthropic-beta"] = anthropicBeta;
  if (authorization) headers.Authorization = authorization;
  if (xApiKey) headers["x-api-key"] = xApiKey;

  if (!authorization && !xApiKey && config.PROVIDER_API_KEY) {
    headers.Authorization = "Bearer " + config.PROVIDER_API_KEY;
    headers["x-api-key"] = config.PROVIDER_API_KEY;
  }

  return headers;
}

async function pipeReadableToRes(upRes, res, fallbackContentType) {
  if (upRes.status) res.status(upRes.status);
  res.setHeader("Content-Type", upRes.headers.get("content-type") || fallbackContentType);
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  if (!upRes.body) {
    res.end();
    return;
  }

  const reader = upRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

function setContentTypeFromUpstream(upRes, res) {
  const contentType = upRes.headers.get("content-type");
  if (contentType) res.setHeader("Content-Type", contentType);
}

// ==================== ANTHROPIC STREAM HELPERS ====================

/**
 * Parse SSE frames from a ReadableStream. Yields { eventType, data } objects.
 * Fixes upstream issues: duplicate message_start, broken content_block indexes,
 * OpenAI-style tool IDs (call_xxx → toolu_xxx).
 */
async function* parseSSEFrames(upRes) {
  if (!upRes.body) return;
  const reader = upRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  function* drainFrames() {
    // Normalize \r\n to \n
    buf = buf.replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const eventMatch = frame.match(/^event:\s*(.+)/m);
      const dataMatch = frame.match(/^data:\s*(.+)/m);
      if (dataMatch) {
        yield { eventType: eventMatch ? eventMatch[1].trim() : null, raw: dataMatch[1] };
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      yield* drainFrames();
    }
    // Flush remaining buffer (last frame may lack trailing \n\n)
    if (buf.trim()) {
      buf += "\n\n";
      yield* drainFrames();
    }
  } finally {
    reader.releaseLock();
  }
}

/** Fix tool_use IDs: call_xxx → toolu_xxx */
function fixToolId(id) {
  if (typeof id === "string" && id.startsWith("call_")) return "toolu_" + id.slice(5);
  return id;
}

/**
 * Collect SSE stream into an Anthropic Messages response object.
 * Used when client requests stream=false but we always stream from upstream.
 */
async function collectStreamToResponse(upRes) {
  let message = null;
  const content = [];
  const openBlocks = [];    // stack of in-progress blocks
  let lastBlock = null;     // most recently started block
  let seenMessageStart = false;
  let stopReason = null;
  let usage = {};

  for await (const { eventType, raw } of parseSSEFrames(upRes)) {
    let data;
    try { data = JSON.parse(raw); } catch { continue; }

    switch (eventType) {
      case "message_start":
        if (seenMessageStart) break;
        seenMessageStart = true;
        message = data.message || {};
        usage = message.usage || {};
        break;
      case "content_block_start": {
        const block = { ...(data.content_block || {}) };
        if (block.type === "thinking") block.thinking = "";
        if (block.type === "text") block.text = "";
        if (block.type === "tool_use") {
          block.id = fixToolId(block.id);
          block.input = {};
        }
        openBlocks.push(block);
        lastBlock = block;
        break;
      }
      case "content_block_delta": {
        // delta belongs to the most recently started block
        const target = lastBlock;
        if (!target) break;
        const d = data.delta || {};
        if (d.type === "thinking_delta") target.thinking += d.thinking || "";
        if (d.type === "text_delta") target.text += d.text || "";
        if (d.type === "input_json_delta") {
          const partial = d.partial_json || "";
          if (partial && partial !== "{}") {
            target._inputJson = (target._inputJson || "") + partial;
          }
        }
        break;
      }
      case "content_block_stop": {
        // close oldest open block
        const block = openBlocks.shift();
        if (block) {
          if (block._inputJson) {
            try { block.input = JSON.parse(block._inputJson); } catch {}
            delete block._inputJson;
          }
          content.push(block);
        }
        break;
      }
      case "message_delta":
        if (data.delta) stopReason = data.delta.stop_reason;
        if (data.usage) usage = { ...usage, ...data.usage };
        break;
    }
  }
  // Flush any remaining open blocks
  for (const block of openBlocks) {
    if (block._inputJson) {
      try { block.input = JSON.parse(block._inputJson); } catch {}
      delete block._inputJson;
    }
    content.push(block);
  }

  return {
    id: message?.id || "msg_proxy",
    type: "message",
    role: "assistant",
    model: message?.model || "unknown",
    content,
    stop_reason: stopReason || "end_turn",
    stop_sequence: null,
    usage,
  };
}

/**
 * Pipe upstream SSE stream to client with fixes applied.
 */
async function pipeAnthropicStream(upRes, res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  let seenMessageStart = false;
  let nextBlockIndex = 0;       // increments on each content_block_start
  let lastStartedIndex = -1;    // index assigned to last content_block_start
  const openBlocks = [];        // queue of opened block indices (for stops)

  for await (const { eventType, raw } of parseSSEFrames(upRes)) {
    // Skip duplicate message_start
    if (eventType === "message_start") {
      if (seenMessageStart) continue;
      seenMessageStart = true;
    }

    let data;
    try { data = JSON.parse(raw); } catch { data = null; }

    if (data) {
      if (eventType === "content_block_start") {
        data.index = nextBlockIndex;
        lastStartedIndex = nextBlockIndex;
        openBlocks.push(nextBlockIndex);
        nextBlockIndex++;
        if (data.content_block?.id) data.content_block.id = fixToolId(data.content_block.id);
      }
      if (eventType === "content_block_delta") {
        // delta belongs to the most recently started block
        data.index = lastStartedIndex;
      }
      if (eventType === "content_block_stop") {
        if (openBlocks.length > 0) {
          data.index = openBlocks.shift(); // close oldest open block
        } else {
          // extra stop with no matching start — skip it
          continue;
        }
      }
    }

    const fixed = data ? JSON.stringify(data) : raw;
    if (eventType !== "content_block_delta") {
      console.log("[anthropic/stream]", eventType || "?", fixed.slice(0, 150));
    }
    res.write(`event: ${eventType || "message"}\ndata: ${fixed}\n\n`);
  }

  res.end();
}

// ==================== ANTHROPIC NATIVE API (Claude CLI) ====================

app.post("/v1/messages", async (req, res) => {
  const body = req.body || {};
  const clientWantsStream = !!body.stream;
  const resolved = resolveModel(body.model, modelMap, defaultModel);
  if (resolved !== body.model) {
    console.log("[anthropic/messages] model:", body.model, "->", resolved);
    body.model = resolved;
  }

  // Always stream from upstream (non-stream responses from ramclouds are broken)
  body.stream = true;

  const url = config.providerEndpoint("/messages");
  console.log("[anthropic/messages] ->", url, "model=", body.model, "clientStream=", clientWantsStream);
  console.log("[anthropic/messages] max_tokens=", body.max_tokens, "thinking=", !!body.thinking, "tools=", (body.tools || []).length);

  try {
    const upRes = await fetch(url, {
      method: "POST",
      headers: buildAnthropicHeaders(req, config),
      body: JSON.stringify(body),
    });

    console.log("[anthropic/messages] status:", upRes.status);

    if (!upRes.ok) {
      const t = await upRes.text().catch(() => "");
      console.log("[anthropic/messages] ERROR:", t.slice(0, 300));
      if (res.headersSent) return res.end();
      setContentTypeFromUpstream(upRes, res);
      return res.status(upRes.status).send(t || "Error " + upRes.status);
    }

    if (clientWantsStream) {
      try {
        return await pipeAnthropicStream(upRes, res);
      } catch (e) {
        console.log("[anthropic/messages] stream error:", e?.message || e);
        if (res.headersSent) return res.end();
        return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
      }
    }

    // Client wants non-stream: collect SSE into JSON response
    try {
      const assembled = await collectStreamToResponse(upRes);
      console.log("[anthropic/messages] assembled:", assembled.content.length, "blocks, stop:", assembled.stop_reason);
      return res.json(assembled);
    } catch (e) {
      console.log("[anthropic/messages] collect error:", e?.message || e);
      if (res.headersSent) return res.end();
      return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
    }
  } catch (e) {
    console.log("[anthropic/messages] ERROR:", e?.message || e);
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
  }
});

app.post("/v1/messages/count_tokens", async (req, res) => {
  const body = req.body || {};
  const resolved = resolveModel(body.model, modelMap, defaultModel);
  if (resolved !== body.model) {
    console.log("[anthropic/count_tokens] model:", body.model, "->", resolved);
    body.model = resolved;
  }

  const url = config.providerEndpoint("/messages/count_tokens");
  console.log("[anthropic/count_tokens] ->", url, "model=", body.model);

  try {
    const upRes = await fetch(url, {
      method: "POST",
      headers: buildAnthropicHeaders(req, config),
      body: JSON.stringify(body),
    });

    console.log("[anthropic/count_tokens] status:", upRes.status);

    const t = await upRes.text().catch(() => "");
    if (res.headersSent) return res.end();
    setContentTypeFromUpstream(upRes, res);
    return res.status(upRes.status).send(t || (upRes.ok ? "{}" : "Error " + upRes.status));
  } catch (e) {
    console.log("[anthropic/count_tokens] ERROR:", e?.message || e);
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
  }
});

// ==================== RESPONSES API (Codex pass-through) ====================

app.post("/v1/responses", async (req, res) => {
  const openaiBase = String(config.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
  const responsesUrl = openaiBase.endsWith("/v1") ? openaiBase + "/responses" : openaiBase + "/v1/responses";
  const apiKey = config.OPENAI_API_KEY || config.PROVIDER_API_KEY;

  const body = req.body || {};
  const resolved = resolveModel(body.model, modelMap, defaultModel);
  if (resolved !== body.model) {
    console.log("[responses] model:", body.model, "->", resolved);
    body.model = resolved;
  }

  console.log("[responses] ->", responsesUrl, "model=", body.model, "stream=", !!body.stream);

  try {
    const upRes = await fetch(responsesUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
      },
      body: JSON.stringify(body),
    });

    console.log("[responses] status:", upRes.status);

    if (!upRes.ok) {
      const t = await upRes.text().catch(() => "");
      console.log("[responses] ERROR:", t.slice(0, 300));
      if (res.headersSent) return res.end();
      return res.status(upRes.status).send(t || "Error " + upRes.status);
    }

    // Stream: pipe SSE directly (no conversion needed)
    if (body.stream && upRes.body) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      const reader = upRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (e) {
        console.log("[responses] stream error:", e?.message);
      } finally {
        reader.releaseLock();
        res.end();
      }
      return;
    }

    // Non-stream: forward JSON as-is
    const json = await upRes.json();
    return res.json(json);
  } catch (e) {
    console.log("[responses] ERROR:", e?.message || e);
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
  }
});

// ==================== MAIN ROUTE ====================

const toolBatch = createToolBatchMiddleware(config);

app.post("/v1/chat/completions", toolBatch, async (req, res) => {
  if (!config.PROVIDER_ORIGIN) return res.status(500).json({ error: { message: "Missing PROVIDER_BASE_URL" } });
  session.cleanup();

  const incoming = req.body || {};
  const stream = incoming.stream === true;
  const resolved = resolveModel(incoming.model, modelMap, defaultModel);
  if (resolved !== incoming.model) console.log("[proxy] model:", incoming.model, "->", resolved);

  try {
    if (isAnthropicModel(resolved, anthropicPrefixes)) {
      return await handleClaude(req, res, { ...incoming, model: resolved }, stream, config);
    }
    if (config.AMP_ENABLED && isAmpRequest(req, { ...incoming, model: resolved }, ampPrefixes)) {
      return await handleAmp(req, res, { ...incoming, model: resolved }, stream, config);
    }
    // Add new providers here:
    // else if (isGeminiModel(resolved, geminiPrefixes)) {
    //   return await handleGemini(req, res, { ...incoming, model: resolved }, stream, config);
    // }
    else {
      return await handleOpenAI(req, res, { ...incoming, model: resolved }, stream, config);
    }
  } catch (e) {
    console.log("[proxy] ERROR:", e?.message || e, e?.stack?.split("\n").slice(0, 3).join(" "));
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
  }
});

// ==================== AMP MODEL MAP DISPLAY ====================

function printAmpModelMap(config) {
  const R = "\x1b[31m", G = "\x1b[32m", B = "\x1b[34m", Y = "\x1b[33m", M = "\x1b[35m", C = "\x1b[36m";
  const DIM = "\x1b[2m", BOLD = "\x1b[1m", X = "\x1b[0m";

  function colorModel(m) {
    if (m.startsWith("claude-") || m.startsWith("claude_")) return `${R}${BOLD}${m}${X}`;
    if (m.startsWith("gpt-")) return `${G}${BOLD}${m}${X}`;
    if (m.startsWith("gemini-")) return `${B}${BOLD}${m}${X}`;
    if (m.startsWith("glm-")) return `${Y}${BOLD}${m}${X}`;
    if (m.startsWith("deepseek-")) return `${C}${BOLD}${m}${X}`;
    if (m.startsWith("Qwen-") || m.startsWith("qwen-")) return `${M}${BOLD}${m}${X}`;
    return `${BOLD}${m}${X}`;
  }

  const fallbackMap = config.AMP_FALLBACK_MAP || {};
  const roles = config.AMP_MODEL_ROLES || {};
  const entries = Object.entries(fallbackMap);
  if (!entries.length) return;

  const arrow = ` ${DIM}->${X} `;
  const bullet = `${DIM}●${X}`;

  console.log(`${DIM}┌─────────────────────────────────────────────────────────────┐${X}`);
  console.log(`${DIM}│${X}  ${BOLD}AMP Model Map${X} ${DIM}(${entries.length} agents)${X}${DIM}                                  │${X}`);
  console.log(`${DIM}├─────────────────────────────────────────────────────────────┤${X}`);

  for (const [model, chain] of entries) {
    const role = roles[model] || "";
    const rolePad = role ? `${C}${role.padEnd(10)}${X}` : "          ";
    const chainStr = chain.map(m => `${bullet} ${colorModel(m)}`).join(arrow);
    console.log(`${DIM}│${X}  ${rolePad} ${chainStr}`);
  }

  if (config.AMP_DEFAULT_MODEL) {
    console.log(`${DIM}├─────────────────────────────────────────────────────────────┤${X}`);
    console.log(`${DIM}│${X}  ${BOLD}default${X}     ${bullet} ${colorModel(config.AMP_DEFAULT_MODEL)}`);
  }

  console.log(`${DIM}└─────────────────────────────────────────────────────────────┘${X}`);
}

// ==================== START ====================

app.listen(config.PORT, () => {
  console.log(`[proxy] listening on http://localhost:${config.PORT}`);
  console.log(`[proxy] Anthropic: ${config.PROVIDER_ORIGIN || "(missing)"}${config.PROVIDER_BASEPATH || ""}`);
  console.log(`[proxy] OpenAI: ${config.OPENAI_BASE_URL || config.PROVIDER_ORIGIN || "https://api.openai.com"}`);
  console.log(`[proxy] limits: soft=${config.RAM_SOFT_LIMIT_TOKENS} hard=${config.RAM_HARD_LIMIT_TOKENS}`);
  console.log(`[proxy] batch tool results: ${config.BATCH_TOOL_RESULTS ? "ON (" + config.BATCH_WINDOW_MS + "ms)" : "OFF"}`);
  console.log(`[proxy] merge tool calls: ${config.MERGE_TOOL_CALLS ? "ON (" + config.MERGE_TOOL_NAMES.join(",") + ")" : "OFF"}`);
  console.log(`[proxy] anthropic prefixes:`, anthropicPrefixes);
  console.log(`[proxy] amp prefixes:`, ampPrefixes);
  console.log(`[proxy] AMP management proxy: ${ampProxyReady ? "ON" : "OFF"} (${config.AMP_BASE_URL || "missing AMP_BASE_URL"})`);
  console.log(`[proxy] AMP CLI orchestrator: ${ampCliReady ? "ON" : "OFF"} (timeout=${config.AMP_CLI_LOGIN_TIMEOUT_MS}ms, maxConcurrent=${config.AMP_CLI_MAX_CONCURRENT})`);
  const ampMapKeys = Object.keys(config.AMP_MODEL_MAP || {});
  if (ampMapKeys.length > 0) {
    printAmpModelMap(config);
  } else {
    console.log(`[proxy] AMP model map: (using global MODEL_MAP)`);
  }
  console.log(`[proxy] models:`, allModelIds);
});
