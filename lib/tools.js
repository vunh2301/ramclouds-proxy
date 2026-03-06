function trimToolsForUpstream(tools) {
  if (!Array.isArray(tools)) return tools;
  // Keep only the minimum Claude tool fields: name + input_schema (plus description only if short)
  return tools.map(t => {
    if (!t || typeof t !== "object") return t;
    const out = {};
    if (t.name) out.name = t.name;
    if (t.input_schema) out.input_schema = t.input_schema;
    // keep description only if short to avoid token bloat
    if (typeof t.description === "string" && t.description.length <= 240) out.description = t.description;
    // keep type if this is a non-function tool object
    if (t.type && !out.name) out.type = t.type;
    // keep cache_control if present
    if (t.cache_control) out.cache_control = t.cache_control;
    return out;
  });
}
function normalizeOpenAITools(tools) {
  if (!Array.isArray(tools)) return undefined;

  const normalized = [];

  for (const t of tools) {
    if (!t || typeof t !== "object") continue;

    // Already in Chat Completions style: { type: "function", function: {...} }
    if (t.type === "function" && t.function && typeof t.function === "object") {
      const fn = t.function;
      if (!fn.name) continue;

      normalized.push({
        type: "function",
        function: {
          name: String(fn.name),
          description: fn.description || "",
          parameters: fn.parameters && typeof fn.parameters === "object"
            ? fn.parameters
            : { type: "object", properties: {} },
        },
      });
      continue;
    }

    // Claude/tool schema style: { name, description, input_schema }
    if (t.name) {
      normalized.push({
        type: "function",
        function: {
          name: String(t.name),
          description: t.description || "",
          parameters: t.input_schema && typeof t.input_schema === "object"
            ? t.input_schema
            : { type: "object", properties: {} },
        },
      });
      continue;
    }

    // Some clients may send function fields at top-level
    if (t.function && t.function.name) {
      normalized.push({
        type: "function",
        function: {
          name: String(t.function.name),
          description: t.function.description || t.description || "",
          parameters: t.function.parameters && typeof t.function.parameters === "object"
            ? t.function.parameters
            : (t.input_schema && typeof t.input_schema === "object"
                ? t.input_schema
                : { type: "object", properties: {} }),
        },
      });
    }
  }

  return normalized.length ? normalized : undefined;
}
module.exports = { trimToolsForUpstream, normalizeOpenAITools };
