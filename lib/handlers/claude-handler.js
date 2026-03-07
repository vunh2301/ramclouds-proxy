/**
 * Claude Handler — handle requests for Anthropic Claude models.
 * Converts OpenAI format → Claude Messages API, manages session, streams SSE.
 */

const { openaiToClaudeRequest } = require("../openai_to_claude");
const { translateClaudeSSEToOpenAI } = require("../claude_sse_to_openai");
const { sanitizeSystemForUpstream } = require("../sanitize");
const { trimToolsForUpstream } = require("../tools");
const { estimateClaudeReqTokens } = require("../token");
const { fetchJson } = require("../http");
const { injectMergeToolPrompt } = require("../merge-tool-prompt");
const { callRamcloudsSummarize, makeSummarySystemMessage, splitForSummarize } = require("../summarize");
const session = require("../session");
const { predictNextTokens, needsSummarize, resetHistory } = require("../middleware/token-guard");
const {
    getLastUserHash,
    dropOrphanToolResults,
    injectMissingToolResults,
    trimMessages,
    mergeClaudeSession,
    buildState,
} = require("../helpers");

async function handleClaude(req, res, incoming, stream, config) {
    const sessionKey = session.getSessionKey(req, incoming);

    // 0. If Cursor sends Responses API format (input instead of messages), convert to messages
    console.log("[claude] incoming keys:", Object.keys(incoming).join(", "), "msgs=", Array.isArray(incoming.messages) ? incoming.messages.length : 0,
        "system type=", typeof incoming.system, "system len=", typeof incoming.system === "string" ? incoming.system.length : Array.isArray(incoming.system) ? incoming.system.length : 0,
        "tool_choice=", JSON.stringify(incoming.tool_choice), "max_tokens=", incoming.max_tokens);
    if (!incoming.messages && Array.isArray(incoming.input)) {
        const msgs = [];
        for (const item of incoming.input) {
            if (!item) continue;
            if (item.role === "system" || item.role === "user") {
                msgs.push({ role: item.role, content: typeof item.content === "string" ? item.content : JSON.stringify(item.content || "") });
            } else if (item.role === "assistant") {
                msgs.push({ role: "assistant", content: typeof item.content === "string" ? item.content : "" });
            } else if (item.type === "function_call") {
                // Merge into previous assistant or create new one
                const prev = msgs[msgs.length - 1];
                if (prev?.role === "assistant") {
                    if (!prev.tool_calls) prev.tool_calls = [];
                    prev.tool_calls.push({ id: item.call_id || item.id || "", type: "function", function: { name: item.name || "", arguments: item.arguments || "{}" } });
                } else {
                    msgs.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id || item.id || "", type: "function", function: { name: item.name || "", arguments: item.arguments || "{}" } }] });
                }
            } else if (item.type === "function_call_output") {
                msgs.push({ role: "tool", tool_call_id: item.call_id || item.id || "", content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
            }
        }
        incoming = { ...incoming, messages: msgs };
        console.log("[claude] converted input ->", msgs.length, "messages");
    }

    // 1. Convert OpenAI → Claude
    const { claudeBody, originalModel, providerModel, toolNameMap } = openaiToClaudeRequest(incoming, stream, config);
    if (config.SANITIZE_SYSTEM) claudeBody.system = sanitizeSystemForUpstream(claudeBody.system);
    if (config.TRIM_TOOLS) claudeBody.tools = trimToolsForUpstream(claudeBody.tools);
    if (Array.isArray(claudeBody.tools)) claudeBody.tools = claudeBody.tools.filter(t => t?.name?.trim());
    claudeBody.system = injectMergeToolPrompt(claudeBody.system, claudeBody.tools, config);
    console.log("[claude] tools:", (incoming.tools || []).map(t => t?.function?.name || t?.name || "?").join(", "));

    // 2. Session merge
    const sess = session.get(sessionKey);
    const lastHash = getLastUserHash(claudeBody.messages);
    if (sess?.messages?.length) {
        const same = sess.lastUserHash === lastHash;
        const recent = Date.now() - (sess.updatedAt || 0) < 90_000;
        const tailIsA = sess.messages[sess.messages.length - 1]?.role === "assistant";
        if (same && recent && !tailIsA) {
            claudeBody.messages = sess.messages;
            if (sess.system != null) claudeBody.system = sess.system;
        } else {
            const { merged, appended } = mergeClaudeSession(sess, claudeBody.messages);
            if (appended) console.log("[claude] merge: +" + appended);
            claudeBody.messages = merged;
            if (sess.system != null) claudeBody.system = sess.system;
        }
    }
    claudeBody.messages = injectMissingToolResults(dropOrphanToolResults(claudeBody.messages)).messages || [];

    // 3. Token guard
    let est = estimateClaudeReqTokens(claudeBody);
    const predicted = predictNextTokens(est, sessionKey, config);
    if (needsSummarize(est, predicted, config)) {
        const trimmedAll = trimMessages(claudeBody.messages);
        const { old: trimmedOld, recent: trimmedRecent } = splitForSummarize(trimmedAll, config.KEEP_LAST_MESSAGES);
        const recentMsgs = claudeBody.messages.slice(-trimmedRecent.length);
        if (trimmedOld.length >= 2) {
            try {
                const summary = await callRamcloudsSummarize({ url: config.providerEndpoint("/messages"), apiKey: config.PROVIDER_API_KEY, model: claudeBody.model, system: claudeBody.system, oldMessages: trimmedOld, maxTokens: config.SUMMARY_MAX_TOKENS });
                claudeBody.messages = injectMissingToolResults(dropOrphanToolResults([makeSummarySystemMessage(summary), ...recentMsgs])).messages || [];
            } catch { claudeBody.messages = injectMissingToolResults(dropOrphanToolResults(recentMsgs)).messages || []; }
        } else { claudeBody.messages = injectMissingToolResults(dropOrphanToolResults(recentMsgs)).messages || []; }
        est = estimateClaudeReqTokens(claudeBody);
    }

    // 4. Session commit (pre-response)
    session.set(sessionKey, { messages: claudeBody.messages, system: claudeBody.system ?? null, lastUserHash: lastHash });

    // 5. Build upstream
    const upBody = { ...claudeBody, messages: trimMessages(claudeBody.messages) };
    if (Array.isArray(upBody.system)) upBody.system = upBody.system.map(({ cache_control, ...b }) => b);
    if (Array.isArray(upBody.tools)) upBody.tools = upBody.tools.map(({ cache_control, ...t }) => t);
    upBody.messages = injectMissingToolResults(dropOrphanToolResults(upBody.messages)).messages || [];
    for (const m of upBody.messages) { if (Array.isArray(m?.content)) m.content = m.content.filter(b => !(b?.type === "tool_use" && (!b.name || !b.name.trim()))); }
    upBody.messages = dropOrphanToolResults(upBody.messages);
    const trimDelta = est - estimateClaudeReqTokens(upBody);

    console.log("[claude] model=", providerModel, "est=", est, "trim=", trimDelta);

    // 6. Forward
    const url = config.providerEndpoint("/messages");
    console.log("[claude] ->", url);
    const pRes = await fetchJson(url, { apiKey: config.PROVIDER_API_KEY, body: upBody });
    console.log("[claude] status:", pRes.status);

    if (!pRes.ok) {
        const t = await pRes.text().catch(() => "");
        console.log("[claude] ERROR:", t.slice(0, 200));
        if ([502, 504, 529].includes(pRes.status)) { resetHistory(sessionKey); session.remove(sessionKey); }
        if (res.headersSent) return res.end();
        return res.status(pRes.status).send(t || `Error ${pRes.status}`);
    }

    // 7. Stream
    if (stream && pRes.body) {
        const state = buildState({ providerModel, originalModel, toolNameMap, trimDelta, config });
        const blocks = [];
        const [s1, s2] = pRes.body.tee();

        async function tap() {
            const r = s2.getReader(); let buf = "";
            try {
                while (true) {
                    const { done, value } = await r.read(); if (done) break;
                    buf += new TextDecoder().decode(value);
                    const lines = buf.split("\n"); buf = lines.pop();
                    for (const line of lines) {
                        if (!line.startsWith("data:")) continue;
                        const raw = line.slice(5).trim(); if (!raw || raw === "[DONE]") continue;
                        try {
                            const e = JSON.parse(raw);
                            if (e.type === "content_block_start") blocks[e.index ?? blocks.length] = e.content_block ? { ...e.content_block } : null;
                            else if (e.type === "content_block_delta") {
                                const b = blocks[e.index]; if (!b) continue;
                                if (e.delta?.type === "text_delta") b.text = (b.text || "") + (e.delta.text || "");
                                else if (e.delta?.type === "input_json_delta") b._raw = (b._raw || "") + (e.delta.partial_json || "");
                            } else if (e.type === "content_block_stop") {
                                const b = blocks[e.index]; if (b?._raw !== undefined) { try { b.input = JSON.parse(b._raw); } catch { b.input = {}; } delete b._raw; }
                            }
                        } catch { }
                    }
                }
            } catch { } finally { r.releaseLock(); }
        }

        let aborted = false;
        try { await Promise.all([translateClaudeSSEToOpenAI(s1, res, state), tap()]); }
        catch (e) { aborted = true; console.log("[claude] stream error:", e?.message); }

        for (const b of blocks) { if (b?._raw !== undefined) { try { b.input = JSON.parse(b._raw); } catch { b.input = {}; } delete b._raw; } }
        const real = blocks.filter(Boolean);
        if (real.some(b => b.type === "tool_use" || b.type === "text")) {
            session.commitAssistantTurn(sessionKey, real, "claude");
            console.log("[claude] committed:", real.map(b => `${b.type}${b.name ? "(" + b.name + ")" : ""}`).join(", "));
        } else if (aborted) {
            const cur = session.get(sessionKey);
            if (cur?.messages[cur.messages.length - 1]?.role === "assistant") session.set(sessionKey, { ...cur, messages: cur.messages.slice(0, -1) });
        }
        return;
    }

    // Non-stream
    const json = await pRes.json();
    if (Array.isArray(json?.content)) session.commitAssistantTurn(sessionKey, json.content, "claude");
    const text = (json?.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (res.headersSent) return res.end();
    return res.json({
        id: `chatcmpl-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000),
        model: config.REVERSE_MODEL_MAP?.[providerModel] || originalModel,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    });
}

module.exports = { handleClaude };
