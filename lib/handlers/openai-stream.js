/**
 * OpenAI Stream Handler — Responses API SSE → Chat Completions SSE.
 * Includes: ApplyPatch buffer+unwrap, web_search interception, id in every delta, hasOwnProperty fix, args.done backfill.
 */

const { unwrapToolArguments } = require("../tool-enricher");

/**
 * @param {Response} upstreamRes - fetch Response from upstream
 * @param {ServerResponse} res - Express response to client
 * @param {object} opts
 * @param {string} opts.chatId
 * @param {string} opts.model
 * @param {Set<string>} [opts.interceptToolNames] - tool names to intercept (buffer, don't emit to client)
 * @param {boolean} [opts.skipHeader] - skip setting SSE headers (for follow-up streams)
 * @param {boolean} [opts.skipRoleEmit] - skip emitting role:assistant (for follow-up streams)
 * @param {boolean} [opts.autoFinish=true] - emit finish+DONE+end when stream ends
 */
async function streamResponsesAPIToChat(upstreamRes, res, opts) {
  const { chatId, model, interceptToolNames, skipHeader, skipRoleEmit, autoFinish = true } = opts;

  if (!skipHeader) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
  }

  const assistantToolCalls = [];
  const interceptedCalls = [];
  let assistantText = "";
  let currentIdx = -1;
  const pending = {}; // fcItemId|callId → index
  const interceptedIndexes = new Set(); // indexes of intercepted tool calls

  function emit(delta, finish = null) {
    const chunk = { id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] };
    res.write("data: " + JSON.stringify(chunk) + "\n\n");
  }

  if (!skipRoleEmit) {
    emit({ role: "assistant", content: "" });
  }

  const decoder = new TextDecoder();
  const reader = upstreamRes.body.getReader();
  let buf = "";

  function isIntercepted(idx) {
    return interceptedIndexes.has(idx);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() || "";

      for (const line of parts) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }
        const t = evt.type || "";

        // Text delta
        if (t === "response.output_text.delta" || t === "response.text.delta") {
          assistantText += (evt.delta || "");
          emit({ content: evt.delta || "" });
          continue;
        }

        // Function call start (output_item.added)
        if (t === "response.output_item.added") {
          const item = evt.item || evt;
          if (item.type === "function_call") {
            const fcId = item.id || "";
            const callId = item.call_id || "";
            const name = item.name || "";
            if (fcId && !pending.hasOwnProperty(fcId)) {
              currentIdx++;
              pending[fcId] = currentIdx;
              if (callId) pending[callId] = currentIdx;
              const id = callId || fcId;
              assistantToolCalls[currentIdx] = { id, type: "function", function: { name, arguments: "" } };

              // Check if this tool should be intercepted
              if (interceptToolNames && interceptToolNames.has(name)) {
                interceptedIndexes.add(currentIdx);
                console.log("[stream] FC intercepted:", name, "id=", id, "idx=", currentIdx);
              } else {
                emit({ tool_calls: [{ index: currentIdx, id, type: "function", function: { name, arguments: "" } }] });
                console.log("[stream] FC start:", name, "id=", id, "idx=", currentIdx);
              }
            }
          }
          continue;
        }

        // Arguments delta
        if (t === "response.function_call_arguments.delta") {
          const itemId = evt.item_id || "";
          const callId = evt.call_id || "";
          let idx;
          if (itemId && pending.hasOwnProperty(itemId)) idx = pending[itemId];
          else if (callId && pending.hasOwnProperty(callId)) idx = pending[callId];
          else {
            currentIdx++;
            idx = currentIdx;
            if (itemId) pending[itemId] = idx;
            if (callId) pending[callId] = idx;
            assistantToolCalls[idx] = { id: callId || itemId, type: "function", function: { name: "", arguments: "" } };
            if (!isIntercepted(idx)) {
              emit({ tool_calls: [{ index: idx, id: callId || itemId, type: "function", function: { name: "", arguments: "" } }] });
            }
          }
          const args = evt.delta || "";
          if (assistantToolCalls[idx]) assistantToolCalls[idx].function.arguments += args;

          // Don't emit for intercepted tools or ApplyPatch
          if (!isIntercepted(idx) && assistantToolCalls[idx]?.function?.name !== "ApplyPatch") {
            emit({ tool_calls: [{ index: idx, id: assistantToolCalls[idx]?.id || callId, function: { arguments: args } }] });
          }
          continue;
        }

        // Arguments done (authoritative)
        if (t === "response.function_call_arguments.done") {
          const itemId = evt.item_id || "";
          const callId = evt.call_id || "";
          let idx;
          if (itemId && pending.hasOwnProperty(itemId)) idx = pending[itemId];
          else if (callId && pending.hasOwnProperty(callId)) idx = pending[callId];
          else idx = currentIdx >= 0 ? currentIdx : 0;

          if (assistantToolCalls[idx]) {
            if (callId && callId !== assistantToolCalls[idx].id) { pending[callId] = idx; assistantToolCalls[idx].id = callId; }
            if (evt.name) assistantToolCalls[idx].function.name = evt.name;

            if (typeof evt.arguments === "string" && evt.arguments.length > 0) {
              const toolName = assistantToolCalls[idx].function.name;
              const finalArgs = unwrapToolArguments(toolName, evt.arguments);
              const isUnwrapped = finalArgs !== evt.arguments;
              const tcId = assistantToolCalls[idx].id || callId;

              if (!isIntercepted(idx)) {
                if (isUnwrapped) {
                  emit({ tool_calls: [{ index: idx, id: tcId, function: { arguments: finalArgs } }] });
                } else {
                  const accumulated = assistantToolCalls[idx].function.arguments || "";
                  if (finalArgs.length > accumulated.length) {
                    emit({ tool_calls: [{ index: idx, id: tcId, function: { arguments: finalArgs.slice(accumulated.length) } }] });
                  }
                }
              }
              assistantToolCalls[idx].function.arguments = finalArgs;
            }
          }
          continue;
        }

        // output_item.done — backfill name/id/args
        if (t === "response.output_item.done") {
          const item = evt.item || {};
          if (item.type === "function_call") {
            const itemId = item.id || "";
            const callId = item.call_id || "";
            let idx;
            if (itemId && pending.hasOwnProperty(itemId)) idx = pending[itemId];
            else if (callId && pending.hasOwnProperty(callId)) idx = pending[callId];
            else idx = currentIdx >= 0 ? currentIdx : -1;
            if (idx >= 0 && assistantToolCalls[idx]) {
              if (item.call_id) { assistantToolCalls[idx].id = item.call_id; pending[item.call_id] = idx; }
              if (item.name) assistantToolCalls[idx].function.name = item.name;
              if (typeof item.arguments === "string" && item.arguments.length > 0) {
                assistantToolCalls[idx].function.arguments = unwrapToolArguments(assistantToolCalls[idx].function.name, item.arguments);
              }
            }
          }
          continue;
        }
      }
    }
  } catch (e) {
    console.log("[stream] error:", e?.message);
  } finally {
    reader.releaseLock();
  }

  // Collect intercepted calls
  for (const idx of interceptedIndexes) {
    if (assistantToolCalls[idx]) {
      interceptedCalls.push(assistantToolCalls[idx]);
    }
  }

  // Only emit finish if autoFinish and no intercepted calls pending
  if (autoFinish && interceptedCalls.length === 0) {
    emit({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  }

  // Normalize empty args + dedup
  const seenIds = new Set();
  const valid = assistantToolCalls.filter(tc => {
    if (!tc) return false;
    if (seenIds.has(tc.id)) return false;
    seenIds.add(tc.id);
    if (tc.function) {
      const stripped = (tc.function.arguments || "").replace(/[\s\r\n\t]/g, "");
      if (stripped === "" || stripped === "{}") tc.function.arguments = "{}";
    }
    return true;
  });

  console.log("[stream] done: text=", assistantText.length, "tools=", valid.length, "intercepted=", interceptedCalls.length);
  return { assistantText, assistantToolCalls: valid, interceptedCalls };
}

/**
 * Emit finish + DONE + end on an existing SSE stream.
 * Used after web_search follow-up or when autoFinish was false.
 */
function emitStreamFinish(res, chatId, model) {
  const chunk = { id: chatId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
  res.write("data: " + JSON.stringify(chunk) + "\n\n");
  res.write("data: [DONE]\n\n");
  res.end();
}

module.exports = { streamResponsesAPIToChat, emitStreamFinish };
