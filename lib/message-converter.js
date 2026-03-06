/**
 * Message Converter — convert between Chat Completions, Responses API, and custom_tool_call formats.
 */

function normalizeMessagesToChatFormat(messages) {
  const result = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === "user" && typeof m.content === "string") {
      let parsed = null;
      try { parsed = JSON.parse(m.content); } catch {}

      if (parsed?.type === "function_call") {
        console.log("[msg] skipping echoed function_call:", parsed.name);
        continue;
      }
      if (parsed?.type === "custom_tool_call") {
        const callId = parsed.call_id || parsed.id || "";
        const name = parsed.name || "";
        const args = parsed.arguments || parsed.args || "{}";
        console.log("[msg] custom_tool_call ->", name, callId?.slice(0, 16));
        result.push({ role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] });
        continue;
      }
      if (parsed?.type === "function_call_output" || parsed?.type === "custom_tool_call_output") {
        const callId = parsed.call_id || parsed.id || "";
        let output = "";
        if (typeof parsed.output === "string") output = parsed.output;
        else if (Array.isArray(parsed.output)) output = parsed.output.map(o => o?.text || o?.content || (typeof o === "string" ? o : JSON.stringify(o))).join("");
        else if (parsed.output !== undefined) output = JSON.stringify(parsed.output);
        if (callId.startsWith("fc_")) continue;
        console.log("[msg] tool_output ->", callId?.slice(0, 16));
        result.push({ role: "tool", tool_call_id: callId, content: output });
        continue;
      }
    }
    result.push(m);
  }
  return result;
}

function chatCompletionsToResponsesInput(messages) {
  const input = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === "system") { input.push({ role: "system", content: m.content || "" }); continue; }
    if (m.role === "assistant") {
      if (m.content) input.push({ role: "assistant", content: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          input.push({ type: "function_call", call_id: tc.id || "", name: tc.function?.name || "", arguments: tc.function?.arguments || "{}" });
        }
      }
      if (!m.content && !m.tool_calls?.length) input.push({ role: "assistant", content: "" });
      continue;
    }
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id || "", output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") });
      continue;
    }
    if (m.role === "user") { input.push({ role: "user", content: m.content || "" }); continue; }
    input.push(m);
  }
  return input;
}

function mergeConsecutiveAssistant(input) {
  const merged = [];
  for (const item of input) {
    const prev = merged[merged.length - 1];
    if (item.role === "assistant" && prev?.role === "assistant" && typeof item.content === "string" && typeof prev.content === "string") {
      prev.content = (prev.content + "\n" + item.content).trim();
    } else {
      merged.push(item);
    }
  }
  return merged;
}

module.exports = { normalizeMessagesToChatFormat, chatCompletionsToResponsesInput, mergeConsecutiveAssistant };
