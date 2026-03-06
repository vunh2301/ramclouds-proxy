function systemBlocksToText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map(b => (b?.type === "text" ? b.text : "")).join("\n");
  return "";
}

function sanitizeSystemForUpstream(system) {
  const s = systemBlocksToText(system);
  if (!s) return system;

  const cleaned = s
    .replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>/g, "")
    .replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/g, "")
    .replace(/<mcp_file_system>[\s\S]*?<\/mcp_file_system>/g, "")
    .replace(/<terminal_files_information>[\s\S]*?<\/terminal_files_information>/g, "")
    .replace(/<tool_calling>[\s\S]*?<\/tool_calling>/g, "")
    .replace(/<citing_code>[\s\S]*?<\/citing_code>/g, "")
    .replace(/<mermaid_syntax>[\s\S]*?<\/mermaid_syntax>/g, "")
    .trim();

  if (typeof system === "string") return cleaned;
  if (Array.isArray(system)) return cleaned ? [{ type: "text", text: cleaned }] : [];
  return system;
}

module.exports = { systemBlocksToText, sanitizeSystemForUpstream };
