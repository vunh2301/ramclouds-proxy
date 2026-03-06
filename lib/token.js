function estimateTokensFromText(s) {
  if (!s) return 0;
  const str = String(s);
  // Real-world calibration: proxy estimate was ~12% below actual Claude token count.
  // Adjusted from 3.6/1.05 to 3.2/1.12 to match observed ratio (150k actual / 134k est ≈ 1.12).
  const tokens = str.length / 3.2;
  return Math.ceil(tokens * 1.14); // vietnam token estimation
}

function estimateClaudeReqTokens(claudeReq) {
  let systemStr = "";
  let toolsStr = "";
  let msgStr = "";

  // system
  const sys = claudeReq.system;
  if (typeof sys === "string") systemStr += sys;
  else if (Array.isArray(sys)) {
    for (const b of sys) {
      if (!b) continue;
      if (b.type === "text") systemStr += b.text || "";
      else {
        try { systemStr += JSON.stringify(b); } catch { systemStr += String(b); }
      }
    }
  }

  // tools
  if (Array.isArray(claudeReq.tools)) {
    try { toolsStr += JSON.stringify(claudeReq.tools); } catch {}
  }

  // messages
  for (const m of claudeReq.messages || []) {
    const content = Array.isArray(m?.content) ? m.content : [];
    for (const b of content) {
      if (!b) continue;

      if (b.type === "text") msgStr += b.text || "";

      else if (b.type === "tool_result") {
        const c = b.content;
        if (typeof c === "string") msgStr += c;
        else {
          try { msgStr += JSON.stringify(c); } catch { msgStr += String(c); }
        }
      }

      else if (b.type === "tool_use") {
        try { msgStr += JSON.stringify(b.input || {}); } catch {}
      }

      else if (b.type === "image") {
        try { msgStr += JSON.stringify(b.source || {}); } catch {}
      }

      else {
        try { msgStr += JSON.stringify(b); } catch { msgStr += String(b); }
      }
    }
  }

  const systemTok = estimateTokensFromText(systemStr);
  const toolsTok = estimateTokensFromText(toolsStr);
  const messagesTok = estimateTokensFromText(msgStr);

  console.log("[proxy] est_breakdown tokens: system=", systemTok, "tools=", toolsTok, "messages=", messagesTok, "misc=", 16);

  return systemTok + toolsTok + messagesTok + 16;
}

module.exports = { estimateTokensFromText, estimateClaudeReqTokens };
