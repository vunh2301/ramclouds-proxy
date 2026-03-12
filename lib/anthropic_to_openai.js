/**
 * Convert Anthropic Messages format → OpenAI Chat Completions format (and back).
 * Used when AMP CLI sends to /api/provider/anthropic but the model resolves to an OpenAI model.
 */

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && (b.type === "text" || b.type === "output_text"))
      .map(b => b.text || "")
      .join("");
  }
  return "";
}

// ---- Body: Anthropic Messages → OpenAI Chat Completions ----

function anthropicBodyToOpenAI(body) {
  const out = {
    model: body.model,
    stream: !!body.stream,
  };

  const messages = [];

  // system
  if (body.system) {
    if (typeof body.system === "string" && body.system.trim()) {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system.map(b => (typeof b === "string" ? b : b?.text || "")).join("\n");
      if (text.trim()) messages.push({ role: "system", content: text });
    }
  }

  // messages
  for (const msg of (body.messages || [])) {
    if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter(b => b.type === "text" || b.type === "output_text")
          .map(b => b.text || "")
          .join("");
        const toolUses = msg.content.filter(b => b.type === "tool_use");

        const openaiMsg = { role: "assistant", content: textParts || null };
        if (toolUses.length > 0) {
          openaiMsg.tool_calls = toolUses.map(tu => ({
            id: tu.id,
            type: "function",
            function: {
              name: tu.name,
              arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input || {}),
            },
          }));
        }
        messages.push(openaiMsg);
      } else {
        messages.push({ role: "assistant", content: flattenContent(msg.content) || null });
      }
    } else if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter(b => b.type === "tool_result");
        const textBlocks = msg.content.filter(b => b.type !== "tool_result" && b.type !== "thinking");

        for (const tr of toolResults) {
          let content = "";
          if (typeof tr.content === "string") content = tr.content;
          else if (Array.isArray(tr.content)) content = tr.content.map(b => b?.text || "").join("");
          messages.push({ role: "tool", tool_call_id: tr.tool_use_id, content });
        }

        if (textBlocks.length > 0) {
          const text = textBlocks.map(b => b?.text || (typeof b === "string" ? b : "")).join("");
          if (text.trim()) messages.push({ role: "user", content: text });
        }
      } else {
        messages.push({ role: "user", content: flattenContent(msg.content) || "" });
      }
    }
  }

  out.messages = messages;

  // GPT-5.x requires max_completion_tokens, not max_tokens
  if (body.max_tokens) out.max_completion_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;

  // tools
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map(t => {
      if (t.type === "function") return t;
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || {},
        },
      };
    });
  }

  // tool_choice
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "none") out.tool_choice = "none";
    else if (tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
    else out.tool_choice = "auto";
  }

  return out;
}

// ---- Non-stream response: OpenAI Chat → Anthropic Messages ----

function openAIResponseToAnthropic(resp, requestModel) {
  const choice = resp.choices?.[0];
  const content = [];

  if (choice?.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name || "",
        input,
      });
    }
  }

  const stopReason = choice?.finish_reason === "tool_calls" ? "tool_use"
    : choice?.finish_reason === "length" ? "max_tokens"
    : "end_turn";

  return {
    id: resp.id || "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    model: requestModel || resp.model || "unknown",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens || 0,
      output_tokens: resp.usage?.completion_tokens || 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

// ---- Streaming: OpenAI Chat SSE → Anthropic Messages SSE ----

async function pipeOpenAIStreamAsAnthropic(upRes, res, requestModel) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const msgId = "msg_" + Date.now();

  // Emit message_start
  const msgStart = {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      model: requestModel,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  };
  res.write(`event: message_start\ndata: ${JSON.stringify(msgStart)}\n\n`);

  let blockIndex = 0;
  let textBlockOpen = false;
  const toolBlocks = new Map(); // tc.index -> { blockIdx, id }
  let usage = {};
  let finishReason = null;

  const reader = upRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() || "";

      for (const part of parts) {
        const dataLines = part.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim());
        const dataStr = dataLines.join("\n").trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        let chunk;
        try { chunk = JSON.parse(dataStr); } catch { continue; }

        const choice = chunk.choices?.[0];
        if (chunk.usage) usage = { ...usage, ...chunk.usage };
        if (!choice) continue;

        const delta = choice.delta || {};
        finishReason = choice.finish_reason || finishReason;

        // Text content
        if (delta.content != null && delta.content !== "") {
          if (!textBlockOpen) {
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start", index: blockIndex,
              content_block: { type: "text", text: "" },
            })}\n\n`);
            textBlockOpen = true;
          }
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta", index: blockIndex,
            delta: { type: "text_delta", text: delta.content },
          })}\n\n`);
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const tcIdx = tc.index ?? 0;

            if (tc.id && !toolBlocks.has(tcIdx)) {
              // Close text block if open
              if (textBlockOpen) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
                blockIndex++;
                textBlockOpen = false;
              }

              toolBlocks.set(tcIdx, { blockIdx: blockIndex, id: tc.id });
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: "content_block_start", index: blockIndex,
                content_block: { type: "tool_use", id: tc.id, name: tc.function?.name || "", input: {} },
              })}\n\n`);
            }

            if (tc.function?.arguments) {
              const tb = toolBlocks.get(tcIdx);
              if (tb) {
                res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                  type: "content_block_delta", index: tb.blockIdx,
                  delta: { type: "input_json_delta", partial_json: tc.function.arguments },
                })}\n\n`);
              }
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Close open blocks
  if (textBlockOpen) {
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
    blockIndex++;
  }
  for (const [, tb] of toolBlocks) {
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: tb.blockIdx })}\n\n`);
  }

  // message_delta + message_stop
  const stopReason = finishReason === "tool_calls" ? "tool_use"
    : finishReason === "length" ? "max_tokens"
    : "end_turn";

  res.write(`event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })}\n\n`);
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  res.end();
}

// ---- Body: Anthropic Messages → OpenAI Responses API ----
// Used when we need hosted tools (web_search_preview) that Chat Completions doesn't support.

function anthropicBodyToResponsesAPI(body) {
  // Reuse Chat Completions converter for message parsing
  const chatBody = anthropicBodyToOpenAI(body);

  const out = {
    model: chatBody.model,
    stream: true,
  };

  // System messages → instructions
  const systemMsgs = chatBody.messages.filter(m => m.role === "system");
  const otherMsgs = chatBody.messages.filter(m => m.role !== "system");
  if (systemMsgs.length > 0) {
    out.instructions = systemMsgs.map(m => m.content).join("\n");
  }

  // Convert Chat Completions messages → Responses API input items
  const input = [];
  for (const msg of otherMsgs) {
    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: msg.content || "",
      });
    } else if (msg.role === "assistant") {
      if (msg.content) {
        input.push({ role: "assistant", content: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
    } else {
      input.push({ role: msg.role, content: msg.content || "" });
    }
  }

  out.input = input;

  if (chatBody.max_completion_tokens) out.max_output_tokens = chatBody.max_completion_tokens;
  if (chatBody.temperature !== undefined) out.temperature = chatBody.temperature;
  if (chatBody.top_p !== undefined) out.top_p = chatBody.top_p;

  // Tools — convert Chat Completions format → Responses API format
  // Chat Completions: { type: "function", function: { name, description, parameters } }
  // Responses API:    { type: "function", name, description, parameters }
  if (chatBody.tools) {
    out.tools = chatBody.tools.map(t => {
      if (t.type === "function" && t.function) {
        return {
          type: "function",
          name: t.function.name,
          description: t.function.description || "",
          parameters: t.function.parameters || {},
        };
      }
      return t; // hosted tools (web_search_preview) pass through as-is
    });
  }

  return out;
}

// ---- Streaming: OpenAI Responses API SSE → Anthropic Messages SSE ----
// Handles events: response.output_text.delta, response.output_item.added,
// response.function_call_arguments.delta, response.output_item.done, response.completed

async function pipeResponsesStreamAsAnthropic(upRes, res, requestModel) {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");

  const msgId = "msg_" + Date.now();

  // Emit message_start
  res.write(`event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: msgId, type: "message", role: "assistant", model: requestModel,
      content: [], stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  })}\n\n`);

  let blockIndex = 0;
  let textBlockOpen = false;
  const toolBlocks = new Map(); // output_index -> { blockIdx, id }
  let usage = {};

  const reader = upRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() || "";

      for (const part of parts) {
        const lines = part.split(/\r?\n/);
        let eventType = "";
        let dataStr = "";
        for (const line of lines) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
        }
        if (!dataStr || dataStr === "[DONE]") continue;

        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }

        // Text delta
        if (eventType === "response.output_text.delta") {
          if (!textBlockOpen) {
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start", index: blockIndex,
              content_block: { type: "text", text: "" },
            })}\n\n`);
            textBlockOpen = true;
          }
          if (data.delta) {
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta", index: blockIndex,
              delta: { type: "text_delta", text: data.delta },
            })}\n\n`);
          }
        }

        // Text done → close text block
        else if (eventType === "response.output_text.done") {
          if (textBlockOpen) {
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
            blockIndex++;
            textBlockOpen = false;
          }
        }

        // New output item (function_call)
        else if (eventType === "response.output_item.added") {
          const item = data.item;
          if (item?.type === "function_call") {
            if (textBlockOpen) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
              blockIndex++;
              textBlockOpen = false;
            }
            toolBlocks.set(data.output_index, { blockIdx: blockIndex, id: item.call_id || item.id });
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: "content_block_start", index: blockIndex,
              content_block: { type: "tool_use", id: item.call_id || item.id, name: item.name || "", input: {} },
            })}\n\n`);
          }
        }

        // Function call arguments delta
        else if (eventType === "response.function_call_arguments.delta") {
          const tb = toolBlocks.get(data.output_index);
          if (tb && data.delta) {
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta", index: tb.blockIdx,
              delta: { type: "input_json_delta", partial_json: data.delta },
            })}\n\n`);
          }
        }

        // Output item done → close tool block
        else if (eventType === "response.output_item.done") {
          const item = data.item;
          if (item?.type === "function_call") {
            const tb = toolBlocks.get(data.output_index);
            if (tb) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: tb.blockIdx })}\n\n`);
              blockIndex++;
            }
          }
        }

        // Response completed
        else if (eventType === "response.completed") {
          const resp = data.response || data;
          usage = resp.usage || {};
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Close any remaining open text block
  if (textBlockOpen) {
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIndex })}\n\n`);
    blockIndex++;
  }

  // Determine stop reason from what we saw
  const hasToolCalls = toolBlocks.size > 0;
  const stopReason = hasToolCalls ? "tool_use" : "end_turn";

  res.write(`event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: {
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  })}\n\n`);
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  res.end();
}

module.exports = {
  anthropicBodyToOpenAI,
  openAIResponseToAnthropic,
  pipeOpenAIStreamAsAnthropic,
  anthropicBodyToResponsesAPI,
  pipeResponsesStreamAsAnthropic,
};
