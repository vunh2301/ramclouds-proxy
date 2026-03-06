require("dotenv").config();
const express = require("express");
const { getConfig } = require("./lib/config");
const { createPipeline } = require("./lib/pipeline");
const { openaiToClaudeRequest } = require("./lib/openai_to_claude");
const { translateClaudeSSEToOpenAI } = require("./lib/claude_sse_to_openai");
const { sanitizeSystemForUpstream } = require("./lib/sanitize");
const { trimToolsForUpstream, normalizeOpenAITools } = require("./lib/tools");
const { estimateClaudeReqTokens } = require("./lib/token");
const { fetchJson } = require("./lib/http");
const {
  callRamcloudsSummarize,
  makeSummarySystemMessage,
  splitForSummarize,
} = require("./lib/summarize");
console.log("ENV TEST:", process.env.OPENAI_BASE_URL);
const config = getConfig();


// -------------------- session cache --------------------
// Keep reduced history so Cursor resends don't blow context again.
const SESSION = new Map();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6h

function cleanupSessions() {
  const now = Date.now();
  for (const [k, v] of SESSION.entries()) {
    if (!v?.updatedAt || now - v.updatedAt > SESSION_TTL_MS) SESSION.delete(k);
  }
}

// fast stable hash (good enough for dedupe)
function stableHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function getSessionKey(req, incoming) {
  return (
    incoming?.metadata?.user_id ||
    req.headers["x-user-id"] ||
    req.headers["x-cursor-user-id"] ||
    req.ip ||
    "anon"
  );
}

function extractTextFromClaudeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function getLastUserClaudeMsg(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return m;
  }
  return null;
}

function getLastUserHash(messages) {
  const m = getLastUserClaudeMsg(messages);
  if (!m) return "";
  // Include tool_result content so same user-text + different tool results
  // are NOT treated as identical retries (would cause reuse-session to drop results).
  let sig = extractTextFromClaudeContent(m.content) || "";
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b?.type === "tool_result") {
        const val =
          typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
            ? b.content.map((x) => (typeof x === "string" ? x : x?.text || "")).join("")
            : JSON.stringify(b.content ?? "");
        sig += "|tr:" + val.slice(0, 512);
      }
    }
  }
  return stableHash(sig);
}

// -------------------- merge-by-overlap (stop the "append forever" loop) --------------------
// IMPORTANT: signatures intentionally IGNORE tool_use/tool_result ids,
// because ids can differ across retries and would prevent overlap detection.
function normalizeClaudeMsgForSig(m) {
  if (!m) return "null";
  const role = m.role || "";
  const text = extractTextFromClaudeContent(m.content).slice(0, 4000);

  let toolHint = "";
  if (Array.isArray(m.content)) {
    const tuIds = [];
    const trIds = [];
    for (const b of m.content) {
      if (!b) continue;
      if (b.type === "tool_use" && b.id) tuIds.push(b.id);
      else if (b.type === "tool_result") {
        // tool_use_id is stable across retries; use it for identity
        const id = b.tool_use_id || b.id || b.call_id || "";
        trIds.push(id);
      }
    }
    // Include ids in sig so different tool turns are never conflated.
    // For overlap detection: same assistant tool_use call always has same id (from session).
    // Incoming tool_result has same tool_use_id referencing that call.
    if (tuIds.length) toolHint += "|tu:" + tuIds.join(",");
    if (trIds.length) toolHint += "|tr:" + trIds.join(",");
  }

  return `${role}|${stableHash(text)}${toolHint}`;
}
function msgSig(m) {
  return normalizeClaudeMsgForSig(m);
}

// Merge strategy:
// - We store reduced history in session (after summarize/drop).
// - Each request, Cursor re-sends full history.
// - Find overlap between session and incoming (by signatures).
// - Append ONLY the truly-new suffix.
function mergeWithSession(sess, incoming) {
  if (!sess?.messages?.length) return { merged: incoming || [], appended: 0, overlap: false };

  const base = sess.messages;
  const inc = Array.isArray(incoming) ? incoming : [];
  if (inc.length === 0) return { merged: base, appended: 0, overlap: false };

  const baseSigs = base.map(msgSig);
  const incSigs = inc.map(msgSig);

  const baseLastSig = baseSigs[baseSigs.length - 1];

  let bestEnd = -1;
  let bestRun = 0;

  for (let i = incSigs.length - 1; i >= 0; i--) {
    if (incSigs[i] !== baseLastSig) continue;

    let bi = baseSigs.length - 1;
    let ii = i;
    let run = 0;

    while (bi >= 0 && ii >= 0 && baseSigs[bi] === incSigs[ii]) {
      run++;
      bi--;
      ii--;
      if (run >= 80) break; // safety
    }

    if (run > bestRun) {
      bestRun = run;
      bestEnd = i;
    }
    if (bestRun >= 12) break; // good enough
  }

  // Overlap found
  if (bestEnd >= 0 && bestRun > 0) {
    const suffix = inc.slice(bestEnd + 1);

    if (suffix.length === 0) {
      // No suffix — but if base ends with assistant and incoming has a trailing
      // user/tool_result message AFTER the overlap point that we missed, append it.
      // This happens when session already has the assistant turn but incoming also
      // carries the subsequent tool_result user message.
      const baseTail = base[base.length - 1];
      const incTail = inc[inc.length - 1];
      if (baseTail?.role === "assistant" && incTail?.role === "user" &&
          msgSig(baseTail) !== msgSig(incTail)) {
        return { merged: [...base, incTail], appended: 1, overlap: true };
      }
      return { merged: base, appended: 0, overlap: true };
    }

    // Dedupe: if suffix already equals the tail of base, don't append.
    if (base.length >= suffix.length) {
      let same = true;
      for (let t = 0; t < suffix.length; t++) {
        if (msgSig(base[base.length - suffix.length + t]) !== msgSig(suffix[t])) {
          same = false;
          break;
        }
      }
      if (same) return { merged: base, appended: 0, overlap: true };
    }

    return { merged: [...base, ...suffix], appended: suffix.length, overlap: true };
  }

  // No overlap: fallback — append the last user message if it's genuinely new.
  // Use full msgSig (includes tool ids) not just text hash, so tool_result
  // messages with empty text are still distinguished by their tool_use_id.
  const lastUser = getLastUserClaudeMsg(inc);
  if (!lastUser) return { merged: base, appended: 0, overlap: false };

  const newSig = msgSig(lastUser);
  const baseLastUser = getLastUserClaudeMsg(base);
  const baseSig = baseLastUser ? msgSig(baseLastUser) : "";

  if (newSig === baseSig) return { merged: base, appended: 0, overlap: false };
  if (newSig === msgSig(base[base.length - 1])) return { merged: base, appended: 0, overlap: false };

  return { merged: [...base, lastUser], appended: 1, overlap: false };
}

// Remove tool_result blocks that have no matching tool_use in the current payload.
function dropOrphanToolResults(messages) {
  try {
    const toolIds = new Set();
    for (const m of messages || []) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b?.type === "tool_use" && b.id) toolIds.add(b.id);
      }
    }

    return (messages || [])
      .map((m) => {
        if (!Array.isArray(m.content)) return m;
        const filtered = m.content.filter((b) => {
          if (b?.type !== "tool_result") return true;
          const id = b.tool_use_id || b.id || b.call_id;
          if (!id) return true;
          if (!toolIds.has(id)) {
            console.log("[proxy] dropping orphan tool_result:", id);
            return false;
          }
          return true;
        });
        return { ...m, content: filtered };
      })
      .filter((m) => !Array.isArray(m.content) || m.content.length > 0);
  } catch (e) {
    console.log("[proxy] tool cleanup error:", e?.message || e);
    return messages;
  }
}



// -------------------- upstream trim --------------------
// Applied ONLY to the copy sent to ramclouds — session is never modified.
// 1. Drop thinking blocks (save 10-30k tokens/turn)
// 2. Drop cache_control metadata (not needed by provider, just noise)
// 3. Truncate tool_result content > 8k chars
const TOOL_RESULT_MAX_CHARS = 8000;

function trimMessagesForUpstream(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!Array.isArray(m?.content)) return m;

    const trimmed = m.content
      .filter((b) => b?.type !== "thinking" && b?.type !== "redacted_thinking")
      .map((b) => {
        if (!b) return b;
        const { cache_control, ...rest } = b;

        if (rest.type === "tool_result") {
          if (typeof rest.content === "string" && rest.content.length > TOOL_RESULT_MAX_CHARS) {
            return { ...rest, content: rest.content.slice(0, TOOL_RESULT_MAX_CHARS) + "\n…[truncated]" };
          }
          if (Array.isArray(rest.content)) {
            return {
              ...rest,
              content: rest.content.map((c) => {
                if (c?.type === "text" && typeof c.text === "string" && c.text.length > TOOL_RESULT_MAX_CHARS) {
                  return { ...c, text: c.text.slice(0, TOOL_RESULT_MAX_CHARS) + "\n…[truncated]" };
                }
                return c;
              }),
            };
          }
        }

        return rest;
      })
      .filter(Boolean);

    // If assistant message had ONLY thinking blocks and is now empty,
    // drop it entirely — dropOrphanToolResults will clean up any orphan tool_results.
    if (trimmed.length === 0) return null;

    return { ...m, content: trimmed };
  }).filter(Boolean);
}

function trimToolsForUpstreamCacheControl(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t) => {
    if (!t) return t;
    const { cache_control, ...rest } = t;
    return rest;
  });
}

// Inject synthetic tool_result for tool_use blocks with no matching output.
// Scenario: tool hangs → Cursor restarts → sends new user text but no tool_result
// → provider sees unanswered tool_use → 400.
// IMPORTANT: Only inject for tool_use blocks in the LAST assistant turn,
// not historical ones — to avoid re-injecting on every request.
function injectMissingToolResults(messages, alreadyInjected = new Set()) {
  if (!Array.isArray(messages)) return { messages, newInjectedIds: new Set() };

  const answeredIds = new Set(alreadyInjected);
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type === "tool_result") {
        const id = b.tool_use_id || b.id || b.call_id;
        if (id) answeredIds.add(id);
      }
    }
  }

  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") { lastAssistantIdx = i; break; }
  }
  if (lastAssistantIdx === -1) return { messages, newInjectedIds: new Set() };

  const lastAssistant = messages[lastAssistantIdx];
  if (!Array.isArray(lastAssistant?.content)) return { messages, newInjectedIds: new Set() };

  const unanswered = lastAssistant.content.filter(
    b => b?.type === "tool_use" && b.id && !answeredIds.has(b.id)
  );
  if (unanswered.length === 0) return { messages, newInjectedIds: new Set() };

  const nextMsg = messages[lastAssistantIdx + 1];
  const nextIsToolResult = Array.isArray(nextMsg?.content) &&
    nextMsg.content.some(b => b?.type === "tool_result");
  if (nextIsToolResult) return { messages, newInjectedIds: new Set() };

  const syntheticResults = unanswered.map(u => ({
    type: "tool_result",
    tool_use_id: u.id,
    content: "Tool execution was interrupted. Please retry or continue without this result.",
  }));

  console.log("[proxy] injecting synthetic tool_results for:",
    unanswered.map(u => u.id).join(", "));

  const result = [...messages];
  // Find next user message after lastAssistantIdx to merge synthetic into
  const nextUserIdx = result.findIndex((m, i) => i > lastAssistantIdx && m?.role === "user");
  if (nextUserIdx !== -1) {
    // Prepend synthetic tool_results into existing user message
    const existing = result[nextUserIdx];
    const existingContent = Array.isArray(existing.content) ? existing.content : [{ type: "text", text: existing.content || "" }];
    result[nextUserIdx] = { ...existing, content: [...syntheticResults, ...existingContent] };
    console.log("[proxy] merged synthetic tool_results into existing user message at idx", nextUserIdx);
  } else {
    // No next user message — insert new one
    result.splice(lastAssistantIdx + 1, 0, { role: "user", content: syntheticResults });
  }
  const newInjectedIds = new Set(unanswered.map(u => u.id));
  return { messages: result, newInjectedIds };
}


const app = express();
app.use(express.json({ limit: "25mb" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// -------------------- model map --------------------
// Opus is hardcoded — all opus aliases always map to claude-opus-4-5.
// Other models can be added via EXTRA_MODEL_MAP in .env as JSON:
//   EXTRA_MODEL_MAP={"gpt-5.3-codex":"gpt-5.4-amp","gpt-4o":"gpt-4o-mini"}
const OPUS_ALIASES = [
  "claude-opus-4.6-CL",
  "claude-opus-4.6",
  "claude-opus-4-5",
  "claude-opus",
];
const OPUS_TARGET = "claude-opus-4-5";

let extraModelMap = {};
try {
  if (config.EXTRA_MODEL_MAP) extraModelMap = JSON.parse(config.EXTRA_MODEL_MAP);
} catch { console.log("[proxy] EXTRA_MODEL_MAP parse error — ignored"); }

function resolveModel(incomingModel) {
  if (!incomingModel) return OPUS_TARGET;
  if (OPUS_ALIASES.includes(incomingModel)) return OPUS_TARGET;
  if (extraModelMap[incomingModel]) return extraModelMap[incomingModel];
  // fallback to config.MODEL_MAP then original
  return config.MODEL_MAP?.[incomingModel] || incomingModel;
}

app.get("/v1/models", (_req, res) => {
  const extra = Object.keys(extraModelMap).map(id => ({ id, object: "model" }));
  res.json({
    object: "list",
    data: [
      ...OPUS_ALIASES.map(id => ({ id, object: "model" })),
      ...extra,
    ],
  });
});

app.use((req, _res, next) => {
  console.log(`[proxy] ${req.method} ${req.path}`);
  next();
});

// Per-session token growth tracker (more accurate than single global var)
const SESSION_TOKEN_HISTORY = new Map();

function predictNextTokens(est, sessionKey) {
  const hist = SESSION_TOKEN_HISTORY.get(sessionKey) || [];
  hist.push(est);
  if (hist.length > 8) hist.shift();
  SESSION_TOKEN_HISTORY.set(sessionKey, hist);

  // Use max recent growth (not avg) to be conservative
  let maxGrowth = 5000;
  if (hist.length >= 2) {
    for (let i = 1; i < hist.length; i++) {
      const d = hist[i] - hist[i - 1];
      if (d > maxGrowth) maxGrowth = d;
    }
  }

  // Project 2 turns ahead with 1.3x safety buffer
  const projected = est + Math.ceil(maxGrowth * 2 * 1.3);

  console.log(
    "[proxy] predict:",
    "maxGrowth=", maxGrowth,
    "projected=", projected,
    "softLimit=", config.RAM_SOFT_LIMIT_TOKENS,
    "hardLimit=", config.RAM_HARD_LIMIT_TOKENS
  );

  return projected;
}

// translateClaudeSSEToOpenAI expects these fields.
function buildState({ providerModel, originalModel, toolNameMap, trimDelta = 0 }) {
  return {
    messageId: `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    providerModel,
    clientModel: config.REVERSE_MODEL_MAP?.[providerModel] || originalModel,
    toolNameMap,
    trimDelta,        // tokens dropped by upstream trim — inflate input_tokens for Cursor
    toolCalls: new Map(),
    toolCallIndex: 0,
    serverToolBlockIndex: -1,
    inThinkingBlock: false,
    currentThinkingIndex: -1,
    finishReason: null,
    finishReasonSent: false,
    usage: null,
  };
}

// -------------------- model routing --------------------
const ANTHROPIC_MODEL_PREFIXES = ["claude-"];
const ANTHROPIC_HARDCODED = new Set([
  "claude-opus-4.6-CL", "claude-opus-4.6", "claude-opus-4-5", "claude-opus",
  "claude-sonnet", "claude-haiku",
]);

function isAnthropicModel(model) {
  if (!model) return true; // default to anthropic path
  if (ANTHROPIC_HARDCODED.has(model)) return true;
  return ANTHROPIC_MODEL_PREFIXES.some(p => model.startsWith(p));
}

// Forward non-Anthropic models via OpenAI-compatible API.
// Full session management: merge, token guard, summarize — same as Claude path.
// -------------------- OpenAI-format merge --------------------
// looseSig: stable for user (content hash), role-only for assistant/tool
// Cursor strips tool_calls and content from assistant messages when echoing history,
// so we can only reliably match assistant by role position.
function looseSig(m) {
  if (!m) return 'null';
  const role = m.role || '';
  if (role === 'user') {
    const text = typeof m.content === 'string' ? m.content.slice(0, 200) :
      Array.isArray(m.content) ? m.content.map(p => p?.text || p?.content || '').join('').slice(0, 200) : '';
    return 'user|' + stableHash(text);
  }
  if (role === 'tool') return 'tool|' + (m.tool_call_id || '').slice(0, 16);
  return role; // assistant: role only — content/tool_calls stripped by Cursor
}

// Merge strategy:
// 1. Find longest positional prefix of base that matches start of inc.
// 2. Collect all NEW messages from inc that are not yet in base.
// Key: base may have assistant(tc) that inc doesn't echo — we keep base's version.
// Key: inc may have tool results that base doesn't have yet — we append them.
function mergeOpenAIWithSession(base, incoming) {
  if (!base?.length) return { merged: incoming || [], appended: 0, overlap: false };
  const inc = Array.isArray(incoming) ? incoming : [];
  if (!inc.length) return { merged: base, appended: 0, overlap: false };

  // Build set of tool_call_ids already answered in base
  const baseToolIds = new Set();
  for (const m of base) {
    if (m?.role === 'tool' && m.tool_call_id) baseToolIds.add(m.tool_call_id);
  }

  // Build set of tool_call_ids that base is WAITING for (from assistant tool_calls)
  const basePendingIds = new Set();
  for (const m of base) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && !baseToolIds.has(tc.id)) basePendingIds.add(tc.id);
      }
    }
  }

  // Find NEW tool results in inc that answer pending ids
  const newToolResults = inc.filter(m =>
    m?.role === 'tool' && m.tool_call_id && basePendingIds.has(m.tool_call_id)
  );

  if (newToolResults.length > 0) {
    console.log("[proxy] OpenAI tool-result merge: +" + newToolResults.length + " tool results for pending ids:", newToolResults.map(m => m.tool_call_id.slice(0,16)));
    // Also append any trailing non-tool messages (e.g. user "Accept" after tool results)
    const newToolResultIds = new Set(newToolResults.map(m => m.tool_call_id));
    const trailingMsgs = [];
    // Find messages in inc that come AFTER the last tool result and are not tool results themselves
    let lastToolResultIdx = -1;
    for (let i = inc.length - 1; i >= 0; i--) {
      if (inc[i]?.role === 'tool' && newToolResultIds.has(inc[i].tool_call_id)) {
        lastToolResultIdx = i;
        break;
      }
    }
    if (lastToolResultIdx >= 0 && lastToolResultIdx < inc.length - 1) {
      for (let i = lastToolResultIdx + 1; i < inc.length; i++) {
        const m = inc[i];
        if (m && m.role !== 'tool') trailingMsgs.push(m);
      }
    }
    if (trailingMsgs.length > 0) {
      console.log("[proxy] OpenAI tool-result merge: also appending", trailingMsgs.length, "trailing messages (roles:", trailingMsgs.map(m => m.role).join(',') + ")");
    }
    return { merged: [...base, ...newToolResults, ...trailingMsgs], appended: newToolResults.length + trailingMsgs.length, overlap: true };
  }

  // Find tool results in inc whose call_id is NOT in base at all (orphan results — e.g. Task tool)
  // Reconstruct a synthetic assistant(tool_calls) + tool result pair so provider sees valid sequence.
  const orphanResults = inc.filter(m =>
    m?.role === 'tool' && m.tool_call_id && !baseToolIds.has(m.tool_call_id) && !basePendingIds.has(m.tool_call_id)
  );
  if (orphanResults.length > 0) {
    const syntheticAssistant = {
      role: 'assistant',
      content: null,
      tool_calls: orphanResults.map(m => ({
        id: m.tool_call_id,
        type: 'function',
        function: { name: 'Task', arguments: '{}' }
      }))
    };
    console.log("[proxy] OpenAI reconstructing orphan tool calls:", orphanResults.map(m => m.tool_call_id.slice(0,16)));
    // Also append trailing non-tool messages (e.g. user message after tool results)
    const trailingNonTool = inc.slice(inc.lastIndexOf(orphanResults[orphanResults.length - 1]) + 1).filter(m => m && m.role !== 'tool');
    return { merged: [...base, syntheticAssistant, ...orphanResults, ...trailingNonTool], appended: orphanResults.length + 1 + trailingNonTool.length, overlap: true };
  }

  // If base has pending tool calls but inc has no tool results (e.g. Cursor sent fresh context),
  // inject synthetic cancellation results so provider doesn't see dangling function_calls.
  if (basePendingIds.size > 0) {
    // Check if ALL pending calls are for client-side-only tools (e.g. CreatePlan) that never send results.
    // For these, inject a success synthetic result so session stays clean.
    const CLIENT_SIDE_TOOLS = new Set(['CreatePlan', 'Task', 'ApplyPatch']);
    const pendingToolNames = new Map();
    for (const m of base) {
      if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.id && basePendingIds.has(tc.id)) pendingToolNames.set(tc.id, tc.function?.name || '');
        }
      }
    }
    const synthetic = [...basePendingIds].map(id => {
      const name = pendingToolNames.get(id) || '';
      const isClientSide = CLIENT_SIDE_TOOLS.has(name);
      return {
        role: 'tool', tool_call_id: id,
        content: isClientSide
          ? (name === 'ApplyPatch' ? 'Patch applied successfully.' : 'Plan created successfully. Now proceed to execute the plan steps.')
          : 'Tool call was interrupted or cancelled. Please proceed without this result.'
      };
    });
    console.log("[proxy] OpenAI injecting synthetic results for pending ids:", [...basePendingIds].map(id => (pendingToolNames.get(id)||'?') + '/' + id.slice(0,12)));
    // Also append trailing non-tool messages from inc
    const lastToolIdx = inc.map((m, i) => m?.role === 'tool' ? i : -1).filter(i => i >= 0).pop() ?? -1;
    const trailingNonTool = lastToolIdx >= 0 ? inc.slice(lastToolIdx + 1).filter(m => m && m.role !== 'tool') : inc.filter(m => m?.role === 'user');
    if (trailingNonTool.length > 0) {
      console.log("[proxy] synthetic merge: also appending", trailingNonTool.length, "trailing messages");
    }
    return { merged: [...base, ...synthetic, ...trailingNonTool], appended: synthetic.length + trailingNonTool.length, overlap: true };
  }

  // No pending tool results — fall back to positional prefix match for new user messages
  let prefixLen = 0;
  while (prefixLen < base.length && prefixLen < inc.length &&
         looseSig(base[prefixLen]) === looseSig(inc[prefixLen])) {
    prefixLen++;
  }

  if (prefixLen === base.length) {
    const suffix = inc.slice(prefixLen).filter(m => m?.role !== 'tool' || !baseToolIds.has(m.tool_call_id));
    if (!suffix.length) return { merged: base, appended: 0, overlap: true };
    return { merged: [...base, ...suffix], appended: suffix.length, overlap: true };
  }

  if (prefixLen > 0) {
    // Partial match — append non-tool suffix, or new user messages
    const suffix = inc.slice(prefixLen).filter(m => m?.role !== 'tool' || !baseToolIds.has(m.tool_call_id));
    if (!suffix.length) return { merged: base, appended: 0, overlap: true };
    console.log("[proxy] OpenAI partial-prefix: prefixLen=" + prefixLen + " +suffix=" + suffix.length);
    return { merged: [...base, ...suffix], appended: suffix.length, overlap: true };
  }

  // No match — append last user message
  const lastUserIdx = inc.map(m => m?.role).lastIndexOf('user');
  if (lastUserIdx < 0) return { merged: base, appended: 0, overlap: false };
  const lastUserSig = looseSig(inc[lastUserIdx]);
  const baseLastUser = base.slice().reverse().find(m => m?.role === 'user');
  if (baseLastUser && looseSig(baseLastUser) === lastUserSig) return { merged: base, appended: 0, overlap: false };
  return { merged: [...base, ...inc.slice(lastUserIdx)], appended: inc.length - lastUserIdx, overlap: false };
}

// Cursor sometimes sends messages in Responses API format (tool calls as JSON strings in user role).
// Convert these to standard Chat Completions format before forwarding.
function normalizeMessagesToChatFormat(messages) {
  const result = [];
  for (const m of messages) {
    if (!m) continue;

    // Check if this is a user message containing Responses API JSON
    if (m.role === 'user' && typeof m.content === 'string') {
      let parsed = null;
      try { parsed = JSON.parse(m.content); } catch {}

      if (parsed?.type === 'function_call') {
        // This is an assistant tool_call echoed as user message — skip it,
        // we already have the assistant message with tool_calls in session
        console.log('[proxy] skipping echoed function_call msg:', parsed.name);
        continue;
      }

      // Handle custom_tool_call (e.g. ApplyPatch) — convert to assistant tool_call
      if (parsed?.type === 'custom_tool_call') {
        const callId = parsed.call_id || parsed.id || '';
        const name = parsed.name || '';
        const args = parsed.arguments || parsed.args || '{}';
        console.log('[proxy] converting custom_tool_call -> assistant tool_call, name=' + name + ' call_id=' + (callId || '').slice(0, 20));
        result.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: callId,
            type: 'function',
            function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
          }]
        });
        continue;
      }

      if (parsed?.type === 'function_call_output' || parsed?.type === 'custom_tool_call_output') {
        // Convert to role:"tool" format
        const callId = parsed.call_id || parsed.id || '';
        // Log CreatePlan result
        const callName = typeof m._name === 'string' ? m._name : '';
        if (callId && (callId.startsWith('call_') )) { const outStr = typeof parsed.output === 'string' ? parsed.output : JSON.stringify(parsed.output); console.log('[proxy] tool_output call_id=' + callId.slice(0,20) + ' output_preview=' + (outStr||'').slice(0,200)); }
        let outputContent = '';
        if (typeof parsed.output === 'string') {
          outputContent = parsed.output;
        } else if (Array.isArray(parsed.output)) {
          outputContent = parsed.output
            .map(o => o?.text || o?.content || (typeof o === 'string' ? o : JSON.stringify(o)))
            .join('');
        } else if (parsed.output !== undefined) {
          outputContent = JSON.stringify(parsed.output);
        }
        if (callId.startsWith('fc_')) {
          console.log('[proxy] skipping fc_ tool_result (not a real call_id):', callId.slice(0,20));
          continue;
        }
        console.log('[proxy] converting function_call_output -> tool role, call_id=', callId.slice(0, 20));
        result.push({ role: 'tool', tool_call_id: callId, content: outputContent });
        continue;
      }
    }

    result.push(m);
  }
  return result;
}

// Convert Chat Completions messages to Responses API input format.
// gpt-5.4 on ramclouds uses Responses API, not Chat Completions.
// Chat Completions format:
//   { role: "assistant", tool_calls: [{id, function: {name, arguments}}] }
//   { role: "tool", tool_call_id: "...", content: "..." }
// Responses API format:
//   { type: "function_call", call_id: "...", name: "...", arguments: "..." }
//   { type: "function_call_output", call_id: "...", output: "..." }
function convertMessagesToResponsesInput(messages) {
  const input = [];
  for (const m of messages) {
    if (!m) continue;

    if (m.role === 'system') {
      // System messages stay as-is in Responses API
      input.push({ role: 'system', content: m.content || '' });
      continue;
    }

    if (m.role === 'assistant') {
      // Split: text content as assistant message, tool_calls as separate function_call items
      if (m.content) {
        input.push({ role: 'assistant', content: m.content });
      }
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id || '',
            name: tc.function?.name || '',
            arguments: tc.function?.arguments || '{}',
          });
        }
      }
      // If no content and no tool_calls, still emit empty assistant
      if (!m.content && !m.tool_calls?.length) {
        input.push({ role: 'assistant', content: '' });
      }
      continue;
    }

    if (m.role === 'tool') {
      // Convert tool result to function_call_output
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || '',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      });
      continue;
    }

    if (m.role === 'user') {
      input.push({ role: 'user', content: m.content || '' });
      continue;
    }

    // Unknown role — pass through
    input.push(m);
  }
  return input;
}

async function handleOpenAIPassthrough(req, res, incoming, stream) {
  const openaiBase = String(config.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
  const openaiUrl = openaiBase.endsWith('/v1')
    ? openaiBase + '/chat/completions'
    : openaiBase + '/v1/chat/completions';

  const apiKey = config.OPENAI_API_KEY || config.PROVIDER_API_KEY;
  const sessionKey = getSessionKey(req, incoming) + ':oai:' + (incoming.model || '');

  // --- Normalize messages ---
  let messages = Array.isArray(incoming.messages) ? incoming.messages : null;
  if (!messages && Array.isArray(incoming.input)) {
    messages = incoming.input.map((item) => {
      if (typeof item === 'string') return { role: 'user', content: item };
      const role = item?.role || 'user';
      if (Array.isArray(item?.content)) {
        const text = item.content.map((c) => {
          if (typeof c === 'string') return c;
          if (c?.type === 'input_text' || c?.type === 'output_text' || c?.type === 'text') return c.text || '';
          return '';
        }).join('');
        return { ...item, role, content: text };
      }
      if (typeof item?.content === 'string') return { ...item, role, content: item.content };
      if (item && typeof item === 'object' && item.role) return { ...item, role, content: '' };
      return { role: 'user', content: JSON.stringify(item ?? '') };
    });
  }
  if (!messages && typeof incoming.input === 'string') messages = [{ role: 'user', content: incoming.input }];
  if (!messages && typeof incoming.prompt === 'string') messages = [{ role: 'user', content: incoming.prompt }];
  messages = Array.isArray(messages) ? messages : [];

  if (messages.length === 0) {
    console.log('[proxy] OpenAI bad payload keys:', Object.keys(incoming || {}));
    if (res.headersSent) return res.end();
    return res.status(400).json({ error: { message: 'requires messages, input, or prompt', type: 'proxy_bad_request' } });
  }

  // --- NORMALIZE format first (Responses API → Chat Completions) ---
  messages = normalizeMessagesToChatFormat(messages);

  // --- SESSION MERGE (overlap-based, same logic as Claude path) ---
  cleanupSessions();
  const sess = SESSION.get(sessionKey);

  // Separate system messages — session only stores non-system turns
  const systemMessages = messages.filter(m => m?.role === 'system');
  const nonSysMessages = messages.filter(m => m?.role !== 'system');

  if (sess?.messages?.length) {
    console.log('[proxy] OpenAI sess tail roles:', sess.messages.slice(-3).map(m => m?.role + (m?.tool_calls?.length ? '(tc)' : '')));
    console.log('[proxy] merge input: sess.len=', sess.messages.length, 'nonSys.len=', nonSysMessages.length, 'nonSys roles=', nonSysMessages.map(m=>m?.role+(m?.tool_calls?.length?'(tc)':''+(m?.tool_call_id?'(tr)':''))).join(','));
    const { merged, appended, overlap } = mergeOpenAIWithSession(sess.messages, nonSysMessages);
    if (overlap || appended > 0) {
      console.log(`[proxy] OpenAI session merge: base=${sess.messages.length} appended=${appended} overlap=${overlap} -> total=${merged.length} roles=${merged.map(m=>m?.role+(m?.tool_calls?.length?'(tc)':'')).join(',')}`);
    } else {
      console.log('[proxy] OpenAI no overlap, using incoming messages');
    }
    messages = [...systemMessages, ...merged];
  }

  // --- TOOL RESULT TRUNCATION ---
  messages = messages.map((m) => {
    if (m?.role !== "tool" || typeof m.content !== "string") return m;
    if (m.content.length > TOOL_RESULT_MAX_CHARS) return { ...m, content: m.content.slice(0, TOOL_RESULT_MAX_CHARS) + "\n…[truncated]" };
    return m;
  });

  // --- TOKEN ESTIMATE & GUARD ---
  const est = Math.ceil(JSON.stringify(messages).length / 3.2 * 1.12);
  const predicted = predictNextTokens(est, sessionKey);

  console.log('[proxy] OpenAI passthrough ->', openaiUrl, 'model=', incoming.model);
  console.log('[proxy] OpenAI messages count =', messages.length, 'est_tokens =', est);

  // Re-separate system/non-system after possible merge changes
  let sysMsgs = messages.filter(m => m?.role === 'system');
  let nonSysMsgs = messages.filter(m => m?.role !== 'system');

  const needsSummarize = est >= config.RAM_HARD_LIMIT_TOKENS || predicted > config.RAM_SOFT_LIMIT_TOKENS;
  if (needsSummarize && nonSysMsgs.length > 6) {
    const reason = est >= config.RAM_HARD_LIMIT_TOKENS ? 'hard_limit' : 'soft_limit';
    console.log('[proxy] OpenAI summarize trigger:', reason, 'est=', est, 'predicted=', predicted);
    const keepN = Math.max(6, config.KEEP_LAST_MESSAGES || 8);
    const oldMsgs = nonSysMsgs.slice(0, nonSysMsgs.length - keepN);
    const recentMsgs = nonSysMsgs.slice(nonSysMsgs.length - keepN);
    if (oldMsgs.length >= 2) {
      try {
        const sysContext = sysMsgs.map(m => m.content || '').join('\n').slice(0, 4000);
        const summarizeSystem = 'You are a conversation compression engine. Summarize the conversation history into compact JSON: {goal, key_decisions, files, commands, errors, state, todo}. Respond ONLY with valid JSON, no markdown.';
        const transcript = oldMsgs.map(m => {
          const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
          return '[' + (m.role || '?') + ']\n' + txt.slice(0, 2000);
        }).join('\n\n');
        const summaryRes = await fetch(openaiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
          body: JSON.stringify({
            model: incoming.model,
            max_tokens: config.SUMMARY_MAX_TOKENS || 1024,
            stream: false,
            messages: [
              { role: 'system', content: summarizeSystem + (sysContext ? '\n\nOriginal context:\n' + sysContext : '') },
              { role: 'user', content: 'Summarize this transcript:\n\n' + transcript },
            ],
          }),
        });
        if (summaryRes.ok) {
          const summaryJson = await summaryRes.json();
          const summaryText = summaryJson?.choices?.[0]?.message?.content || '';
          const summaryMsg = {
            role: 'user',
            content: '=== COMPRESSED CONVERSATION CONTEXT ===\n' + summaryText + '\n=== END CONTEXT ===\n\n[Previous conversation summarized above. Continue from this context.]',
          };
          nonSysMsgs = [summaryMsg, ...recentMsgs];
          messages = [...sysMsgs, ...nonSysMsgs];
          const newEst = Math.ceil(JSON.stringify(messages).length / 3.2 * 1.12);
          console.log('[proxy] OpenAI summarized: messages now=', messages.length, 'est_tokens=', newEst);
          SESSION_TOKEN_HISTORY.delete(sessionKey);
        } else {
          const errText = await summaryRes.text().catch(() => '');
          console.log('[proxy] OpenAI summarize upstream error:', summaryRes.status, errText.slice(0, 100));
          nonSysMsgs = recentMsgs;
          messages = [...sysMsgs, ...nonSysMsgs];
        }
      } catch (e) {
        console.log('[proxy] OpenAI summarize error:', e?.message || e);
        nonSysMsgs = nonSysMsgs.slice(-keepN);
        messages = [...sysMsgs, ...nonSysMsgs];
      }
    }
  }

  // --- SAVE SESSION (pre-response, non-system only) ---
  SESSION.set(sessionKey, { messages: nonSysMsgs, updatedAt: Date.now() });

  // --- TOOLS ---
  const tools = normalizeOpenAITools(incoming.tools);
  if (Array.isArray(incoming.tools)) {
    console.log('[proxy] incoming tools =', incoming.tools.length);
    console.log('[proxy] normalized tools =', Array.isArray(tools) ? tools.length : 0);
    // Log ALL tool names from Cursor
    const allToolNames = incoming.tools.map(t => t?.function?.name || t?.name || '?').join(', ');
    console.log('[proxy] incoming tool names:', allToolNames);
    // Log normalized tool names for comparison
    if (Array.isArray(tools)) {
      const normNames = tools.map(t => t?.function?.name || t?.name || '?').join(', ');
      console.log('[proxy] normalized tool names:', normNames);
    }
    // Debug: log CreatePlan tool definition as received from Cursor
    for (const t of incoming.tools) {
      const n = t?.function?.name || t?.name || '';
      if (n === 'CreatePlan') {
        console.log('[proxy] CreatePlan incoming tool def:', JSON.stringify(t).slice(0, 2000));
      }
      if (n === 'ApplyPatch') {
        console.log('[proxy] ApplyPatch incoming tool def:', JSON.stringify(t).slice(0, 2000));
      }
    }
  }

  // Convert Chat Completions messages → Responses API input[]
  let responsesInput = convertMessagesToResponsesInput(messages);

  // Merge consecutive assistant text messages (Responses API rejects adjacent assistant turns)
  const mergedInput = [];
  for (const item of responsesInput) {
    const prev = mergedInput[mergedInput.length - 1];
    if (item.role === 'assistant' && prev?.role === 'assistant' && typeof item.content === 'string' && typeof prev.content === 'string') {
      prev.content = (prev.content + '\n' + item.content).trim();
      console.log('[proxy] merged consecutive assistant messages');
    } else {
      mergedInput.push(item);
    }
  }
  responsesInput = mergedInput;

  console.log('[proxy] Responses API input (last 3):', JSON.stringify(responsesInput.slice(-3).map(m => ({
    type: m.type || m.role, call_id: (m.call_id || '').slice(0, 20) || null,
    preview: (m.content || m.output || m.arguments || '').toString().slice(0, 60),
  })), null, 2));

  // Build Responses API body
  const responsesBody = { model: incoming.model, stream: !!stream, input: responsesInput };
  if (incoming.temperature !== undefined) responsesBody.temperature = incoming.temperature;
  if (incoming.max_tokens !== undefined) responsesBody.max_output_tokens = incoming.max_tokens;
  if (incoming.max_completion_tokens !== undefined) responsesBody.max_output_tokens = incoming.max_completion_tokens;
  // Known tool schemas that Cursor sends with empty properties — enrich them
  const KNOWN_TOOL_SCHEMAS = {
    // NOTE: CreatePlan intentionally NOT here — Cursor sends full schema via incoming.tools.
    ApplyPatch: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description: 'The complete patch content. MUST start with "*** Begin Patch" on its own line and end with "*** End Patch" on its own line. Use \\n for newlines within the patch string.'
        }
      },
      required: ['patch'],
      additionalProperties: false
    },
    SwitchMode: {
      type: 'object',
      properties: {
        target_mode_id: { type: 'string', description: 'The mode to switch to (e.g. "agent", "ask", "edit")' },
      },
      required: ['target_mode_id']
    },
    Task: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Description of the task to perform' },
        prompt: { type: 'string', description: 'The prompt or instructions for the task' },
      },
      required: ['description']
    },
    Grep: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The pattern to search for' },
        path: { type: 'string', description: 'Path to search in (optional)' },
        include: { type: 'string', description: 'File pattern to include (optional)' },
        case_sensitive: { type: 'boolean', description: 'Whether to be case sensitive (optional)' },
      },
      required: ['pattern']
    },
    Read: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to read' },
        start_line: { type: 'number', description: 'Start line (optional)' },
        end_line: { type: 'number', description: 'End line (optional)' },
      },
      required: ['path']
    },
    rg: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression or literal string to search for' },
        path: { type: 'string', description: 'Directory or file path to search in (optional)' },
        case_sensitive: { type: 'boolean', description: 'Whether search is case sensitive (optional)' },
        file_pattern: { type: 'string', description: 'Glob pattern to filter files (optional)' },
      },
      required: ['pattern']
    },

    Shell: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (optional)' },
      },
      required: ['command']
    },
    ReadFile: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file path to read' },
        start_line: { type: 'number', description: 'Start line number (optional, 1-indexed)' },
        end_line: { type: 'number', description: 'End line number (optional, inclusive)' },
      },
      required: ['path']
    },
    Glob: {
      type: 'object',
      properties: {
        glob_pattern: { type: 'string', description: 'Glob pattern to match files, e.g. "**/*.ts"' },
        path: { type: 'string', description: 'Directory to search in (optional, defaults to workspace root)' },
      },
      required: ['glob_pattern']
    },
    AskQuestion: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'List of questions to ask the user',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique identifier for this question' },
              prompt: { type: 'string', description: 'The question text to display to the user' },
              options: {
                type: 'array',
                description: 'List of options for the user to choose from',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Unique identifier for this option' },
                    label: { type: 'string', description: 'The display text for this option' }
                  },
                  required: ['id', 'label']
                }
              },
              allow_multiple: { type: 'boolean', description: 'Whether multiple options can be selected', default: false }
            },
            required: ['id', 'prompt', 'options']
          }
        }
      },
      required: ['questions']
    }
  };

  // Build a map of original tool parameters from incoming.tools (before normalization)
  const originalToolParams = {};
  if (Array.isArray(incoming.tools)) {
    for (const t of incoming.tools) {
      const n = t?.function?.name || t?.name || '';
      if (!n) continue;
      const p = t?.function?.parameters || t?.parameters || t?.input_schema || null;
      if (p && p.properties && Object.keys(p.properties).length > 0) {
        originalToolParams[n] = p;
      } else {
        // Log tools with empty/missing properties for debugging
        if (n === 'ApplyPatch' || n === 'CreatePlan') {
          console.log('[proxy] ' + n + ' original tool (no properties):', JSON.stringify(t).slice(0, 1000));
        }
      }
    }
  }

  if (Array.isArray(tools) && tools.length > 0) {
    responsesBody.tools = tools.map(t => {
      let name, description, parameters;
      if (t?.type === 'function' && t.function) {
        name = t.function.name;
        description = t.function.description || '';
        parameters = t.function.parameters || {};
      } else if (t?.name) {
        name = t.name;
        description = t.description || '';
        parameters = t.input_schema || t.parameters || {};
      } else {
        return t;
      }
      // Restore original parameters if normalization stripped them
      if ((!parameters.properties || Object.keys(parameters.properties).length === 0) && originalToolParams[name]) {
        console.log('[proxy] restoring original params for tool:', name);
        parameters = originalToolParams[name];
      }
      // If properties is still empty and we know the schema, inject it
      if ((!parameters.properties || Object.keys(parameters.properties).length === 0) && KNOWN_TOOL_SCHEMAS[name]) {
        console.log('[proxy] enriching empty schema for tool:', name, '| original desc:', description.slice(0,100));
        if (name === 'CreatePlan' || name === 'Task') console.log('[proxy] ' + name + ' original schema:', JSON.stringify(parameters));
        parameters = KNOWN_TOOL_SCHEMAS[name];
      }
      if (name === 'CreatePlan' || name === 'Task') console.log('[proxy] ' + name + ' FINAL params sent to API:', JSON.stringify(parameters).slice(0, 500));
      return { type: 'function', name, description, parameters };
    });
  }

  const responsesUrl = openaiUrl.replace(/\/chat\/completions$/, '/responses');
  console.log('[proxy] Responses API URL:', responsesUrl);

  const upstreamRes = await fetch(responsesUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
    body: JSON.stringify(responsesBody),
  });

  console.log('[proxy] OpenAI STATUS:', upstreamRes.status);

  if (!upstreamRes.ok) {
    const t = await upstreamRes.text().catch(() => '');
    console.log('[proxy] OpenAI ERROR:', t.slice(0, 200));
    if ([502, 504, 529].includes(upstreamRes.status)) {
      SESSION_TOKEN_HISTORY.delete(sessionKey);
      SESSION.delete(sessionKey);
      console.log('[proxy] OpenAI gateway error — session wiped');
    }
    if (res.headersSent) return res.end();
    return res.status(upstreamRes.status).send(t || 'OpenAI error ' + upstreamRes.status);
  }

  const chatId = 'chatcmpl-' + Date.now();
  const model = incoming.model || 'gpt-5.4';

  // Helper: emit a Chat Completions SSE chunk to Cursor
  // NOTE: assistantToolCalls is declared inside the stream block below,
  // so we use a wrapper reference that gets set once streaming starts.
  let _assistantToolCalls = null;
  function emitChunk(delta, finishReason = null) {
    // Log raw SSE for CreatePlan tool calls
    if (delta?.tool_calls?.[0]?.function?.name === 'CreatePlan' ||
        (delta?.tool_calls?.[0] && _assistantToolCalls && _assistantToolCalls[delta.tool_calls[0].index]?.function?.name === 'CreatePlan')) {
      console.log('[proxy] SSE CreatePlan chunk:', JSON.stringify(delta).slice(0, 200));
    }
    const chunk = {
      id: chatId, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write('data: ' + JSON.stringify(chunk) + '\n\n');
  }

  // --- STREAM: translate Responses API SSE → Chat Completions SSE ---
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    emitChunk({ role: 'assistant', content: '' }); // opening delta

    let assistantText = '';
    let assistantToolCalls = [];
    _assistantToolCalls = assistantToolCalls;
    let currentToolCallIdx = -1;
    let pendingFcItems = {};
    let _seenEvtTypes = new Set();
    const decoder = new TextDecoder();
    const reader = upstreamRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(data); } catch { continue; }

          const evtType = evt?.type || '';
          // Log first 5 unique event types seen
          if (!_seenEvtTypes) _seenEvtTypes = new Set();
          if (!_seenEvtTypes.has(evtType)) {
            _seenEvtTypes.add(evtType);
            console.log('[proxy] Responses API event type:', evtType, JSON.stringify(evt).slice(0, 120));
          }

          // Text delta
          if (evtType === 'response.output_text.delta' || evtType === 'response.text.delta') {
            const text = evt.delta || '';
            assistantText += text;
            emitChunk({ content: text });
            continue;
          }
          // Also handle Chat Completions format if provider sends both
          if (evt?.choices?.[0]?.delta) {
            const delta = evt.choices[0].delta;
            if (delta.content) { assistantText += delta.content; emitChunk({ content: delta.content }); }
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!assistantToolCalls[idx]) {
                  assistantToolCalls[idx] = { id: tc.id||'', type:'function', function:{name:'',arguments:''} };
                  emitChunk({ tool_calls: [{ index: idx, id: tc.id||'', type:'function', function:{name:tc.function?.name||'',arguments:''} }] });
                }
                if (tc.id) assistantToolCalls[idx].id = tc.id;
                if (tc.function?.name) assistantToolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments) {
                  assistantToolCalls[idx].function.arguments += tc.function.arguments;
                  emitChunk({ tool_calls: [{ index: idx, id: assistantToolCalls[idx].id || tc.id || '', function: { arguments: tc.function.arguments } }] });
                }
              }
            }
            continue;
          }

          // Responses API: function call start via output_item.added
          if (evtType === 'response.output_item.added') {
            const item = evt.item || evt;
            if (item.type === 'function_call') {
              const fcItemId = item.id || '';
              const id = item.call_id || '';
              const name = item.name || '';
              console.log('[proxy] FC output_item.added: fcItemId=' + fcItemId + ' call_id=' + id.slice(0,20) + ' name=' + name);
              // Use hasOwnProperty to avoid !0 falsy bug
              if (fcItemId && !pendingFcItems.hasOwnProperty(fcItemId)) {
                currentToolCallIdx++;
                const idx = currentToolCallIdx;
                pendingFcItems[fcItemId] = idx;
                // Also map call_id → idx so arguments.delta can find it by either key
                if (id) pendingFcItems[id] = idx;
                const realId = id || fcItemId;
                assistantToolCalls[idx] = { id: realId, type:'function', function:{name,arguments:''} };
                // Emit with full name+id so Cursor identifies the tool correctly
                emitChunk({ tool_calls: [{ index: idx, id: realId, type:'function', function:{name, arguments:''} }] });
                console.log('[proxy] FC emitted initial chunk: idx=' + idx + ' id=' + realId.slice(0,20) + ' name=' + name);
              }
            }
            continue;
          }

          // Responses API: function call arguments delta
          if (evtType === 'response.function_call_arguments.delta') {
            const itemId = evt.item_id || '';
            const callId = evt.call_id || '';
            if (!pendingFcItems) pendingFcItems = {};
            // Lookup idx by item_id first, then call_id
            let idx;
            let lookupMethod = '';
            if (itemId && pendingFcItems.hasOwnProperty(itemId)) {
              idx = pendingFcItems[itemId];
              lookupMethod = 'item_id';
            } else if (callId && pendingFcItems.hasOwnProperty(callId)) {
              idx = pendingFcItems[callId];
              lookupMethod = 'call_id';
            } else {
              // Not yet seen — init new tool call
              lookupMethod = 'NEW';
              currentToolCallIdx++;
              idx = currentToolCallIdx;
              const id = callId || itemId;
              if (itemId) pendingFcItems[itemId] = idx;
              if (callId) pendingFcItems[callId] = idx;
              assistantToolCalls[idx] = { id, type:'function', function:{name:'',arguments:''} };
              emitChunk({ tool_calls: [{ index: idx, id, type:'function', function:{name:'',arguments:''} }] });
              console.log('[proxy] FC args.delta NEW tc: idx=' + idx + ' itemId=' + itemId + ' callId=' + callId);
            }
            const args = evt.delta || '';
            if (assistantToolCalls[idx]) assistantToolCalls[idx].function.arguments += args;
            const tcId = assistantToolCalls[idx]?.id || callId || itemId || '';
            // For ApplyPatch: buffer args, don't emit deltas — will emit unwrapped in done handler
            const isApplyPatch = assistantToolCalls[idx]?.function?.name === 'ApplyPatch';
            if (!isApplyPatch) {
              emitChunk({ tool_calls: [{ index: idx, id: tcId, function: { arguments: args } }] });
            }
            continue;
          }

          // Responses API: function call done — update name/call_id/arguments from done event
          if (evtType === 'response.function_call_arguments.done') {
            const itemId = evt.item_id || '';
            const callId = evt.call_id || '';
            if (!pendingFcItems) pendingFcItems = {};
            // Lookup idx by item_id or call_id
            let idx;
            if (itemId && pendingFcItems.hasOwnProperty(itemId)) {
              idx = pendingFcItems[itemId];
            } else if (callId && pendingFcItems.hasOwnProperty(callId)) {
              idx = pendingFcItems[callId];
            } else {
              idx = currentToolCallIdx >= 0 ? currentToolCallIdx : 0;
            }
            if (assistantToolCalls[idx]) {
              // Update to real call_id (not fc_ item id)
              if (callId && callId !== assistantToolCalls[idx].id) {
                if (assistantToolCalls[idx].id) pendingFcItems[assistantToolCalls[idx].id + '_resolved'] = idx;
                assistantToolCalls[idx].id = callId;
                // Also register the new call_id for future lookups
                pendingFcItems[callId] = idx;
              }
              if (evt.name) assistantToolCalls[idx].function.name = evt.name;
              // CRITICAL: Set complete arguments from done event.
              // Delta accumulation may miss chunks; done event has the authoritative full args.
              if (typeof evt.arguments === 'string' && evt.arguments.length > 0) {
                let finalArgs = evt.arguments;
                // ApplyPatch: Cursor expects raw patch string as arguments, not JSON-wrapped {patch:"..."}
                const isApplyPatch = assistantToolCalls[idx]?.function?.name === 'ApplyPatch';
                if (isApplyPatch) {
                  try {
                    const parsed = JSON.parse(finalArgs);
                    if (typeof parsed?.patch === 'string') {
                      finalArgs = parsed.patch;
                      console.log('[proxy] ApplyPatch: unwrapped patch field, len=' + finalArgs.length);
                    }
                  } catch {}
                  // Emit entire unwrapped patch as single arguments delta
                  const tcId = assistantToolCalls[idx].id || callId || itemId || '';
                  emitChunk({ tool_calls: [{ index: idx, id: tcId, function: { arguments: finalArgs } }] });
                } else {
                  const accumulated = assistantToolCalls[idx].function.arguments || '';
                  if (finalArgs.length > accumulated.length) {
                    const remaining = finalArgs.slice(accumulated.length);
                    if (remaining) {
                      const tcId = assistantToolCalls[idx].id || callId || itemId || '';
                      emitChunk({ tool_calls: [{ index: idx, id: tcId, function: { arguments: remaining } }] });
                    }
                  }
                }
                assistantToolCalls[idx].function.arguments = finalArgs;
              }
            }
            continue;
          }

          // Responses API: function call item done — capture name/id
          if (evtType === 'response.output_item.done') {
            const item = evt.item || {};
            if (item.type === 'function_call') {
              const itemId = item.id || '';
              const callId = item.call_id || '';
              if (!pendingFcItems) pendingFcItems = {};
              let idx;
              if (itemId && pendingFcItems.hasOwnProperty(itemId)) idx = pendingFcItems[itemId];
              else if (callId && pendingFcItems.hasOwnProperty(callId)) idx = pendingFcItems[callId];
              else idx = currentToolCallIdx >= 0 ? currentToolCallIdx : -1;
              if (idx >= 0 && assistantToolCalls[idx]) {
                if (item.call_id) {
                  assistantToolCalls[idx].id = item.call_id;
                  pendingFcItems[item.call_id] = idx;
                }
                if (item.name) assistantToolCalls[idx].function.name = item.name;
                // Also backfill arguments from done item if available
                if (typeof item.arguments === 'string' && item.arguments.length > 0) {
                  const accumulated = assistantToolCalls[idx].function.arguments || '';
                  if (item.arguments.length > accumulated.length) {
                    const remaining = item.arguments.slice(accumulated.length);
                    if (remaining) {
                      const tcId = assistantToolCalls[idx].id || callId || itemId || '';
                      emitChunk({ tool_calls: [{ index: idx, id: tcId, function: { arguments: remaining } }] });
                    }
                  }
                  assistantToolCalls[idx].function.arguments = item.arguments;
                }
              }
            }
            continue;
          }

          // Responses API: completed — extract from output array
          if (evtType === 'response.completed' || evtType === 'response.done') {
            const output = evt.response?.output || [];
            for (const item of output) {
              if (item.type === 'message' && Array.isArray(item.content)) {
                for (const c of item.content) {
                  if (c.type === 'output_text' || c.type === 'text') {
                    // already streamed via delta, skip
                  }
                }
              }
            }
            continue;
          }
        }
      }
    } catch (e) {
      console.log('[proxy] stream read error:', e?.message);
    } finally { reader.releaseLock(); }

    emitChunk({}, 'stop');
    res.write('data: [DONE]\n\n');

    const assistantMsg = { role: 'assistant', content: assistantText || null };
    if (assistantToolCalls.filter(Boolean).length > 0) assistantMsg.tool_calls = assistantToolCalls.filter(Boolean);
    // Dedup tool calls by id (same call_id may appear twice due to fc_ vs call_ tracking)
    const seenTcIds = new Set();
    assistantToolCalls = assistantToolCalls.filter(tc => {
      if (!tc) return false;
      if (seenTcIds.has(tc.id)) return false;
      seenTcIds.add(tc.id);
      return true;
    });
    // Normalize empty args before final emit
    assistantToolCalls.filter(Boolean).forEach(tc => {
      if (tc.function) {
        const raw = tc.function.arguments || '';
        const stripped = raw.replace(/[\s\r\n\t]/g, '');
        if (stripped === '' || stripped === '{}') tc.function.arguments = '{}';
      }
    });
    const validTCs = assistantToolCalls.filter(Boolean);
    console.log('[proxy] OpenAI stream done: text_len=', assistantText.length, 'tool_calls=', validTCs.length);
    const emptyArgTCs = validTCs.filter(tc => !tc.function?.arguments || tc.function.arguments.trim().replace(/[\s{}\r\n\t]/g,'') === '');
    if (emptyArgTCs.length > 0) console.log('[proxy] WARNING empty-args tool calls:', emptyArgTCs.map(tc => tc.function?.name + '/' + (tc.id||'').slice(0,16)));
    // Log all tool calls sent to Cursor
    validTCs.forEach(tc => {
      if (tc.function?.name === 'CreatePlan') console.log('[proxy] CreatePlan sent to Cursor: id=' + tc.id + ' args=' + tc.function.arguments);
    });
    const cur = SESSION.get(sessionKey);
    if (cur) {
      SESSION.set(sessionKey, { ...cur, messages: [...cur.messages, assistantMsg], updatedAt: Date.now() });
      console.log('[proxy] OpenAI session committed: total=', cur.messages.length + 1);
    }
    return res.end();
  }

  // --- NON-STREAM: translate Responses API JSON → Chat Completions JSON ---
  const json = await upstreamRes.json();
  let text = '';
  let toolCalls = [];
  // Parse Responses API output
  if (Array.isArray(json?.output)) {
    for (const item of json.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === 'output_text' || c.type === 'text') text += c.text || '';
        }
      }
      if (item.type === 'function_call') {
        const rawArgs = item.arguments || '{}';
    const normArgs = rawArgs.trim().replace(/[\s]/g,'').replace(/^\{+\}+$/, '{}') === '{}' ? '{}' : rawArgs;
    toolCalls.push({ id: item.call_id||item.id||'', type:'function', function:{name:item.name||'',arguments:normArgs} });
      }
    }
  }
  // Fallback: Chat Completions format
  if (!text && !toolCalls.length && json?.choices?.[0]?.message) {
    const msg = json.choices[0].message;
    text = msg.content || '';
    toolCalls = msg.tool_calls || [];
  }

  const assistantMsg = { role: 'assistant', content: text || null };
  if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
  const cur = SESSION.get(sessionKey);
  if (cur) SESSION.set(sessionKey, { ...cur, messages: [...cur.messages, assistantMsg], updatedAt: Date.now() });

  const chatResponse = {
    id: chatId, object: 'chat.completion', created: Math.floor(Date.now()/1000), model,
    choices: [{ index: 0, message: assistantMsg, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: json.usage || {},
  };
  if (res.headersSent) return res.end();
  return res.json(chatResponse);
}


app.post("/v1/chat/completions", async (req, res) => {
  // Config sanity
  if (!config.PROVIDER_ORIGIN) {
    return res.status(500).json({
      error: { message: "Missing PROVIDER_BASE_URL", type: "proxy_config_error" },
    });
  }

  cleanupSessions();

  const bus = createPipeline();
  const incoming = req.body || {};
  const stream = incoming.stream === true;
  const sessionKey = getSessionKey(req, incoming);

  bus.emit("request:received", { stream });

  // Resolve model before translation — hardcoded opus aliases + extra map
  const resolvedModel = resolveModel(incoming.model);
  if (resolvedModel !== incoming.model) {
    console.log("[proxy] model map:", incoming.model, "->", resolvedModel);
  }

  // Route: non-Anthropic models → OpenAI passthrough, Anthropic → Claude pipeline
  if (!isAnthropicModel(resolvedModel)) {
    return handleOpenAIPassthrough(req, res, { ...incoming, model: resolvedModel }, stream);
  }

  const { claudeBody, originalModel, providerModel, toolNameMap } =
    openaiToClaudeRequest({ ...incoming, model: resolvedModel }, stream, config);

  if (config.SANITIZE_SYSTEM) claudeBody.system = sanitizeSystemForUpstream(claudeBody.system);
  if (config.TRIM_TOOLS) claudeBody.tools = trimToolsForUpstream(claudeBody.tools);
  // Log tool names for Claude path
  if (Array.isArray(incoming.tools)) {
    const names = incoming.tools.map(t => t?.function?.name || t?.name || '?').join(', ');
    console.log('[proxy] Claude path incoming tool names:', names);
  }
  // Drop tools with empty/missing name — Claude API rejects them with empty_string error
  if (Array.isArray(claudeBody.tools)) {
    const before = claudeBody.tools.length;
    claudeBody.tools = claudeBody.tools.filter(t => t?.name && t.name.trim().length > 0);
    if (claudeBody.tools.length !== before) console.log('[proxy] dropped', before - claudeBody.tools.length, 'unnamed tools');
  }
// ---- SESSION MERGE ----
  const sess = SESSION.get(sessionKey);
  const incomingLastUserHash = getLastUserHash(claudeBody.messages);

  if (sess?.messages?.length) {
    const now = Date.now();
    const sameUser = sess.lastUserHash && sess.lastUserHash === incomingLastUserHash;
    const recent = now - sess.updatedAt < 90_000;
    const sessTailIsAssistant = sess.messages[sess.messages.length - 1]?.role === "assistant";
// "reuse" only when: same user content AND session does NOT end with assistant.
    // If session ends with assistant, there are pending tool_results in the incoming
    // request that MUST be appended — even if the user-text hash matches.
    if (sameUser && recent && !sessTailIsAssistant) {
      console.log("[proxy] reuse session history");
      claudeBody.messages = sess.messages;
      if (sess.system != null) claudeBody.system = sess.system;
} else {
      const merged = mergeWithSession(sess, claudeBody.messages);
      console.log("[proxy] merge: appended=", merged.appended, "overlap=", merged.overlap,
        "base=", sess.messages.length, "->", merged.merged.length);
if (merged.appended) console.log("[proxy] session merge appended =", merged.appended);
      claudeBody.messages = merged.merged;
      if (sess.system != null) claudeBody.system = sess.system;
    }
  }

  // Always cleanup tool_result after merge (prevents provider "no tool call found" errors)
  const beforeDropLen = Array.isArray(claudeBody.messages) ? claudeBody.messages.length : 0;
  const beforeDropToolResults = Array.isArray(claudeBody.messages)
    ? claudeBody.messages.reduce((n,m)=>n + (Array.isArray(m?.content)?m.content.filter(b=>b?.type==='tool_result').length:0),0)
    : 0;
  claudeBody.messages = injectMissingToolResults(dropOrphanToolResults(claudeBody.messages)).messages || [];
  if (!Array.isArray(claudeBody.messages)) claudeBody.messages = [];
// ---- TOKEN GUARD ----
  let est = estimateClaudeReqTokens(claudeBody);

  console.log("[proxy] model =", providerModel, " stream =", stream);
  console.log(
    "[proxy] tools =",
    Array.isArray(claudeBody.tools) ? claudeBody.tools.length : 0,
    " tool_choice =",
    claudeBody.tool_choice?.type || "none"
  );
  console.log("[proxy] est_tokens =", est);

  const predicted = predictNextTokens(est, sessionKey);

  const needsSummarize = est >= config.RAM_HARD_LIMIT_TOKENS || predicted > config.RAM_SOFT_LIMIT_TOKENS;

  if (needsSummarize) {
    const reason = est >= config.RAM_HARD_LIMIT_TOKENS ? "hard_limit" : "soft_limit";
    console.log("[proxy] summarize trigger:", reason, "est=", est, "predicted=", predicted);
    bus.emit("context:oversize", { est });

    // Split on trimmed messages so the summarize call itself doesn't exceed ramclouds limit.
    // We trim first, split second — then map old indices back to original for session update.
    const trimmedAll = trimMessagesForUpstream(claudeBody.messages);
    const { old: trimmedOld, recent: trimmedRecent } = splitForSummarize(trimmedAll, config.KEEP_LAST_MESSAGES);
    // Keep recent from original (untrimmed) for session — only trimmedOld goes to summarize
    const recentCount = trimmedRecent.length;
    const recent = claudeBody.messages.slice(-recentCount);

    if (trimmedOld.length >= 2) {
      try {
        const summary = await callRamcloudsSummarize({
          url: config.providerEndpoint("/messages"),
          apiKey: config.PROVIDER_API_KEY,
          model: claudeBody.model,
          system: claudeBody.system,
          oldMessages: trimmedOld,
          maxTokens: config.SUMMARY_MAX_TOKENS,
        });

        const summaryMsg = makeSummarySystemMessage(summary);
        claudeBody.messages = [summaryMsg, ...recent];

        // cleanup again after rewriting history
        claudeBody.messages = injectMissingToolResults(dropOrphanToolResults(claudeBody.messages)).messages || [];

        est = estimateClaudeReqTokens(claudeBody);
        console.log("[proxy] est_tokens_after_summary =", est);
        bus.emit("context:summarized", { est });
      } catch (e) {
        console.log("[proxy] summarize error:", e?.message || e);
        claudeBody.messages = injectMissingToolResults(dropOrphanToolResults(recent)).messages || [];
        est = estimateClaudeReqTokens(claudeBody);
        console.log("[proxy] est_tokens_after_drop =", est);
        bus.emit("context:dropped", { est });
      }
    } else {
      claudeBody.messages = injectMissingToolResults(dropOrphanToolResults(recent)).messages || [];
      est = estimateClaudeReqTokens(claudeBody);
      console.log("[proxy] est_tokens_after_drop =", est);
      bus.emit("context:dropped", { est });
    }
  }

  // ---- COMMIT SESSION (pre-response) ----
  // Lưu trạng thái đã merge để các retry ngay lập tức reuse đúng.
  SESSION.set(sessionKey, {
    messages: claudeBody.messages,
    system: claudeBody.system ?? null,
    lastUserHash: incomingLastUserHash,
    updatedAt: Date.now(),
  });

  // Append assistant turn AFTER response so next request overlap-detection works.
  function commitAssistantTurn(contentBlocks) {
    const cur = SESSION.get(sessionKey);
    if (!cur) return;
    const tail = cur.messages[cur.messages.length - 1];
    if (tail?.role === "assistant") return;
    if (!contentBlocks || contentBlocks.length === 0) return;
    SESSION.set(sessionKey, {
      ...cur,
      messages: [...cur.messages, { role: "assistant", content: contentBlocks }],
      updatedAt: Date.now(),
    });
  }

  // Inject synthetic tool_results ONLY into upstreamBody (not claudeBody/session).
  // Track injected ids in session so we don't re-inject on next request.
  const sessionInjectedIds = SESSION.get(sessionKey)?._injectedToolIds || new Set();

  const url = config.providerEndpoint("/messages");
  console.log("[proxy] FORWARD openai->claude ->", url);

  const upstreamBody = {
    ...claudeBody,
    messages: trimMessagesForUpstream(claudeBody.messages),
    tools: trimToolsForUpstreamCacheControl(claudeBody.tools),
  };
  if (Array.isArray(upstreamBody.system)) {
    upstreamBody.system = upstreamBody.system.map(({ cache_control, ...b }) => b);
  }
  upstreamBody.messages = injectMissingToolResults(dropOrphanToolResults(upstreamBody.messages)).messages || [];

  // Sanitize: drop tool_use blocks with empty names from messages (causes 400)
  for (const m of upstreamBody.messages) {
    if (Array.isArray(m?.content)) {
      const before = m.content.length;
      m.content = m.content.filter(b => {
        if (b?.type === "tool_use" && (!b.name || !b.name.trim())) {
          console.log("[proxy] WARN dropping tool_use with empty name, id=", b.id);
          return false;
        }
        return true;
      });
      // If we removed a tool_use, also drop its orphan tool_result in a later user message
    }
  }
  // Re-run orphan cleanup in case we just created orphan tool_results
  upstreamBody.messages = dropOrphanToolResults(upstreamBody.messages);

  if (false) {
    const cur = SESSION.get(sessionKey);
    if (cur) {
      const merged = new Set([...(cur._injectedToolIds || []), ...newInjectedIds]);
      SESSION.set(sessionKey, { ...cur, _injectedToolIds: merged });
    }
  }

  // Debug: log tool_use/tool_result pairing in upstream
  if (process.env.DEBUG_TOOLS) {
    for (const m of upstreamBody.messages) {
      if (!Array.isArray(m?.content)) continue;
      const tu = m.content.filter(b => b?.type === "tool_use").map(b => b.id);
      const tr = m.content.filter(b => b?.type === "tool_result").map(b => b.tool_use_id);
      if (tu.length || tr.length) console.log("[proxy] upstream msg role=", m.role, "tool_use=", tu, "tool_result=", tr);
    }
  }
  // Always log last 4 messages structure for debugging 400s
  {
    const tail = upstreamBody.messages.slice(-4);
    const summary = tail.map(m => {
      if (!Array.isArray(m?.content)) return `${m?.role}:text`;
      const types = m.content.map(b => b?.type + (b?.id ? ":" + b.id.slice(-6) : b?.tool_use_id ? ">" + b.tool_use_id.slice(-6) : ""));
      return `${m?.role}:[${types.join(",")}]`;
    });
    console.log("[proxy] upstream tail:", summary.join(" | "));
  }
  const upstreamEst = estimateClaudeReqTokens(upstreamBody);
  const trimDelta = est - upstreamEst; // tokens dropped by trim — add back in usage for Cursor
  if (trimDelta > 0) {
    console.log("[proxy] trimmed est_tokens:", est, "->", upstreamEst,
      "(saved", trimDelta, "tokens, will inflate usage for Cursor)");
  }

  // Parse Claude SSE stream, tap content_block events to rebuild assistant content,
  // then forward raw bytes to client unchanged via a PassThrough.
  async function handleStream(providerBody) {
    const { PassThrough, Readable } = require("stream");
    const state = buildState({ providerModel, originalModel, toolNameMap, trimDelta });
    const collectedBlocks = [];

    // tee() the WHATWG stream into two independent branches
    const [s1, s2] = providerBody.tee();

    // --- Branch 2: drain s2 via async reader to capture real content block ids ---
    async function drainTap() {
      const reader = s2.getReader();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
          const lines = buf.split("\n");
          buf = lines.pop(); // keep incomplete line
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === "[DONE]") continue;
            try {
              const evt = JSON.parse(raw);
              const t = evt.type;
              if (t === "content_block_start") {
                const idx = evt.index ?? collectedBlocks.length;
                collectedBlocks[idx] = evt.content_block ? { ...evt.content_block } : null;
              } else if (t === "content_block_delta") {
                const blk = collectedBlocks[evt.index];
                if (!blk) continue;
                const d = evt.delta;
                if (d?.type === "text_delta") blk.text = (blk.text || "") + (d.text || "");
                else if (d?.type === "input_json_delta") blk._inputRaw = (blk._inputRaw || "") + (d.partial_json || "");
              } else if (t === "content_block_stop") {
                const blk = collectedBlocks[evt.index];
                if (blk?._inputRaw !== undefined) {
                  try { blk.input = JSON.parse(blk._inputRaw); } catch { blk.input = {}; }
                  delete blk._inputRaw;
                }
              }
            } catch { /* ignore parse errors */ }
          }
        }
      } catch { /* stream aborted — ignore */ }
      finally { reader.releaseLock(); }
    }

    // Run translator (s1) and tap (s2) concurrently so neither blocks the other
    let streamAborted = false;
    try {
      await Promise.all([
        translateClaudeSSEToOpenAI(s1, res, state),
        drainTap(),
      ]);
    } catch (streamErr) {
      streamAborted = true;
      console.log("[proxy] stream aborted mid-flight:", streamErr?.message || streamErr);
    }

    // Finalize partial input_json on any incomplete tool_use blocks
    for (const blk of collectedBlocks) {
      if (blk?._inputRaw !== undefined) {
        try { blk.input = JSON.parse(blk._inputRaw); } catch { blk.input = {}; }
        delete blk._inputRaw;
      }
    }

    // Commit whatever blocks we managed to collect — even on abort.
    // This keeps session consistent so the next retry can merge correctly.
    const real = collectedBlocks.filter(Boolean);
    const toolUseBlocks = real.filter((b) => b.type === "tool_use");
    const hasUsefulContent = real.some((b) => b.type === "tool_use" || b.type === "text");

    if (streamAborted) {
      if (toolUseBlocks.length > 0) {
        // Partial tool_use blocks collected — commit them so retry can match tool_results
        commitAssistantTurn(real);
        console.log("[proxy] stream aborted, committed partial blocks:",
          real.map((b) => `${b.type}${b.id ? ":" + b.id : ""}`).join(", "));
      } else {
        // Nothing useful collected — rollback session to pre-request state
        // so Cursor's retry with full history will re-merge cleanly
        const cur = SESSION.get(sessionKey);
        if (cur) {
          const tail = cur.messages[cur.messages.length - 1];
          if (tail?.role === "assistant") {
            SESSION.set(sessionKey, {
              ...cur,
              messages: cur.messages.slice(0, -1),
              updatedAt: Date.now(),
            });
          }
        }
        // Also reset token history so predict restarts fresh
        SESSION_TOKEN_HISTORY.delete(sessionKey);
        console.log("[proxy] stream aborted with no blocks — session rolled back");
      }
    } else {
      if (hasUsefulContent) {
        commitAssistantTurn(real);
        console.log("[proxy] committed assistant blocks:",
          real.map((b) => `${b.type}${b.name ? "(" + b.name + ")" : ""}${b.id ? ":" + b.id : ""}`).join(", "));
      } else if (state.finishReason) {
        commitAssistantTurn([{ type: "text", text: "" }]);
      } else {
        console.log("[proxy] skipped commit — only thinking blocks, no useful content");
      }
    }
  }

  try {
    const providerRes = await fetchJson(url, {
      apiKey: config.PROVIDER_API_KEY,
      body: upstreamBody,
    });

    console.log("[proxy] PROVIDER STATUS:", providerRes.status);
    console.log("[proxy] PROVIDER CONTENT-TYPE:", providerRes.headers.get("content-type"));

    if (!providerRes.ok) {
      const t = await providerRes.text().catch(() => "");
      console.log("[proxy] PROVIDER ERROR:", t.slice(0, 200));

      // On gateway errors (502/504) or overload (529), the context is likely too large.
      // Force-summarize and wipe session token history so next request starts clean.
      if ([502, 504, 529].includes(providerRes.status)) {
        console.log("[proxy] gateway error", providerRes.status, "— force summarize + reset session");

        // Reset token history so predict starts fresh
        SESSION_TOKEN_HISTORY.delete(sessionKey);

        // Force summarize current session messages
        try {
          const { old, recent } = splitForSummarize(claudeBody.messages, config.KEEP_LAST_MESSAGES || 8);          if (old.length >= 2) {
            const summary = await callRamcloudsSummarize({
              url: config.providerEndpoint("/messages"),
              apiKey: config.PROVIDER_API_KEY,
              model: claudeBody.model,
              system: claudeBody.system,
              oldMessages: old,
              maxTokens: config.SUMMARY_MAX_TOKENS || 1024,
            });
            const summaryMsg = makeSummarySystemMessage(summary);
            const newMessages = injectMissingToolResults(dropOrphanToolResults([summaryMsg, ...recent]).messages);
  if (!Array.isArray(newMessages)) { console.log('[proxy] injectMissing returned non-array'); }
            SESSION.set(sessionKey, {
              messages: newMessages,
              system: claudeBody.system ?? null,
              lastUserHash: incomingLastUserHash,
              updatedAt: Date.now(),
            });
            const newEst = estimateClaudeReqTokens({ ...claudeBody, messages: newMessages });
            console.log("[proxy] force-summary done, new est_tokens=", newEst);
          } else {
            // Not enough to summarize — just keep recent
            const newMessages = injectMissingToolResults(dropOrphanToolResults(recent).messages);
            SESSION.set(sessionKey, {
              messages: newMessages,
              system: claudeBody.system ?? null,
              lastUserHash: incomingLastUserHash,
              updatedAt: Date.now(),
            });
          }
        } catch (se) {
          console.log("[proxy] force-summary error:", se?.message || se);
          // Wipe session entirely so next request starts fresh from Cursor's full history
          SESSION.delete(sessionKey);
        }
      }

      if (res.headersSent) return res.end();
      return res.status(providerRes.status).send(t || `Provider error ${providerRes.status}`);
    }

    if (stream) {
      if (!providerRes.body) return res.end();
      return await handleStream(providerRes.body);
    }

    const json = await providerRes.json();

    // Commit real assistant content for non-stream path
    if (Array.isArray(json?.content)) {
      commitAssistantTurn(json.content);
    }

    const text = Array.isArray(json?.content)
      ? json.content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("")
      : "";

    if (res.headersSent) return res.end();
    return res.json({
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: config.REVERSE_MODEL_MAP?.[providerModel] || originalModel,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
    });
  } catch (e) {
    console.log("[proxy] RUNTIME ERROR:", e?.message || e);
    if (res.headersSent) return res.end();
    return res.status(500).json({
      error: { message: e?.message || String(e), type: "proxy_runtime_error" },
    });
  }
});

app.listen(config.PORT, () => {
  console.log(`[proxy] listening on http://localhost:${config.PORT}`);
  console.log(`[proxy] Anthropic endpoint: ${config.PROVIDER_ORIGIN || "(missing)"}${config.PROVIDER_BASEPATH || ""}`);
  console.log(`[proxy] OpenAI passthrough: ${config.OPENAI_BASE_URL || "https://api.openai.com"}`);
  console.log(`[proxy] token limits: soft=${config.RAM_SOFT_LIMIT_TOKENS} hard=${config.RAM_HARD_LIMIT_TOKENS}`);
  console.log(`[proxy] extra model map:`, extraModelMap);
});
