/**
 * Shared utility functions used across handlers.
 */

function stableHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
}

function extractText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter(b => b?.type === "text").map(b => b.text).join("\n");
}

function getLastUserHash(messages) {
    if (!Array.isArray(messages)) return "";
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role !== "user") continue;
        let sig = extractText(messages[i].content);
        if (Array.isArray(messages[i].content)) {
            for (const b of messages[i].content) {
                if (b?.type === "tool_result") sig += "|tr:" + String(b.content || "").slice(0, 512);
            }
        }
        return stableHash(sig);
    }
    return "";
}

function dropOrphanToolResults(msgs) {
    if (!Array.isArray(msgs)) return msgs;
    const tuIds = new Set();
    for (const m of msgs) { if (Array.isArray(m?.content)) for (const b of m.content) if (b?.type === "tool_use" && b.id) tuIds.add(b.id); }
    return msgs.map(m => {
        if (!Array.isArray(m?.content)) return m;
        const f = m.content.filter(b => b?.type !== "tool_result" || tuIds.has(b.tool_use_id));
        return f.length === 0 ? null : f.length === m.content.length ? m : { ...m, content: f };
    }).filter(Boolean);
}

function injectMissingToolResults(msgs) {
    if (!Array.isArray(msgs)) return { messages: msgs };
    const answered = new Set();
    for (const m of msgs) if (Array.isArray(m?.content)) for (const b of m.content) if (b?.type === "tool_result") answered.add(b.tool_use_id);
    let lastAIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "assistant") { lastAIdx = i; break; }
    if (lastAIdx === -1) return { messages: msgs };
    const unanswered = (msgs[lastAIdx]?.content || []).filter(b => b?.type === "tool_use" && b.id && !answered.has(b.id)).map(b => b.id);
    if (!unanswered.length) return { messages: msgs };
    const result = [...msgs];
    result.splice(lastAIdx + 1, 0, { role: "user", content: unanswered.map(id => ({ type: "tool_result", tool_use_id: id, content: "[interrupted]" })) });
    return { messages: result };
}

function trimMessages(msgs) {
    if (!Array.isArray(msgs)) return msgs;
    return msgs.map(m => {
        if (!Array.isArray(m?.content)) return m;
        return {
            ...m, content: m.content.map(b => {
                if (b?.type === "text" && typeof b.text === "string" && b.text.length > 30000) return { ...b, text: b.text.slice(0, 30000) + "\n…[trimmed]" };
                if (b?.type === "tool_result" && typeof b.content === "string" && b.content.length > 20000) return { ...b, content: b.content.slice(0, 20000) + "\n…[trimmed]" };
                return b;
            })
        };
    });
}

function claudeMsgSig(m) {
    if (!m) return "null";
    const text = extractText(m.content).slice(0, 4000);
    let hint = "";
    if (Array.isArray(m.content)) {
        const tu = m.content.filter(b => b?.type === "tool_use").map(b => b.name || "?");
        const tr = m.content.filter(b => b?.type === "tool_result").length;
        if (tu.length) hint = "|tu:" + tu.join(",");
        if (tr) hint += "|tr:" + tr;
    }
    return `${m.role || ""}|${stableHash(text)}${hint}`;
}

function mergeClaudeSession(sess, incoming) {
    if (!sess?.messages?.length) return { merged: incoming || [], appended: 0 };
    const base = sess.messages;
    const inc = Array.isArray(incoming) ? incoming : [];
    if (!inc.length) return { merged: base, appended: 0 };
    let p = 0;
    while (p < base.length && p < inc.length && claudeMsgSig(base[p]) === claudeMsgSig(inc[p])) p++;
    if (p === 0) return { merged: inc, appended: 0 };
    if (p >= inc.length) return { merged: base, appended: 0 };
    return { merged: [...base, ...inc.slice(p)], appended: inc.length - p };
}

function buildState({ providerModel, originalModel, toolNameMap, trimDelta = 0, config }) {
    return {
        messageId: `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        providerModel, clientModel: config.REVERSE_MODEL_MAP?.[providerModel] || originalModel,
        toolNameMap, trimDelta, toolCalls: new Map(), toolCallIndex: 0, serverToolBlockIndex: -1,
        inThinkingBlock: false, currentThinkingIndex: -1, finishReason: null, finishReasonSent: false, usage: null,
    };
}

module.exports = {
    stableHash,
    extractText,
    getLastUserHash,
    dropOrphanToolResults,
    injectMissingToolResults,
    trimMessages,
    claudeMsgSig,
    mergeClaudeSession,
    buildState,
};
