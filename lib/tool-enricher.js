/**
 * Tool Enricher — Schema enrichment, unwrap, client-side tool detection.
 */

const KNOWN_TOOL_SCHEMAS = {
  ApplyPatch: {
    type: "object",
    properties: {
      patch: { type: "string", description: 'The complete patch content. MUST start with "*** Begin Patch" and end with "*** End Patch". Use \\n for newlines.' }
    },
    required: ["patch"], additionalProperties: false,
  },
  SwitchMode: {
    type: "object",
    properties: { target_mode_id: { type: "string", description: 'Mode to switch to (e.g. "agent", "ask", "edit")' } },
    required: ["target_mode_id"],
  },
  Task: {
    type: "object",
    properties: { description: { type: "string" }, prompt: { type: "string" } },
    required: ["description"],
  },
};

const CLIENT_SIDE_TOOLS = new Set(["CreatePlan", "Task", "ApplyPatch"]);

const UNWRAP_TOOLS = { ApplyPatch: "patch" };

function buildOriginalParamsMap(incomingTools) {
  const map = {};
  if (!Array.isArray(incomingTools)) return map;
  for (const t of incomingTools) {
    const n = t?.function?.name || t?.name || "";
    if (!n) continue;
    const p = t?.function?.parameters || t?.parameters || t?.input_schema || null;
    if (p && p.properties && Object.keys(p.properties).length > 0) map[n] = p;
  }
  return map;
}

function enrichToolsForResponsesAPI(normalizedTools, originalParamsMap) {
  if (!Array.isArray(normalizedTools)) return normalizedTools;
  return normalizedTools.map(t => {
    let name, description, parameters;
    if (t?.type === "function" && t.function) {
      name = t.function.name; description = t.function.description || ""; parameters = t.function.parameters || {};
    } else if (t?.name) {
      name = t.name; description = t.description || ""; parameters = t.input_schema || t.parameters || {};
    } else return t;

    // Restore original parameters if normalization stripped them
    if ((!parameters.properties || Object.keys(parameters.properties).length === 0) && originalParamsMap[name]) {
      console.log("[tools] restoring params for:", name);
      parameters = originalParamsMap[name];
    }
    // Enrich with known schemas
    if ((!parameters.properties || Object.keys(parameters.properties).length === 0) && KNOWN_TOOL_SCHEMAS[name]) {
      console.log("[tools] enriching schema for:", name);
      parameters = KNOWN_TOOL_SCHEMAS[name];
    }
    return { type: "function", name, description, parameters };
  });
}

function unwrapToolArguments(toolName, argsString) {
  const field = UNWRAP_TOOLS[toolName];
  if (!field) return argsString;
  try {
    const parsed = JSON.parse(argsString);
    if (typeof parsed?.[field] === "string") {
      console.log("[tools] unwrapped", toolName, "field:", field, "len=", parsed[field].length);
      return parsed[field];
    }
  } catch {}
  return argsString;
}

function isClientSideTool(name) { return CLIENT_SIDE_TOOLS.has(name); }

function getSyntheticResult(name) {
  if (name === "ApplyPatch") return "Patch applied successfully.";
  if (name === "CreatePlan") return "Plan created successfully. Now proceed to execute the plan steps.";
  if (name === "Task") return "Task completed.";
  return "Tool call was interrupted or cancelled. Please proceed without this result.";
}

module.exports = { KNOWN_TOOL_SCHEMAS, CLIENT_SIDE_TOOLS, buildOriginalParamsMap, enrichToolsForResponsesAPI, unwrapToolArguments, isClientSideTool, getSyntheticResult };
