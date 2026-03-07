/**
 * OpenAI Handler — handle requests for GPT/OpenAI-compatible models.
 *
 * gpt-5.4:       Chat Completions → Responses API conversion → stream convert back
 * gpt-5.3-codex: Chat Completions pass-through (no conversion)
 */

const { normalizeMessagesToChatFormat, chatCompletionsToResponsesInput, mergeConsecutiveAssistant } = require("../message-converter");
const { normalizeOpenAITools } = require("../tools");
const { buildOriginalParamsMap, enrichToolsForResponsesAPI, unwrapToolArguments } = require("../tool-enricher");
const { injectMergeToolPromptOpenAI } = require("../merge-tool-prompt");
const session = require("../session");
const { mergeOpenAIWithSession } = require("../middleware/session-merge");
const { predictNextTokens, needsSummarize, resetHistory } = require("../middleware/token-guard");
const { streamResponsesAPIToChat } = require("./openai-stream");

const TOOL_RESULT_MAX_CHARS = 80_000;

async function handleOpenAI(req, res, incoming, stream, config) {
    const openaiBase = String(config.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
    const openaiUrl = openaiBase.endsWith("/v1") ? openaiBase + "/chat/completions" : openaiBase + "/v1/chat/completions";
    const apiKey = config.OPENAI_API_KEY || config.PROVIDER_API_KEY;
    const hasResponsesFormat = !incoming.messages && !!incoming.input;

    // ==================== Responses API pass-through (Codex, 5.2, etc.) ====================
    // Cursor sends Responses API format (input, reasoning, store, etc.) for some models.
    // Forward directly to /v1/responses — no conversion needed.
    if (hasResponsesFormat) {
        const responsesUrl = openaiBase.endsWith("/v1") ? openaiBase + "/responses" : openaiBase + "/v1/responses";

        // Enrich tool schemas (keep Responses API format)
        const tools = normalizeOpenAITools(incoming.tools);
        const origParams = buildOriginalParamsMap(incoming.tools);
        const enrichedTools = Array.isArray(tools) && tools.length > 0
            ? enrichToolsForResponsesAPI(tools, origParams) : undefined;

        // Build body: pass through supported fields, drop unsupported ones
        const UNSUPPORTED = new Set(["user", "metadata", "store", "include", "prompt_cache_retention", "stream_options"]);
        const body = {};
        for (const [k, v] of Object.entries(incoming)) {
            if (!UNSUPPORTED.has(k)) body[k] = v;
        }
        if (enrichedTools) body.tools = enrichedTools;

        console.log("[responses] -> responses pass-through", responsesUrl, "input=", Array.isArray(incoming.input) ? incoming.input.length : 0, "tools=", enrichedTools?.length || 0);

        const upRes = await fetch(responsesUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
            body: JSON.stringify(body),
        });
        console.log("[responses] status:", upRes.status);

        if (!upRes.ok) {
            const t = await upRes.text().catch(() => "");
            console.log("[responses] ERROR:", t.slice(0, 300));
            if (res.headersSent) return res.end();
            return res.status(upRes.status).send(t || "Error " + upRes.status);
        }

        // Stream: convert Responses API SSE → Chat Completions SSE (Cursor expects Chat format)
        if (stream && upRes.body) {
            const { assistantText, assistantToolCalls } = await streamResponsesAPIToChat(upRes, res, { chatId: "chatcmpl-" + Date.now(), model: incoming.model });
            console.log("[responses] done: text=", assistantText.length, "tools=", assistantToolCalls.length);
            return;
        }

        // Non-stream
        const json = await upRes.json();
        if (res.headersSent) return res.end();
        return res.json(json);
    }

    // ==================== GPT 5.4+: Responses API path (with session) ====================

    console.log("[openai] incoming keys:", Object.keys(incoming).join(", "), "has messages=", !!incoming.messages, "has input=", !!incoming.input);

    const sessionKey = session.getSessionKey(req, incoming) + ":oai:" + (incoming.model || "");

    // 1. Normalize messages
    let messages = Array.isArray(incoming.messages) ? incoming.messages : null;
    if (!messages && Array.isArray(incoming.input)) {
        messages = incoming.input.map(item => {
            if (typeof item === "string") return { role: "user", content: item };
            const role = item?.role || "user";
            const text = Array.isArray(item?.content) ? item.content.map(c => c?.text || (typeof c === "string" ? c : "")).join("") : String(item?.content || "");
            return { ...item, role, content: text };
        });
    }
    if (!messages && typeof incoming.input === "string") messages = [{ role: "user", content: incoming.input }];
    messages = Array.isArray(messages) ? messages : [];
    if (!messages.length) return res.status(400).json({ error: { message: "requires messages or input" } });

    messages = normalizeMessagesToChatFormat(messages);

    // 2. Session merge
    session.cleanup();
    const sysMsgs = messages.filter(m => m?.role === "system");
    let nonSysMsgs = messages.filter(m => m?.role !== "system");
    const sess = session.get(sessionKey);

    if (sess?.messages?.length) {
        const { merged, appended } = mergeOpenAIWithSession(sess.messages, nonSysMsgs);
        if (appended) console.log("[openai] merge: +" + appended + " total=" + merged.length);
        nonSysMsgs = merged;
    }

    // Truncate tool results
    messages = [...sysMsgs, ...nonSysMsgs].map(m => {
        if (m?.role !== "tool" || typeof m.content !== "string") return m;
        return m.content.length > TOOL_RESULT_MAX_CHARS ? { ...m, content: m.content.slice(0, TOOL_RESULT_MAX_CHARS) + "\n…[truncated]" } : m;
    });

    // 3. Token guard + summarize
    const est = Math.ceil(JSON.stringify(messages).length / 3.2 * 1.12);
    const predicted = predictNextTokens(est, sessionKey, config);
    let finalSysMsgs = messages.filter(m => m?.role === "system");
    let finalNonSys = messages.filter(m => m?.role !== "system");

    if (needsSummarize(est, predicted, config) && finalNonSys.length > 6) {
        const keepN = Math.max(6, config.KEEP_LAST_MESSAGES || 8);
        const oldMsgs = finalNonSys.slice(0, -keepN);
        const recentMsgs = finalNonSys.slice(-keepN);
        if (oldMsgs.length >= 2) {
            try {
                const sysCtx = finalSysMsgs.map(m => m.content || "").join("\n").slice(0, 4000);
                const transcript = oldMsgs.map(m => `[${m.role}]\n${String(m.content ?? "").slice(0, 2000)}`).join("\n\n");
                const summRes = await fetch(openaiUrl.replace(/\/chat\/completions$/, "/responses"), {
                    method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
                    body: JSON.stringify({
                        model: incoming.model, max_output_tokens: config.SUMMARY_MAX_TOKENS || 1024, stream: false,
                        input: [
                            { role: "system", content: "Summarize this conversation into compact JSON: {goal, decisions, files, state, todo}. ONLY JSON." + (sysCtx ? "\nContext:\n" + sysCtx : "") },
                            { role: "user", content: "Transcript:\n\n" + transcript },
                        ],
                    }),
                });
                if (summRes.ok) {
                    const j = await summRes.json();
                    const txt = j?.output?.map(o => (o?.content || []).map(c => c?.text || "").join("")).join("") || "";
                    finalNonSys = [{ role: "user", content: "=== COMPRESSED CONTEXT ===\n" + txt + "\n=== END ===" }, ...recentMsgs];
                    console.log("[openai] summarized:", finalNonSys.length, "msgs");
                    resetHistory(sessionKey);
                } else { finalNonSys = recentMsgs; }
            } catch { finalNonSys = recentMsgs; }
        }
        messages = [...finalSysMsgs, ...finalNonSys];
    }

    console.log("[openai] model=", incoming.model, "msgs=", messages.length, "est=", est);

    // 4. Save session
    session.set(sessionKey, { messages: finalNonSys });

    // 5. Tools
    const tools = normalizeOpenAITools(incoming.tools);
    const origParams = buildOriginalParamsMap(incoming.tools);
    console.log("[openai] tools:", (incoming.tools || []).map(t => t?.function?.name || t?.name || "?").join(", "));

    // 5b. Inject merge-tool prompt
    messages = injectMergeToolPromptOpenAI(messages, incoming.tools, config);

    // 6. Convert → Responses API
    let responsesInput = mergeConsecutiveAssistant(chatCompletionsToResponsesInput(messages));
    const body = { model: incoming.model, stream: !!stream, input: responsesInput };
    if (incoming.temperature !== undefined) body.temperature = incoming.temperature;
    if (incoming.max_tokens !== undefined) body.max_output_tokens = incoming.max_tokens;
    if (incoming.max_completion_tokens !== undefined) body.max_output_tokens = incoming.max_completion_tokens;
    if (Array.isArray(tools) && tools.length > 0) body.tools = enrichToolsForResponsesAPI(tools, origParams);
    if (incoming.tool_choice !== undefined) body.tool_choice = incoming.tool_choice;
    if (incoming.parallel_tool_calls !== undefined) body.parallel_tool_calls = incoming.parallel_tool_calls;

    console.log("[openai] body keys:", Object.keys(body).join(", "), "tool_choice=", body.tool_choice ?? "(none)");

    // 7. Forward
    const responsesUrl = openaiUrl.replace(/\/chat\/completions$/, "/responses");
    console.log("[openai] ->", responsesUrl);
    const upRes = await fetch(responsesUrl, {
        method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
        body: JSON.stringify(body),
    });
    console.log("[openai] status:", upRes.status);

    if (!upRes.ok) {
        const t = await upRes.text().catch(() => "");
        console.log("[openai] ERROR:", t.slice(0, 300));
        if ([502, 504, 529].includes(upRes.status)) { resetHistory(sessionKey); session.remove(sessionKey); }
        if (res.headersSent) return res.end();
        return res.status(upRes.status).send(t || "Error " + upRes.status);
    }

    // 8. Stream
    if (stream) {
        const { assistantText, assistantToolCalls } = await streamResponsesAPIToChat(upRes, res, { chatId: "chatcmpl-" + Date.now(), model: incoming.model });
        const msg = { role: "assistant", content: assistantText || null };
        if (assistantToolCalls.length > 0) msg.tool_calls = assistantToolCalls;
        session.commitAssistantTurn(sessionKey, msg, "openai");
        console.log("[openai] committed, total=", (session.get(sessionKey)?.messages?.length || 0));
        return;
    }

    // Non-stream
    const json = await upRes.json();
    if (res.headersSent) return res.end();
    return res.json(json);
}

module.exports = { handleOpenAI };
