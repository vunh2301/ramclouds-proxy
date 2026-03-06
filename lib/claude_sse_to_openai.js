function setSSEHeaders(res) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
}

function createChunk(state, delta, finishReason = null) {
  return {
    id: `chatcmpl-${state.messageId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: state.clientModel,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function convertStopReason(reason) {
  switch (reason) {
    case "end_turn": return "stop";
    case "max_tokens": return "length";
    case "tool_use": return "tool_calls";
    case "stop_sequence": return "stop";
    default: return "stop";
  }
}

function claudeEventToOpenAIChunks(evt, state) {
  if (!evt) return null;
  const results = [];

  switch (evt.type) {
    case "message_start": {
      state.messageId = evt.message?.id || `msg_${Date.now()}`;
      state.providerModel = evt.message?.model || state.providerModel;
      state.toolCallIndex = 0;
      results.push(createChunk(state, { role: "assistant" }));
      break;
    }

    case "content_block_start": {
      const block = evt.content_block;

      if (block?.type === "server_tool_use") {
        state.serverToolBlockIndex = evt.index;
        break;
      }

      if (block?.type === "thinking") {
        state.inThinkingBlock = true;
        state.currentThinkingIndex = evt.index;
        results.push(createChunk(state, { content: "" }));
        break;
      }

      if (block?.type === "tool_use") {
        const toolCallIndex = state.toolCallIndex++;
        const toolName = state.toolNameMap?.get(block.name) || block.name;
        const toolCall = { index: toolCallIndex, id: block.id, type: "function", function: { name: toolName, arguments: "" } };
        state.toolCalls.set(evt.index, toolCall);
        results.push(createChunk(state, { tool_calls: [toolCall] }));
        break;
      }

      break;
    }

    case "content_block_delta": {
      if (evt.index === state.serverToolBlockIndex) break;

      const d = evt.delta;

      if (d?.type === "text_delta" && d.text) {
        results.push(createChunk(state, { content: d.text }));
      } else if (d?.type === "thinking_delta" && d.thinking) {
        results.push(createChunk(state, { reasoning_content: d.thinking }));
      } else if (d?.type === "input_json_delta" && d.partial_json) {
        const toolCall = state.toolCalls.get(evt.index);
        if (toolCall) {
          toolCall.function.arguments += d.partial_json;
          results.push(createChunk(state, { tool_calls: [{ index: toolCall.index, id: toolCall.id, function: { arguments: d.partial_json } }] }));
        }
      }
      break;
    }

    case "content_block_stop": {
      if (evt.index === state.serverToolBlockIndex) {
        state.serverToolBlockIndex = -1;
        break;
      }
      if (state.inThinkingBlock && evt.index === state.currentThinkingIndex) {
        results.push(createChunk(state, { reasoning_content: "" }));
        state.inThinkingBlock = false;
      }
      break;
    }

    case "message_delta": {
      if (evt.usage && typeof evt.usage === "object") {
        const inputTokens = typeof evt.usage.input_tokens === "number" ? evt.usage.input_tokens : 0;
        const outputTokens = typeof evt.usage.output_tokens === "number" ? evt.usage.output_tokens : 0;
        const cacheRead = typeof evt.usage.cache_read_input_tokens === "number" ? evt.usage.cache_read_input_tokens : 0;
        const cacheCreate = typeof evt.usage.cache_creation_input_tokens === "number" ? evt.usage.cache_creation_input_tokens : 0;
        // Inflate input_tokens by trimDelta so Cursor sees the real context size
        // (thinking blocks were dropped before sending to provider, add them back here)
        const inflatedInput = inputTokens + (state.trimDelta || 0);
        state.usage = { input_tokens: inflatedInput, output_tokens: outputTokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate };
      }

      if (evt.delta?.stop_reason) {
        state.finishReason = convertStopReason(evt.delta.stop_reason);

        const finalChunk = {
          id: `chatcmpl-${state.messageId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.clientModel,
          choices: [{ index: 0, delta: {}, finish_reason: state.finishReason }],
        };

        if (state.usage) {
          const promptTokens = (state.usage.input_tokens || 0) + (state.usage.cache_read_input_tokens || 0) + (state.usage.cache_creation_input_tokens || 0);
          const completionTokens = state.usage.output_tokens || 0;
          finalChunk.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
          const details = {};
          if ((state.usage.cache_read_input_tokens || 0) > 0) details.cached_tokens = state.usage.cache_read_input_tokens;
          if ((state.usage.cache_creation_input_tokens || 0) > 0) details.cache_creation_tokens = state.usage.cache_creation_input_tokens;
          if (Object.keys(details).length) finalChunk.usage.prompt_tokens_details = details;
        }

        results.push(finalChunk);
        state.finishReasonSent = true;
      }
      break;
    }

    case "message_stop": {
      if (!state.finishReasonSent) {
        const finishReason = state.finishReason || (state.toolCalls.size > 0 ? "tool_calls" : "stop");
        results.push({
          id: `chatcmpl-${state.messageId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: state.clientModel,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        });
        state.finishReasonSent = true;
      }
      break;
    }
  }

  return results.length ? results : null;
}

async function translateClaudeSSEToOpenAI(providerReadable, res, state) {
  setSSEHeaders(res);
  res.flushHeaders && res.flushHeaders();

  const reader = providerReadable.getReader();
  const decoder = new TextDecoder();

  let buffer = "";

  const normalizeDeltaForCursor = (chunk) => {
    try {
      const delta = chunk?.choices?.[0]?.delta;
      if (!delta) return;
      const rc = delta.reasoning_content;
      const c = delta.content;
      if ((c === null || c === undefined || c === "") && typeof rc === "string" && rc.length) {
        delta.content = rc;
      }
      if (delta.reasoning_content != null) delete delta.reasoning_content;
    } catch {}
  };

  const write = (obj) => {
    normalizeDeltaForCursor(obj);
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const done = () => res.write("data: [DONE]\n\n");

  while (true) {
    const { done: rDone, value } = await reader.read();
    if (rDone) break;

    buffer += decoder.decode(value, { stream: true });

    // Handle both LF and CRLF separated SSE frames
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || "";

    for (const part of parts) {
      // Per SSE spec, an event may contain multiple data: lines. Join them with \n.
      const dataLines = part
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).trim());

      if (!dataLines.length) continue;
      const dataStr = dataLines.join("\n").trim();
      if (!dataStr) continue;

      if (dataStr === "[DONE]") {
        done();
        continue;
      }

      let evt;
      try { evt = JSON.parse(dataStr); } catch { continue; }

      const chunks = claudeEventToOpenAIChunks(evt, state);
      if (chunks) for (const c of chunks) write(c);
    }
  }

  done();
  res.end();
}

module.exports = { translateClaudeSSEToOpenAI };