const { systemBlocksToText } = require("./sanitize");

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function buildStructuredSummaryPrompt() {
  const summarizeSystem = `
You are a conversation compression engine for a coding agent.

Summarize the conversation history into a structured JSON object.

Return JSON with this schema:

{
  "goal": "current user objective",
  "decisions": ["important design choices"],
  "files": ["relevant file paths"],
  "commands": ["shell commands executed"],
  "errors": ["important errors"],
  "state": "current system state",
  "todo": ["next tasks"]
}

Rules:
- Do not invent information
- Keep it concise
- Prefer short entries
- Extract file paths exactly
- Extract commands exactly
- Output MUST be valid JSON only (no markdown, no backticks)
`.trim();

  return summarizeSystem;
}

async function callRamcloudsSummarize({ url, apiKey, model, system, oldMessages, maxTokens }) {
  const summarizeSystem = buildStructuredSummaryPrompt();

  function toText(m) {
    if (!m) return "";
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b) => {
          if (!b) return "";
          if (b.type === "text" && typeof b.text === "string") return b.text;
          if (b.type === "tool_use") return `[tool_use ${b.name || ""}]`;
          if (b.type === "tool_result") return `[tool_result]`;
          if (b.type === "image" || b.type === "image_url") return `[image]`;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    try { return JSON.stringify(m.content); } catch { return String(m.content); }
  }

  const transcript = (Array.isArray(oldMessages) ? oldMessages : [])
    .map((m) => {
      const role = m?.role || "unknown";
      const t = toText(m).trim();
      if (!t) return "";
      return `[${role}]\n${t}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const summarizeUser = {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "Summarize the conversation transcript below into the JSON schema.\n\n" +
          "--- TRANSCRIPT START ---\n" +
          transcript +
          "\n--- TRANSCRIPT END ---",
      },
    ],
  };

  const sysText = systemBlocksToText(system);
  const shortSys = sysText ? [{ type: "text", text: sysText.slice(0, 8000) }] : [];

  const body = {
    model,
    tools: [],
    tool_choice: { type: "none" },
    max_tokens: maxTokens,
    stream: false,
    system: [{ type: "text", text: summarizeSystem }, ...shortSys],
    messages: [summarizeUser],
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`summarize failed ${resp.status}: ${t}`);
  }

  const json = await resp.json();
  const text =
    Array.isArray(json?.content)
      ? json.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("")
      : "";

  const parsed = safeJsonParse(text.trim());
  if (parsed) return parsed;

  return { state: text.trim() };
}

function makeSummarySystemMessage(summaryObj) {
  // IMPORTANT: Claude messages array only allows role "user" or "assistant".
  // "system" role in messages array is invalid and will cause 400 errors.
  // The summary is injected as a user message with a clear marker.
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "=== COMPRESSED CONVERSATION CONTEXT ===\n" +
          JSON.stringify(summaryObj, null, 2) +
          "\n=== END CONTEXT ===\n\n" +
          "[Previous conversation has been summarized above. Continue from this context.]",
      },
    ],
  };
}

function splitForSummarize(messages, keepLastN) {
  // Keep enough recent messages to ensure valid tool_use/tool_result pairing.
  // Minimum keep = 6 to always have at least one full tool cycle + user turn.
  const n = Math.max(6, keepLastN || 8);
  if (!Array.isArray(messages) || messages.length <= n) return { old: [], recent: messages || [] };

  const getToolUseIds = (msgs) => {
    const s = new Set();
    for (const m of msgs) {
      for (const b of (m?.content || [])) {
        if (b?.type === "tool_use" && typeof b.id === "string") s.add(b.id);
      }
    }
    return s;
  };

  const getToolResultIds = (msgs) => {
    const s = new Set();
    for (const m of msgs) {
      for (const b of (m?.content || [])) {
        if (b?.type === "tool_result" && typeof b.tool_use_id === "string") s.add(b.tool_use_id);
      }
    }
    return s;
  };

  let cut = messages.length - n;
  // Walk cut back until recent slice has no orphan tool_results
  while (cut > 0) {
    const recent = messages.slice(cut);
    const useIds = getToolUseIds(recent);
    const resultIds = getToolResultIds(recent);
    let ok = true;
    for (const id of resultIds) {
      if (!useIds.has(id)) { ok = false; break; }
    }
    if (ok) break;
    cut -= 1;
  }

  // Also ensure cut point never lands mid-assistant-turn:
  // if messages[cut] is a user message with tool_results but messages[cut-1]
  // is the matching assistant turn, move cut back to include the assistant too.
  if (cut > 0) {
    const firstRecent = messages[cut];
    const hasToolResult = Array.isArray(firstRecent?.content) &&
      firstRecent.content.some((b) => b?.type === "tool_result");
    if (hasToolResult) {
      // Scan back to find the matching assistant tool_use message
      const resultIds = new Set(
        (firstRecent.content || [])
          .filter((b) => b?.type === "tool_result")
          .map((b) => b.tool_use_id)
          .filter(Boolean)
      );
      for (let i = cut - 1; i >= 0; i--) {
        const m = messages[i];
        const hasMatchingUse = Array.isArray(m?.content) &&
          m.content.some((b) => b?.type === "tool_use" && resultIds.has(b.id));
        if (hasMatchingUse) {
          cut = i; // include this assistant message in recent
          break;
        }
      }
    }
  }

  return { old: messages.slice(0, cut), recent: messages.slice(cut) };
}

module.exports = {
  callRamcloudsSummarize,
  makeSummarySystemMessage,
  splitForSummarize,
};
