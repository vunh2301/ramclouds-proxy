const express = require("express");
const { getConfig } = require("./lib/config");
const { createPipeline } = require("./lib/pipeline");
const { openaiToClaudeRequest } = require("./lib/openai_to_claude");
const { translateClaudeSSEToOpenAI } = require("./lib/claude_sse_to_openai");
const { sanitizeSystemForUpstream } = require("./lib/sanitize");
const { trimToolsForUpstream } = require("./lib/tools");
const { estimateClaudeReqTokens } = require("./lib/token");
const { fetchJson } = require("./lib/http");
const {
  callRamcloudsSummarize,
  makeSummarySystemMessage,
  splitForSummarize,
} = require("./lib/summarize");

const config = getConfig();

let __lastEstTokens = 0;

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

// Token limits read from config (.env RAM_SOFT_LIMIT_TOKENS)
// Hard cap = soft limit - 20k as safety buffer against mid-stream growth
const EFFECTIVE_SOFT_LIMIT = config.RAM_SOFT_LIMIT_TOKENS;
const EFFECTIVE_HARD_LIMIT = Math.max(config.RAM_SOFT_LIMIT_TOKENS - 20_000, 80_000);

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
    "softLimit=", EFFECTIVE_SOFT_LIMIT,
    "hardLimit=", EFFECTIVE_HARD_LIMIT
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
  const { claudeBody, originalModel, providerModel, toolNameMap } =
    openaiToClaudeRequest({ ...incoming, model: resolvedModel }, stream, config);

  if (config.SANITIZE_SYSTEM) claudeBody.system = sanitizeSystemForUpstream(claudeBody.system);
  if (config.TRIM_TOOLS) claudeBody.tools = trimToolsForUpstream(claudeBody.tools);

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
  claudeBody.messages = dropOrphanToolResults(claudeBody.messages);

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

  const needsSummarize = est >= EFFECTIVE_HARD_LIMIT || predicted > EFFECTIVE_SOFT_LIMIT;

  if (needsSummarize) {
    const reason = est >= EFFECTIVE_HARD_LIMIT ? "hard_limit" : "soft_limit";
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
        claudeBody.messages = dropOrphanToolResults(claudeBody.messages);

        est = estimateClaudeReqTokens(claudeBody);
        console.log("[proxy] est_tokens_after_summary =", est);
        bus.emit("context:summarized", { est });
      } catch (e) {
        console.log("[proxy] summarize error:", e?.message || e);
        claudeBody.messages = dropOrphanToolResults(recent);
        est = estimateClaudeReqTokens(claudeBody);
        console.log("[proxy] est_tokens_after_drop =", est);
        bus.emit("context:dropped", { est });
      }
    } else {
      claudeBody.messages = dropOrphanToolResults(recent);
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
  upstreamBody.messages = dropOrphanToolResults(upstreamBody.messages);
  const { messages: injectedMessages, newInjectedIds } = injectMissingToolResults(upstreamBody.messages, sessionInjectedIds);
  upstreamBody.messages = injectedMessages;

  // Persist injected ids so next request doesn't re-inject
  if (newInjectedIds.size > 0) {
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
          real.map((b) => `${b.type}${b.id ? ":" + b.id : ""}`).join(", "));
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
            const newMessages = dropOrphanToolResults([summaryMsg, ...recent]);
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
            const newMessages = dropOrphanToolResults(recent);
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
  console.log(`[proxy] PROVIDER_BASE_URL_RAW=${config.PROVIDER_BASE_URL_RAW || "(missing)"}`);
  console.log(`[proxy] parsed origin=${config.PROVIDER_ORIGIN || "(missing)"} basePath=${config.PROVIDER_BASEPATH || "(none)"}`);
  console.log(`[proxy] token limits: soft=${EFFECTIVE_SOFT_LIMIT} hard=${EFFECTIVE_HARD_LIMIT} (overrides config.RAM_SOFT_LIMIT_TOKENS)`);
});
