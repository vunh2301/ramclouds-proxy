const { normalizeMessagesToChatFormat, chatCompletionsToResponsesInput, mergeConsecutiveAssistant } = require("../message-converter");
const { normalizeOpenAITools } = require("../tools");
const { buildOriginalParamsMap, enrichToolsForResponsesAPI } = require("../tool-enricher");

const UNSUPPORTED_FIELDS = new Set(["user", "metadata", "store", "include", "prompt_cache_retention", "stream_options"]);

function readModeValue(obj, field) {
  if (!obj || typeof obj !== "object") return "";
  const v = obj[field];
  return typeof v === "string" ? v.trim() : "";
}

function resolveAmpMode(req, incoming, config) {
  const field = config.AMP_MODE_FIELD || "mode";
  const source = config.AMP_MODE_SOURCE || "both";
  const metadata = (incoming && typeof incoming.metadata === "object" && incoming.metadata) || {};

  let raw = "";
  if (source === "metadata" || source === "both") raw = readModeValue(metadata, field);
  if (!raw && (source === "body" || source === "both")) raw = readModeValue(incoming, field);

  const chosen = (raw || config.AMP_DEFAULT_MODE || "smart").toLowerCase();
  const allowed = new Set((config.AMP_ALLOWED_MODES || ["smart", "deep", "fast", "plan"]).map(s => String(s).trim().toLowerCase()));
  const smartFallback = allowed.has("smart") ? "smart" : ((config.AMP_DEFAULT_MODE || "smart").toLowerCase());
  const mode = allowed.has(chosen) ? chosen : smartFallback;

  if (raw && mode !== chosen) {
    console.log(`[amp] invalid mode '${chosen}', fallback -> '${mode}'`);
  }

  return mode;
}

function applyAmpModePolicy(body, mode, config) {
  const presets = (config && config.AMP_MODE_PRESETS) || {};
  const preset = (presets && presets[mode]) || {};

  for (const [k, v] of Object.entries(preset)) {
    if (body[k] === undefined) body[k] = v;
  }

  if (config.AMP_ATTACH_MODE_TAG) {
    const metadata = (body.metadata && typeof body.metadata === "object") ? body.metadata : {};
    body.metadata = { ...metadata, amp_mode: mode, client: metadata.client || "amp-cli" };
  }

  return body;
}

function buildAmpResponsesBody(incoming, stream, mode, config) {
  const tools = normalizeOpenAITools(incoming.tools);
  const origParams = buildOriginalParamsMap(incoming.tools);
  const enrichedTools = Array.isArray(tools) && tools.length > 0
    ? enrichToolsForResponsesAPI(tools, origParams)
    : undefined;

  const out = { stream: !!stream };

  if (!incoming.messages && incoming.input) {
    for (const [k, v] of Object.entries(incoming)) {
      if (!UNSUPPORTED_FIELDS.has(k)) out[k] = v;
    }
    out.stream = !!stream;
    if (enrichedTools) out.tools = enrichedTools;
    delete out.mode;
    if (out.metadata && typeof out.metadata === "object") {
      delete out.metadata[config.AMP_MODE_FIELD || "mode"];
    }
    return applyAmpModePolicy(out, mode, config);
  }

  let messages = Array.isArray(incoming.messages) ? incoming.messages : null;
  if (!messages && Array.isArray(incoming.input)) {
    messages = incoming.input.map(item => {
      if (typeof item === "string") return { role: "user", content: item };
      const role = item?.role || "user";
      const text = Array.isArray(item?.content)
        ? item.content.map(c => c?.text || (typeof c === "string" ? c : "")).join("")
        : String(item?.content || "");
      return { ...item, role, content: text };
    });
  }
  if (!messages && typeof incoming.input === "string") messages = [{ role: "user", content: incoming.input }];
  messages = Array.isArray(messages) ? messages : [];

  const normalized = normalizeMessagesToChatFormat(messages);
  const input = mergeConsecutiveAssistant(chatCompletionsToResponsesInput(normalized));

  out.model = incoming.model;
  out.input = input;
  if (incoming.temperature !== undefined) out.temperature = incoming.temperature;
  if (incoming.max_tokens !== undefined) out.max_output_tokens = incoming.max_tokens;
  if (incoming.max_completion_tokens !== undefined) out.max_output_tokens = incoming.max_completion_tokens;
  if (incoming.tool_choice !== undefined) out.tool_choice = incoming.tool_choice;
  if (incoming.parallel_tool_calls !== undefined) out.parallel_tool_calls = incoming.parallel_tool_calls;
  if (enrichedTools) out.tools = enrichedTools;

  return applyAmpModePolicy(out, mode, config);
}

module.exports = {
  resolveAmpMode,
  applyAmpModePolicy,
  buildAmpResponsesBody,
};
