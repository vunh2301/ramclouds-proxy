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
const { loadModelConfig, resolveModel, loadAnthropicPrefixes, isAnthropicModel } = require("./lib/router");
const { handleClaude } = require("./lib/handlers/claude-handler");
const { handleOpenAI } = require("./lib/handlers/openai-handler");
const session = require("./lib/session");

const config = getConfig();
const { modelMap, defaultModel, allModelIds } = loadModelConfig(config);
const anthropicPrefixes = loadAnthropicPrefixes();

// ==================== EXPRESS ====================

const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

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

app.post("/v1/chat/completions", async (req, res) => {
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

// ==================== START ====================

app.listen(config.PORT, () => {
  console.log(`[proxy] listening on http://localhost:${config.PORT}`);
  console.log(`[proxy] Anthropic: ${config.PROVIDER_ORIGIN || "(missing)"}${config.PROVIDER_BASEPATH || ""}`);
  console.log(`[proxy] OpenAI: ${config.OPENAI_BASE_URL || config.PROVIDER_ORIGIN || "https://api.openai.com"}`);
  console.log(`[proxy] limits: soft=${config.RAM_SOFT_LIMIT_TOKENS} hard=${config.RAM_HARD_LIMIT_TOKENS}`);
  console.log(`[proxy] anthropic prefixes:`, anthropicPrefixes);
  console.log(`[proxy] models:`, allModelIds);
});
