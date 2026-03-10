const express = require("express");
const { getAmpSecret, invalidateCache } = require("../amp-cli/secret");
// anthropic_to_openai converter available if provider changes from ramclouds
// const { anthropicBodyToOpenAI, openAIResponseToAnthropic, pipeOpenAIStreamAsAnthropic } = require("../anthropic_to_openai");

/**
 * Creates router for /api/provider/:provider/... routes
 * AMP CLI sends requests like:
 *   POST /api/provider/openai/v1/chat/completions
 *   POST /api/provider/openai/v1/responses
 *   POST /api/provider/anthropic/v1/messages
 *   POST /api/provider/anthropic/v1/messages/count_tokens
 */
function createAmpProviderRouter(config, { handleClaude, handleOpenAI, handleAmp, resolveModel, modelMap, defaultModel, isAnthropicModel, anthropicPrefixes, isAmpRequest, ampPrefixes, buildAnthropicHeaders, pipeAnthropicStream, collectStreamToResponse, setContentTypeFromUpstream }) {
  const router = express.Router();

  // AMP-specific model map with fallback chain
  const ampModelMap = config.AMP_MODEL_MAP || {};
  const ampFallbackMap = config.AMP_FALLBACK_MAP || {};
  const ampRoles = config.AMP_MODEL_ROLES || {};
  const ampDefaultModel = config.AMP_DEFAULT_MODEL || defaultModel;
  const hasAmpMap = Object.keys(ampModelMap).length > 0;

  function resolveAmpModel(model) {
    if (!model) return ampDefaultModel || model;
    // AMP map takes priority
    if (hasAmpMap && ampModelMap[model]) {
      const role = ampRoles[model] || "";
      const primary = ampModelMap[model];
      console.log(`[amp/resolve] ${role ? role + "/" : ""}${model} -> ${primary}`);
      return primary;
    }
    // fallback to global map
    if (modelMap[model]) return modelMap[model];
    return model;
  }

  // Retryable status codes for fallback
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

  // Get fallback chain for a model, with down models pushed to end
  const MODEL_DOWN_TTL_MS = parseInt(process.env.AMP_MODEL_DOWN_TTL_MS, 10) || 120000; // 2 min default
  const PROBE_EVERY_N = parseInt(process.env.AMP_PROBE_EVERY_N, 10) || 10; // probe mỗi N request
  const downModels = new Map(); // model -> { until }
  let requestCount = 0;

  function markModelDown(model) {
    if (downModels.has(model)) return;
    downModels.set(model, { until: Date.now() + MODEL_DOWN_TTL_MS });
    console.log(`[amp/fallback] ${model} marked DOWN for ${MODEL_DOWN_TTL_MS / 1000}s`);
  }

  function markModelUp(model) {
    if (!downModels.has(model)) return;
    downModels.delete(model);
    console.log(`[amp/fallback] ${model} marked UP ✓`);
  }

  function isModelDown(model) {
    const entry = downModels.get(model);
    if (!entry) return false;
    if (Date.now() >= entry.until) {
      downModels.delete(model);
      return false; // TTL hết hạn
    }
    return true;
  }

  // Probe các model DOWN — gọi mỗi N request, không spam timer
  async function probeDownModels() {
    const modelsToProbe = [...downModels.keys()];
    if (modelsToProbe.length === 0) return;

    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (config.PROVIDER_API_KEY) {
      headers.Authorization = "Bearer " + config.PROVIDER_API_KEY;
      headers["x-api-key"] = config.PROVIDER_API_KEY;
    }

    for (const model of modelsToProbe) {
      if (!downModels.has(model)) continue;
      console.log(`[amp/probe] testing ${model}...`);
      try {
        const url = config.providerEndpoint("/messages");
        const upRes = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false }),
        });
        if (upRes.ok || !RETRY_STATUSES.has(upRes.status)) {
          await upRes.text().catch(() => "");
          markModelUp(model);
        } else {
          await upRes.text().catch(() => "");
          console.log(`[amp/probe] ${model} still DOWN (${upRes.status})`);
          // Gia hạn TTL
          const entry = downModels.get(model);
          if (entry) entry.until = Date.now() + MODEL_DOWN_TTL_MS;
        }
      } catch (e) {
        console.log(`[amp/probe] ${model} probe error: ${e?.message}`);
      }
    }
  }

  // Gọi từ mỗi request handler — chỉ probe khi đủ N request
  function maybeProbe() {
    requestCount++;
    if (downModels.size === 0) return;
    if (requestCount % PROBE_EVERY_N !== 0) return;
    // Chạy async, không block request
    probeDownModels().catch(() => {});
  }

  function getFallbackChain(model) {
    const chain = ampFallbackMap[model] || [];
    if (chain.length <= 1) return chain;
    // Reorder: up models first, down models at end
    const up = chain.filter(m => !isModelDown(m));
    const down = chain.filter(m => isModelDown(m));
    return [...up, ...down];
  }

  // Track which models already showed fallback banner (reset when model recovers)
  const shownFallbackBanner = new Map(); // incomingModel -> activeModel last shown

  // Strip AMP CLI's own auth and replace with our provider key on every request.
  router.use((req, _res, next) => {
    const key = config.PROVIDER_API_KEY;
    if (key) {
      req.headers.authorization = "Bearer " + key;
      req.headers["x-api-key"] = key;
    }
    next();
  });

  // ---- OpenAI provider ----
  router.post("/openai/v1/chat/completions", async (req, res) => {
    if (!config.PROVIDER_ORIGIN) return res.status(500).json({ error: { message: "Missing PROVIDER_BASE_URL" } });

    const incoming = req.body || {};
    const stream = incoming.stream === true;
    const resolved = resolveAmpModel(incoming.model);
    if (resolved !== incoming.model) console.log("[amp/provider/openai] model:", incoming.model, "->", resolved);

    try {
      if (isAnthropicModel(resolved, anthropicPrefixes)) {
        return await handleClaude(req, res, { ...incoming, model: resolved }, stream, config);
      }
      if (config.AMP_ENABLED && isAmpRequest(req, { ...incoming, model: resolved }, ampPrefixes)) {
        return await handleAmp(req, res, { ...incoming, model: resolved }, stream, config);
      }
      return await handleOpenAI(req, res, { ...incoming, model: resolved }, stream, config);
    } catch (e) {
      console.log("[amp/provider/openai] ERROR:", e?.message || e);
      if (res.headersSent) return res.end();
      return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
    }
  });

  // ---- Responses API → Messages API conversion ----
  // ramclouds only has /v1/messages, so convert Responses API requests

  function responsesInputToMessages(input) {
    if (typeof input === "string") return { system: null, messages: [{ role: "user", content: input }] };
    if (!Array.isArray(input)) return { system: null, messages: [] };

    let system = null;
    const messages = [];
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      if (item.role === "system") {
        // Anthropic uses top-level system field
        system = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
        continue;
      }
      if (item.role === "user" || item.role === "assistant") {
        messages.push({ role: item.role, content: item.content || "" });
      }
    }
    return { system, messages };
  }

  function responsesToolsToAnthropic(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.filter(t => t && t.type === "function" && t.function).map(t => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
  }

  /** Pipe Anthropic SSE stream back as Responses API SSE events */
  async function pipeMessagesAsResponsesStream(upRes, res, model) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    if (!upRes.body) { res.end(); return; }

    const reader = upRes.body.getReader();
    const decoder = new TextDecoder();
    const responseId = "resp_" + Date.now().toString(36);
    let outputIndex = 0;
    let seenMessageStart = false;

    function writeEvent(evtType, data) {
      res.write(`event: ${evtType}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    function processFrame(frame) {
      const eventMatch = frame.match(/^event:\s*(.+)/m);
      const dataMatch = frame.match(/^data:\s*(.+)/m);
      if (!dataMatch) return;
      const eventType = eventMatch ? eventMatch[1].trim() : null;
      let data;
      try { data = JSON.parse(dataMatch[1]); } catch { return; }

      switch (eventType) {
        case "message_start":
          if (seenMessageStart) return;
          seenMessageStart = true;
          writeEvent("response.created", {
            type: "response.created",
            response: { id: responseId, object: "response", model, status: "in_progress", output: [] },
          });
          break;

        case "content_block_start": {
          const block = data.content_block || {};
          if (block.type === "text") {
            writeEvent("response.output_item.added", {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] },
            });
            writeEvent("response.content_part.added", {
              type: "response.content_part.added",
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", text: "" },
            });
          } else if (block.type === "tool_use") {
            writeEvent("response.output_item.added", {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: { type: "function_call", id: block.id, name: block.name, arguments: "" },
            });
          }
          break;
        }

        case "content_block_delta": {
          const d = data.delta || {};
          if (d.type === "text_delta") {
            writeEvent("response.output_text.delta", {
              type: "response.output_text.delta",
              output_index: outputIndex,
              content_index: 0,
              delta: d.text || "",
            });
          } else if (d.type === "input_json_delta") {
            writeEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              output_index: outputIndex,
              delta: d.partial_json || "",
            });
          }
          break;
        }

        case "content_block_stop":
          writeEvent("response.output_item.done", {
            type: "response.output_item.done",
            output_index: outputIndex,
          });
          outputIndex++;
          break;

        case "message_stop":
          writeEvent("response.completed", {
            type: "response.completed",
            response: { id: responseId, object: "response", model, status: "completed" },
          });
          break;
      }
    }

    try {
      await readStreamWithTimeout(reader, decoder, processFrame);
    } finally {
      res.end();
    }
  }

  // OpenAI responses API → convert to Messages API on ramclouds
  // Now with fallback chain support (same as /anthropic/v1/messages)
  router.post("/openai/v1/responses", async (req, res) => {
    maybeProbe();
    const body = req.body || {};
    const incomingModel = body.model;
    const chain = getFallbackChain(incomingModel);
    const role = ampRoles[incomingModel] || "";
    const startModel = chain.length > 0 ? chain[0] : resolveAmpModel(incomingModel);

    if (startModel !== incomingModel) {
      console.log(`[amp/responses] ${role ? role + ": " : ""}${incomingModel} -> ${startModel}${chain.length > 1 ? " (+" + (chain.length - 1) + " fallbacks)" : ""}`);
    }

    const { system, messages } = responsesInputToMessages(body.input);
    const tools = responsesToolsToAnthropic(body.tools);
    const clientStream = !!body.stream;

    const msgBody = {
      model: startModel,
      messages,
      max_tokens: body.max_output_tokens || body.max_tokens || 8192,
      stream: true, // always stream from upstream
    };
    if (system) msgBody.system = system;
    if (tools.length > 0) msgBody.tools = tools;

    console.log(`[amp/responses] -> ${config.providerEndpoint("/messages")} model=${startModel} stream=${clientStream} msgs=${messages.length}`);

    const headers = buildAnthropicHeaders(req, config);
    const failedModels = [];

    try {
      let result = await tryMessagesAPI(msgBody, headers);

      // Fallback through chain on retryable errors
      if (!result.ok && RETRY_STATUSES.has(result.status) && chain.length > 1) {
        markModelDown(msgBody.model);
        failedModels.push(msgBody.model);
        for (let i = 1; i < chain.length; i++) {
          const fallbackModel = chain[i];
          console.log(`[amp/responses] ${role}: ${result.status} on ${msgBody.model}, trying fallback ${i}/${chain.length - 1}: ${fallbackModel}`);
          msgBody.model = fallbackModel;
          result = await tryMessagesAPI(msgBody, headers);
          if (result.ok) break;
          markModelDown(fallbackModel);
          failedModels.push(fallbackModel);
          if (!RETRY_STATUSES.has(result.status)) break;
        }
      }

      if (result.ok) markModelUp(msgBody.model);

      console.log(`[amp/responses] ${role ? role + ": " : ""}${msgBody.model} status=${result.ok ? 200 : result.status} stream=${clientStream}`);

      if (!result.ok) {
        console.log("[amp/responses] ERROR:", (result.errorText || "").slice(0, 300));
        if (res.headersSent) return res.end();
        return res.status(result.status).send(result.errorText || "Error " + result.status);
      }

      if (clientStream) {
        return await pipeMessagesAsResponsesStream(result.upRes, res, msgBody.model);
      }

      // Non-stream: collect and convert to Responses API format
      const assembled = await collectStreamToResponse(result.upRes);
      const output = assembled.content.map((block, i) => {
        if (block.type === "text") return { type: "message", role: "assistant", content: [{ type: "output_text", text: block.text }] };
        if (block.type === "tool_use") return { type: "function_call", id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) };
        return block;
      });
      return res.json({
        id: "resp_" + Date.now().toString(36),
        object: "response",
        model: assembled.model,
        status: "completed",
        output,
        usage: assembled.usage,
      });
    } catch (e) {
      console.log("[amp/responses] ERROR:", e?.message || e);
      if (res.headersSent) return res.end();
      return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
    }
  });

  // Also support /openai/responses (without /v1)
  router.post("/openai/responses", (req, res, next) => {
    req.url = "/openai/v1/responses";
    router.handle(req, res, next);
  });

  // OpenAI chat completions without /v1
  router.post("/openai/chat/completions", (req, res, next) => {
    req.url = "/openai/v1/chat/completions";
    router.handle(req, res, next);
  });

  // ---- Model banner (emoji + markdown — AMP CLI renders markdown) ----
  // 🟢 **active** model, 🔴 failed, ⚪ standby
  function buildModelBanner(chain, activeModel, failedModels, role) {
    if (!chain || chain.length === 0) return "";
    const failed = new Set(failedModels || []);
    const parts = chain.map(m => {
      if (m === activeModel) return `🟢 **${m}**`;
      if (failed.has(m)) return `🔴 ~~${m}~~`;
      return `⚪ ${m}`;
    });
    const prefix = role ? `\`${role}\` ` : "";
    return `${prefix}${parts.join(" → ")}`;
  }

  /**
   * Pipe upstream Anthropic SSE stream to client, injecting a colored model
   * banner as the first text content block.
   */
  // Stream reader với idle timeout — abort nếu không nhận data trong N giây
  const STREAM_IDLE_MS = parseInt(process.env.AMP_UPSTREAM_TIMEOUT_MS, 10) || 30000;

  async function readStreamWithTimeout(reader, decoder, onChunk) {
    let buf = "";
    let idleTimer;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log(`[amp/stream] idle timeout ${STREAM_IDLE_MS / 1000}s — aborting`);
        reader.cancel().catch(() => {});
      }, STREAM_IDLE_MS);
    };
    resetIdle();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        buf += decoder.decode(value, { stream: true });
        buf = buf.replace(/\r\n/g, "\n");
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          onChunk(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
      clearTimeout(idleTimer);
      if (buf.trim()) {
        buf += "\n\n";
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          onChunk(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
    } finally {
      clearTimeout(idleTimer);
      reader.releaseLock();
    }
  }

  async function pipeAnthropicStreamWithBanner(upRes, res, bannerText) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    if (!upRes.body) { res.end(); return; }

    const reader = upRes.body.getReader();
    const decoder = new TextDecoder();
    let seenMessageStart = false;
    let bannerInjected = false;
    let nextBlockIndex = 0;
    let lastStartedIndex = -1;
    const openBlocks = [];

    function writeSSE(eventType, data) {
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    function injectBanner() {
      if (bannerInjected || !bannerText) return;
      bannerInjected = true;
      const idx = nextBlockIndex++;
      writeSSE("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
      writeSSE("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: bannerText + "\n\n" } });
      writeSSE("content_block_stop", { type: "content_block_stop", index: idx });
    }

    function fixToolId(id) {
      return typeof id === "string" && id.startsWith("call_") ? "toolu_" + id.slice(5) : id;
    }

    function processFrame(frame) {
      const eventMatch = frame.match(/^event:\s*(.+)/m);
      const dataMatch = frame.match(/^data:\s*(.+)/m);
      if (!dataMatch) return;

      const eventType = eventMatch ? eventMatch[1].trim() : null;

      if (eventType === "message_start") {
        if (seenMessageStart) return;
        seenMessageStart = true;
        res.write(`event: message_start\ndata: ${dataMatch[1]}\n\n`);
        injectBanner();
        return;
      }

      let data;
      try { data = JSON.parse(dataMatch[1]); } catch { data = null; }

      if (data) {
        if (eventType === "content_block_start") {
          data.index = nextBlockIndex;
          lastStartedIndex = nextBlockIndex;
          openBlocks.push(nextBlockIndex);
          nextBlockIndex++;
          if (data.content_block?.id) data.content_block.id = fixToolId(data.content_block.id);
        }
        if (eventType === "content_block_delta") {
          data.index = lastStartedIndex;
        }
        if (eventType === "content_block_stop") {
          if (openBlocks.length > 0) {
            data.index = openBlocks.shift();
          } else {
            return; // extra stop, skip
          }
        }
      }

      const fixed = data ? JSON.stringify(data) : dataMatch[1];
      res.write(`event: ${eventType || "message"}\ndata: ${fixed}\n\n`);
    }

    try {
      await readStreamWithTimeout(reader, decoder, processFrame);
    } finally {
      res.end();
    }
  }

  // Core: send to Messages API, return { ok, upRes, errorText, status }
  // Connect timeout: chờ upstream bắt đầu trả response (Oracle cần thinking time lâu)
  const UPSTREAM_TIMEOUT_MS = parseInt(process.env.AMP_UPSTREAM_TIMEOUT_MS, 10) || 120000; // 120s mặc định

  async function tryMessagesAPI(body, headers) {
    const url = config.providerEndpoint("/messages");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    // Không nhận response nén — tránh ZlibError khi pipe SSE stream
    const safeHeaders = { ...headers, "Accept-Encoding": "identity" };
    try {
      const upRes = await fetch(url, {
        method: "POST",
        headers: safeHeaders,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!upRes.ok) {
        const t = await upRes.text().catch(() => "");
        return { ok: false, status: upRes.status, errorText: t, upRes };
      }
      return { ok: true, upRes };
    } catch (e) {
      clearTimeout(timer);
      if (e?.name === "AbortError") {
        console.log(`[amp/anthropic] ${body.model} timeout after ${UPSTREAM_TIMEOUT_MS / 1000}s`);
        return { ok: false, status: 504, errorText: "upstream timeout", upRes: null };
      }
      throw e;
    }
  }

  // ---- Anthropic provider ----
  router.post("/anthropic/v1/messages", async (req, res) => {
    maybeProbe();
    const body = req.body || {};
    const clientWantsStream = !!body.stream;
    const incomingModel = body.model;
    const chain = getFallbackChain(incomingModel); // down models already pushed to end
    const role = ampRoles[incomingModel] || "";
    // Use first model in reordered chain (skips known-down models)
    const startModel = chain.length > 0 ? chain[0] : resolveAmpModel(incomingModel);

    if (startModel !== incomingModel) {
      console.log(`[amp/anthropic] ${role ? role + ": " : ""}${incomingModel} -> ${startModel}${chain.length > 1 ? " (+" + (chain.length - 1) + " fallbacks)" : ""}`);
    }

    body.stream = true; // always stream from upstream
    body.model = startModel;

    const headers = buildAnthropicHeaders(req, config);

    const failedModels = [];

    try {
      // Try first model in chain (already reordered, down models at end)
      let result = await tryMessagesAPI(body, headers);

      // Fallback through remaining chain
      if (!result.ok && RETRY_STATUSES.has(result.status) && chain.length > 1) {
        markModelDown(body.model);
        failedModels.push(body.model);
        for (let i = 1; i < chain.length; i++) {
          const fallbackModel = chain[i];
          console.log(`[amp/anthropic] ${role}: ${result.status} on ${body.model}, trying fallback ${i}/${chain.length - 1}: ${fallbackModel}`);
          body.model = fallbackModel;
          result = await tryMessagesAPI(body, headers);
          if (result.ok) break;
          markModelDown(fallbackModel);
          failedModels.push(fallbackModel);
          if (!RETRY_STATUSES.has(result.status)) break;
        }
      }

      // Mark successful model as up (clears down status if it was set)
      if (result.ok) markModelUp(body.model);

      console.log(`[amp/anthropic] ${role ? role + ": " : ""}${body.model} status=${result.ok ? 200 : result.status} stream=${clientWantsStream}`);

      if (!result.ok) {
        console.log("[amp/anthropic] ERROR:", (result.errorText || "").slice(0, 300));
        if (res.headersSent) return res.end();
        if (result.upRes) setContentTypeFromUpstream(result.upRes, res);
        return res.status(result.status).send(result.errorText || "Error " + result.status);
      }

      // Show banner only once when fallback changes; clear when primary recovers
      let banner = "";
      if (failedModels.length > 0) {
        const lastShown = shownFallbackBanner.get(incomingModel);
        if (lastShown !== body.model) {
          banner = buildModelBanner(chain.length > 0 ? chain : [body.model], body.model, failedModels, role);
          shownFallbackBanner.set(incomingModel, body.model);
        }
      } else {
        // Primary model OK — reset so banner shows again if it falls back later
        shownFallbackBanner.delete(incomingModel);
      }

      if (clientWantsStream) {
        return await pipeAnthropicStreamWithBanner(result.upRes, res, banner);
      }

      const assembled = await collectStreamToResponse(result.upRes);
      if (banner) {
        assembled.content.unshift({ type: "text", text: banner + "\n\n" });
      }
      console.log(`[amp/anthropic] assembled: ${assembled.content.length} blocks`);
      return res.json(assembled);
    } catch (e) {
      console.log("[amp/anthropic] ERROR:", e?.message || e);
      if (res.headersSent) return res.end();
      return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
    }
  });


  router.post("/anthropic/v1/messages/count_tokens", async (req, res) => {
    const body = req.body || {};
    const resolved = resolveAmpModel(body.model);
    if (resolved !== body.model) body.model = resolved;

    const url = config.providerEndpoint("/messages/count_tokens");

    try {
      const upRes = await fetch(url, {
        method: "POST",
        headers: buildAnthropicHeaders(req, config),
        body: JSON.stringify(body),
      });

      const t = await upRes.text().catch(() => "");
      if (res.headersSent) return res.end();
      setContentTypeFromUpstream(upRes, res);
      return res.status(upRes.status).send(t || (upRes.ok ? "{}" : "Error " + upRes.status));
    } catch (e) {
      console.log("[amp/provider/anthropic/count_tokens] ERROR:", e?.message || e);
      if (res.headersSent) return res.end();
      return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
    }
  });

  // Anthropic without /v1
  router.post("/anthropic/messages", (req, res, next) => {
    req.url = "/anthropic/v1/messages";
    router.handle(req, res, next);
  });

  // ---- Models listing ----
  router.get("/:provider/v1/models", (req, res) => {
    const allModelIds = [...new Set([...Object.keys(ampModelMap), ...Object.keys(modelMap)])];
    res.json({
      object: "list",
      data: allModelIds.map(id => ({ id, object: "model", created: 0, owned_by: "ramclouds" })),
    });
  });

  router.get("/:provider/models", (req, res) => {
    const allModelIds = [...new Set([...Object.keys(ampModelMap), ...Object.keys(modelMap)])];
    res.json({
      object: "list",
      data: allModelIds.map(id => ({ id, object: "model", created: 0, owned_by: "ramclouds" })),
    });
  });

  return router;
}

module.exports = { createAmpProviderRouter };
