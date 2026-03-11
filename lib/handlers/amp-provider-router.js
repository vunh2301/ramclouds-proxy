const express = require("express");
const { getAmpSecret, invalidateCache } = require("../amp-cli/secret");
const { WEB_SEARCH_ENABLED, convertWebSearchTools, search: webSearch, buildWebSearchFollowUp, extractQuery } = require("../web-search");
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
        system = typeof item.content === "string" ? item.content : JSON.stringify(item.content);
        continue;
      }

      if (item.role === "user") {
        messages.push({ role: "user", content: item.content || "" });
        continue;
      }

      if (item.role === "assistant") {
        messages.push({ role: "assistant", content: item.content || "" });
        continue;
      }

      // Responses API: function_call items → assistant tool_use
      if (item.type === "function_call") {
        let args = item.arguments || "{}";
        if (typeof args === "string") {
          try { args = JSON.parse(args); } catch { args = {}; }
        }
        messages.push({
          role: "assistant",
          content: [{
            type: "tool_use",
            id: item.call_id || item.id || ("toolu_" + Date.now().toString(36)),
            name: item.name || "unknown",
            input: args,
          }],
        });
        continue;
      }

      // Responses API: function_call_output → user tool_result
      if (item.type === "function_call_output") {
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: item.call_id || item.id || "",
            content: typeof item.output === "string" ? item.output : JSON.stringify(item.output || ""),
          }],
        });
        continue;
      }

      // Responses API: message items with content
      if (item.type === "message" && item.role) {
        const textContent = Array.isArray(item.content)
          ? item.content.map(c => c?.text || c?.value || "").join("")
          : (typeof item.content === "string" ? item.content : "");
        if (textContent) {
          messages.push({ role: item.role, content: textContent });
        }
        continue;
      }

      // Fallback: log unknown item types for debugging
      console.log("[amp/responses] unknown input item:", JSON.stringify(item).slice(0, 200));
    }

    // Merge adjacent same-role messages (Anthropic requires alternating roles)
    const merged = [];
    for (const msg of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        // Merge content
        if (typeof last.content === "string" && typeof msg.content === "string") {
          last.content += "\n" + msg.content;
        } else {
          const lastArr = Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }];
          const msgArr = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];
          last.content = [...lastArr, ...msgArr];
        }
      } else {
        merged.push({ ...msg });
      }
    }

    return { system, messages: merged };
  }

  function responsesToolsToAnthropic(tools) {
    if (!Array.isArray(tools)) return [];
    return tools.filter(t => t && (t.type === "function" || t.function)).map(t => {
      const fn = t.function || t;
      return {
        name: fn.name || t.name || "",
        description: fn.description || t.description || "",
        input_schema: fn.parameters || t.input_schema || { type: "object", properties: {} },
      };
    }).filter(t => t.name);
  }

  /** Detect web_search_preview hosted tool in Responses API tools array */
  function detectWebSearchHostedTool(tools) {
    if (!Array.isArray(tools)) return false;
    return tools.some(t => {
      const ttype = t?.type || "";
      return ttype === "web_search_preview" || ttype === "web_search" || ttype === "web_search_preview_2025_03_11";
    });
  }

  const WEB_SEARCH_ANTHROPIC_TOOL = {
    name: "web_search",
    description: "Search the web for current information, news, documentation, or real-time data.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "The search query" } },
      required: ["query"],
    },
  };

  /** Emit a collected Anthropic response as Responses API SSE events */
  function emitCollectedAsResponsesStream(res, assembled, model) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const responseId = "resp_" + Date.now().toString(36);
    function w(type, data) { res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }

    w("response.created", { type: "response.created", response: { id: responseId, object: "response", model, status: "in_progress", output: [] } });

    const outputItems = [];
    let idx = 0;

    for (const block of (assembled.content || [])) {
      if (block.type === "thinking" || block.type === "redacted_thinking") continue;

      if (block.type === "text") {
        const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: block.text || "" }] };
        w("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] } });
        w("response.content_part.added", { type: "response.content_part.added", output_index: idx, content_index: 0, part: { type: "output_text", text: "" } });
        w("response.output_text.delta", { type: "response.output_text.delta", output_index: idx, content_index: 0, delta: block.text || "" });
        w("response.output_text.done", { type: "response.output_text.done", output_index: idx, content_index: 0, text: block.text || "" });
        w("response.content_part.done", { type: "response.content_part.done", output_index: idx, content_index: 0, part: { type: "output_text", text: block.text || "" } });
        w("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
        outputItems.push(item);
        idx++;
      } else if (block.type === "tool_use") {
        const args = JSON.stringify(block.input || {});
        const item = { type: "function_call", id: block.id, name: block.name, call_id: block.id, arguments: args };
        w("response.output_item.added", { type: "response.output_item.added", output_index: idx, item: { type: "function_call", id: block.id, name: block.name, arguments: "" } });
        w("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: idx, delta: args });
        w("response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: idx, arguments: args });
        w("response.output_item.done", { type: "response.output_item.done", output_index: idx, item });
        outputItems.push(item);
        idx++;
      }
    }

    w("response.completed", { type: "response.completed", response: { id: responseId, object: "response", model, status: "completed", output: outputItems } });
    res.end();
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

    // Track current block state for emitting proper "done" events
    let currentBlockType = null; // "text" | "tool_use"
    let currentBlockId = "";
    let currentBlockName = "";
    let accumulatedText = "";
    let accumulatedArgs = "";
    const outputItems = [];

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
          currentBlockType = block.type;
          accumulatedText = "";
          accumulatedArgs = "";
          // Skip thinking blocks — Anthropic extended thinking, not part of Responses API
          if (block.type === "thinking" || block.type === "redacted_thinking") {
            break;
          }
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
            currentBlockId = block.id || ("call_" + Date.now().toString(36));
            currentBlockName = block.name || "";
            writeEvent("response.output_item.added", {
              type: "response.output_item.added",
              output_index: outputIndex,
              item: { type: "function_call", id: currentBlockId, name: currentBlockName, arguments: "" },
            });
          }
          break;
        }

        case "content_block_delta": {
          const d = data.delta || {};
          if (d.type === "text_delta") {
            accumulatedText += d.text || "";
            writeEvent("response.output_text.delta", {
              type: "response.output_text.delta",
              output_index: outputIndex,
              content_index: 0,
              delta: d.text || "",
            });
          } else if (d.type === "input_json_delta") {
            accumulatedArgs += d.partial_json || "";
            writeEvent("response.function_call_arguments.delta", {
              type: "response.function_call_arguments.delta",
              output_index: outputIndex,
              delta: d.partial_json || "",
            });
          }
          break;
        }

        case "content_block_stop": {
          // Skip thinking blocks entirely
          if (currentBlockType === "thinking" || currentBlockType === "redacted_thinking") {
            currentBlockType = null;
            break;
          }
          if (currentBlockType === "text") {
            // Emit output_text.done and content_part.done before output_item.done
            writeEvent("response.output_text.done", {
              type: "response.output_text.done",
              output_index: outputIndex,
              content_index: 0,
              text: accumulatedText,
            });
            writeEvent("response.content_part.done", {
              type: "response.content_part.done",
              output_index: outputIndex,
              content_index: 0,
              part: { type: "output_text", text: accumulatedText },
            });
            const doneItem = { type: "message", role: "assistant", content: [{ type: "output_text", text: accumulatedText }] };
            outputItems.push(doneItem);
            writeEvent("response.output_item.done", {
              type: "response.output_item.done",
              output_index: outputIndex,
              item: doneItem,
            });
          } else if (currentBlockType === "tool_use") {
            // Emit function_call_arguments.done before output_item.done
            writeEvent("response.function_call_arguments.done", {
              type: "response.function_call_arguments.done",
              output_index: outputIndex,
              arguments: accumulatedArgs,
            });
            const doneItem = { type: "function_call", id: currentBlockId, name: currentBlockName, arguments: accumulatedArgs };
            outputItems.push(doneItem);
            writeEvent("response.output_item.done", {
              type: "response.output_item.done",
              output_index: outputIndex,
              item: doneItem,
            });
          } else {
            // Unknown block type — skip, don't emit broken events
            currentBlockType = null;
            break;
          }
          outputIndex++;
          currentBlockType = null;
          break;
        }

        case "message_stop":
          writeEvent("response.completed", {
            type: "response.completed",
            response: { id: responseId, object: "response", model, status: "completed", output: outputItems },
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
  // Now with fallback chain support + web_search interception
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

    // Debug: log ALL tool types AMP sends
    const rawTools = body.tools || [];
    const toolDebug = rawTools.map(t => `${t?.type||"?"}:${t?.function?.name||t?.name||"?"}`).join(", ");
    console.log(`[amp/responses] raw tools (${rawTools.length}): [${toolDebug}]`);

    // Detect web_search_preview hosted tool
    const hasWebSearch = WEB_SEARCH_ENABLED && detectWebSearchHostedTool(body.tools);

    // Debug: log input structure
    const inputItems = Array.isArray(body.input) ? body.input : [];
    const inputTypes = inputItems.map(i => i?.type || i?.role || "?").join(",");
    console.log(`[amp/responses] input: ${inputItems.length} items [${inputTypes}] tools=${(body.tools || []).length} webSearch=${hasWebSearch}`);

    const { system, messages } = responsesInputToMessages(body.input);
    const tools = responsesToolsToAnthropic(body.tools);

    // Add web_search as Anthropic tool if detected
    if (hasWebSearch) {
      tools.push(WEB_SEARCH_ANTHROPIC_TOOL);
      console.log("[amp/responses] web_search_preview -> added web_search Anthropic tool");
    }

    const clientStream = !!body.stream;

    const msgBody = {
      model: startModel,
      messages,
      max_tokens: body.max_output_tokens || body.max_tokens || 8192,
      stream: true, // always stream from upstream
    };
    if (system) msgBody.system = system;
    if (tools.length > 0) msgBody.tools = tools;

    // Debug: log converted message structure
    const msgRoles = messages.map(m => m.role).join(",");
    console.log(`[amp/responses] -> ${config.providerEndpoint("/messages")} model=${startModel} stream=${clientStream} msgs=${messages.length} [${msgRoles}] sys=${!!system} tools=${tools.length}`);

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

      // ---- Web search interception: collect first, check for web_search tool_use ----
      if (hasWebSearch) {
        const assembled = await collectStreamToResponse(result.upRes);
        const wsBlocks = assembled.content.filter(b => b.type === "tool_use" && b.name === "web_search");

        if (wsBlocks.length > 0) {
          // Model wants to search — execute search for first query, provide results for all blocks
          const query = wsBlocks[0].input?.query || "";
          console.log("[amp/responses] web_search intercepted:", wsBlocks.length, "calls, query:", JSON.stringify(query));

          const searchResults = await webSearch(query);
          console.log("[amp/responses] search results:", (searchResults || "").length, "chars");

          // Build follow-up: original messages + assistant content (no thinking) + tool results for ALL web_search blocks
          const assistantContent = assembled.content.filter(b =>
            b.type !== "thinking" && b.type !== "redacted_thinking"
          );

          // Build tool_result for every web_search tool_use block
          const toolResults = wsBlocks.map((ws, i) => ({
            type: "tool_result",
            tool_use_id: ws.id,
            content: i === 0
              ? (searchResults || "[No results]")
              : "[Duplicate search — see results above]",
          }));

          const followUpMessages = [
            ...messages,
            { role: "assistant", content: assistantContent },
            { role: "user", content: toolResults },
          ];

          const followUpTools = tools.filter(t => t.name !== "web_search");
          const followUpBody = {
            ...msgBody,
            messages: followUpMessages,
          };
          // Add system instruction to use the search results
          const searchInstruction = "\n\nYou just performed a web search and received real results. Use these search results to provide a factual, specific answer. Reference the sources. Do NOT say you cannot search or that search is unavailable — the results are already provided to you.";
          followUpBody.system = (followUpBody.system || "") + searchInstruction;
          if (followUpTools.length > 0) followUpBody.tools = followUpTools;
          else delete followUpBody.tools;

          console.log("[amp/responses] follow-up: assistant blocks:", assistantContent.length, "tool_results:", toolResults.length);
          console.log("[amp/responses] -> follow-up with search results, msgs=", followUpMessages.length);
          const followUpResult = await tryMessagesAPI(followUpBody, headers);

          if (followUpResult.ok) {
            if (clientStream) {
              return await pipeMessagesAsResponsesStream(followUpResult.upRes, res, msgBody.model);
            }
            const followAssembled = await collectStreamToResponse(followUpResult.upRes);
            const output = followAssembled.content.map(block => {
              if (block.type === "text") return { type: "message", role: "assistant", content: [{ type: "output_text", text: block.text }] };
              if (block.type === "tool_use") return { type: "function_call", id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) };
              return block;
            });
            return res.json({ id: "resp_" + Date.now().toString(36), object: "response", model: followAssembled.model, status: "completed", output, usage: followAssembled.usage });
          } else {
            console.log("[amp/responses] follow-up ERROR:", followUpResult.status, (followUpResult.errorText || "").slice(0, 200));
            // Fall through: emit original (without search results)
          }
        }

        // No web_search called (or follow-up failed) — emit collected response
        if (clientStream) {
          return emitCollectedAsResponsesStream(res, assembled, msgBody.model);
        }
        const output = assembled.content.filter(b => b.type !== "thinking" && b.type !== "redacted_thinking").map(block => {
          if (block.type === "text") return { type: "message", role: "assistant", content: [{ type: "output_text", text: block.text }] };
          if (block.type === "tool_use") return { type: "function_call", id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) };
          return block;
        });
        return res.json({ id: "resp_" + Date.now().toString(36), object: "response", model: assembled.model, status: "completed", output, usage: assembled.usage });
      }

      // ---- Normal path (no web search) ----
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
  const STREAM_IDLE_MS = parseInt(process.env.AMP_STREAM_IDLE_MS, 10) || 120000;

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

    // --- Web search detection (Anthropic format) ---
    const hasWebSearch = WEB_SEARCH_ENABLED && Array.isArray(body.tools) && body.tools.some(t => {
      const ttype = t?.type || "";
      const tname = t?.name || "";
      return ttype === "web_search_20250305" || ttype === "web_search" ||
             tname === "web_search" || tname === "web_search_preview" ||
             ttype === "web_search_preview" || ttype === "web_search_preview_2025_03_11";
    });
    if (hasWebSearch) {
      // Remove Anthropic-native web_search tool types, add our function tool
      body.tools = body.tools.filter(t => {
        const ttype = t?.type || "";
        const tname = t?.name || "";
        return ttype !== "web_search_20250305" && ttype !== "web_search" &&
               ttype !== "web_search_preview" && ttype !== "web_search_preview_2025_03_11" &&
               tname !== "web_search" && tname !== "web_search_preview";
      });
      body.tools.push(WEB_SEARCH_ANTHROPIC_TOOL);
      console.log("[amp/anthropic] web_search detected -> replaced with function tool");
    }

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

      // --- Web search interception (Anthropic format) ---
      if (hasWebSearch) {
        const assembled = await collectStreamToResponse(result.upRes);
        const wsBlocks = (assembled.content || []).filter(b => b.type === "tool_use" && b.name === "web_search");

        if (wsBlocks.length > 0) {
          console.log("[amp/anthropic] web_search intercepted:", wsBlocks.length, "calls");

          // Execute search for each tool_use block
          const toolResults = [];
          for (const ws of wsBlocks) {
            let query = "";
            try { query = (typeof ws.input === "string" ? JSON.parse(ws.input) : ws.input)?.query || ""; } catch {}
            console.log("[amp/anthropic] web_search query:", JSON.stringify(query));
            const searchResult = await webSearch(query, 8);
            toolResults.push({
              type: "tool_result",
              tool_use_id: ws.id,
              content: `Web search results for: "${query}"\n\n${searchResult || "[No results]"}`,
            });
          }

          // Build follow-up: original messages + assistant content (no thinking) + tool results
          const assistantContent = (assembled.content || []).filter(b =>
            b.type !== "thinking" && b.type !== "redacted_thinking"
          );

          const followUpBody = { ...body };
          followUpBody.messages = [
            ...(Array.isArray(body.messages) ? body.messages : []),
            { role: "assistant", content: assistantContent },
            { role: "user", content: toolResults },
          ];
          // Remove web_search tool from follow-up
          followUpBody.tools = (body.tools || []).filter(t => t.name !== "web_search");
          if (followUpBody.tools.length === 0) delete followUpBody.tools;

          // Add system instruction to use search results
          const wsSystemMsg = "You just performed web searches and received real, up-to-date results above. IMPORTANT: Use ALL the search results to write a comprehensive, detailed answer. Include specific facts, dates, names, and quote sources with URLs. Cover every relevant result. Do NOT say you cannot search or that results are unavailable — the results are real and current. Write as much detail as the results provide.";
          if (typeof followUpBody.system === "string") {
            followUpBody.system += "\n\n" + wsSystemMsg;
          } else if (Array.isArray(followUpBody.system)) {
            followUpBody.system = [...followUpBody.system, { type: "text", text: wsSystemMsg }];
          } else {
            followUpBody.system = wsSystemMsg;
          }

          followUpBody.stream = true;
          console.log("[amp/anthropic] sending follow-up with search results");

          try {
            const followUp = await tryMessagesAPI(followUpBody, headers);
            if (followUp.ok) {
              if (clientWantsStream) {
                return await pipeAnthropicStreamWithBanner(followUp.upRes, res, banner);
              }
              const followAssembled = await collectStreamToResponse(followUp.upRes);
              if (banner) followAssembled.content.unshift({ type: "text", text: banner + "\n\n" });
              return res.json(followAssembled);
            }
            console.log("[amp/anthropic] follow-up failed:", followUp.status, "- emitting collected response");
          } catch (fe) {
            console.log("[amp/anthropic] follow-up error:", fe?.message, "- emitting collected response");
          }
        }

        // No web_search called or follow-up failed — emit collected response
        if (banner) assembled.content.unshift({ type: "text", text: banner + "\n\n" });
        if (clientWantsStream) {
          // Re-emit as SSE stream
          res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader("Connection", "keep-alive");
          const responseId = "msg_" + Date.now().toString(36);
          res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: responseId, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null } })}\n\n`);
          for (let ci = 0; ci < assembled.content.length; ci++) {
            const block = assembled.content[ci];
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: ci, content_block: block.type === "text" ? { type: "text", text: "" } : block })}\n\n`);
            if (block.type === "text" && block.text) {
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: ci, delta: { type: "text_delta", text: block.text } })}\n\n`);
            }
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: ci })}\n\n`);
          }
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: assembled.stop_reason || "end_turn" } })}\n\n`);
          res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
          return res.end();
        }
        console.log(`[amp/anthropic] assembled: ${assembled.content.length} blocks`);
        return res.json(assembled);
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
