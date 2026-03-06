/**
 * Session Merge — overlap-based merge for OpenAI-format messages.
 * Preserves all bug fixes: trailing user messages, client-side tool synthetic results, etc.
 */

const { isClientSideTool, getSyntheticResult } = require("../tool-enricher");

function stableHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function looseSig(m) {
  const role = m.role || "";
  if (role === "user") {
    const text = typeof m.content === "string" ? m.content.slice(0, 200) :
      Array.isArray(m.content) ? m.content.map(p => p?.text || p?.content || "").join("").slice(0, 200) : "";
    return "user|" + stableHash(text);
  }
  if (role === "tool") return "tool|" + (m.tool_call_id || "").slice(0, 16);
  return role;
}

function getTrailingNonToolMessages(inc, matchFn) {
  let lastToolIdx = -1;
  for (let i = inc.length - 1; i >= 0; i--) {
    if (inc[i]?.role === "tool" && matchFn(inc[i])) { lastToolIdx = i; break; }
  }
  if (lastToolIdx < 0 || lastToolIdx >= inc.length - 1) return [];
  return inc.slice(lastToolIdx + 1).filter(m => m && m.role !== "tool");
}

function mergeOpenAIWithSession(base, incoming) {
  if (!base?.length) return { merged: incoming || [], appended: 0, overlap: false };
  const inc = Array.isArray(incoming) ? incoming : [];
  if (!inc.length) return { merged: base, appended: 0, overlap: false };

  const baseToolIds = new Set();
  for (const m of base) { if (m?.role === "tool" && m.tool_call_id) baseToolIds.add(m.tool_call_id); }
  const basePendingIds = new Set();
  for (const m of base) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) { if (tc.id && !baseToolIds.has(tc.id)) basePendingIds.add(tc.id); }
    }
  }

  // 1. New tool results for pending calls
  const newToolResults = inc.filter(m => m?.role === "tool" && m.tool_call_id && basePendingIds.has(m.tool_call_id));
  if (newToolResults.length > 0) {
    console.log("[merge] +tool results for pending:", newToolResults.map(m => m.tool_call_id?.slice(0, 16)));
    const trailing = getTrailingNonToolMessages(inc, m => newToolResults.some(r => r.tool_call_id === m.tool_call_id));
    if (trailing.length) console.log("[merge] +trailing:", trailing.length, "msgs");
    return { merged: [...base, ...newToolResults, ...trailing], appended: newToolResults.length + trailing.length, overlap: true };
  }

  // 2. Orphan tool results
  const orphans = inc.filter(m => m?.role === "tool" && m.tool_call_id && !baseToolIds.has(m.tool_call_id) && !basePendingIds.has(m.tool_call_id));
  if (orphans.length > 0) {
    const synth = { role: "assistant", content: null, tool_calls: orphans.map(m => ({ id: m.tool_call_id, type: "function", function: { name: "Task", arguments: "{}" } })) };
    return { merged: [...base, synth, ...orphans], appended: orphans.length + 1, overlap: true };
  }

  // 3. Pending tool calls → inject synthetic results (client-side tools)
  if (basePendingIds.size > 0) {
    const pendingNames = new Map();
    for (const m of base) {
      if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) { if (tc.id && basePendingIds.has(tc.id)) pendingNames.set(tc.id, tc.function?.name || ""); }
      }
    }
    console.log("[merge] injecting synthetic for:", [...basePendingIds].map(id => (pendingNames.get(id) || "?") + "/" + id.slice(0, 12)));
    const synthetic = [...basePendingIds].map(id => ({
      role: "tool", tool_call_id: id, content: getSyntheticResult(pendingNames.get(id) || ""),
    }));
    const lastToolIdx = inc.map((m, i) => m?.role === "tool" ? i : -1).filter(i => i >= 0).pop() ?? -1;
    const trailing = lastToolIdx >= 0 ? inc.slice(lastToolIdx + 1).filter(m => m && m.role !== "tool") : inc.filter(m => m?.role === "user");
    if (trailing.length) console.log("[merge] +trailing after synthetic:", trailing.length);
    return { merged: [...base, ...synthetic, ...trailing], appended: synthetic.length + trailing.length, overlap: true };
  }

  // 4. Positional prefix match
  let prefixLen = 0;
  while (prefixLen < base.length && prefixLen < inc.length && looseSig(base[prefixLen]) === looseSig(inc[prefixLen])) prefixLen++;
  if (prefixLen > 0) {
    const suffix = inc.slice(prefixLen).filter(m => m?.role !== "tool" || !baseToolIds.has(m.tool_call_id));
    if (!suffix.length) return { merged: base, appended: 0, overlap: true };
    return { merged: [...base, ...suffix], appended: suffix.length, overlap: true };
  }

  // 5. No match — append last user message
  const lastUserIdx = inc.map(m => m?.role).lastIndexOf("user");
  if (lastUserIdx < 0) return { merged: base, appended: 0, overlap: false };
  const lastUserSig = looseSig(inc[lastUserIdx]);
  const baseLastUser = base.slice().reverse().find(m => m?.role === "user");
  if (baseLastUser && looseSig(baseLastUser) === lastUserSig) return { merged: base, appended: 0, overlap: false };
  return { merged: [...base, ...inc.slice(lastUserIdx)], appended: inc.length - lastUserIdx, overlap: false };
}

module.exports = { mergeOpenAIWithSession, looseSig, stableHash };
