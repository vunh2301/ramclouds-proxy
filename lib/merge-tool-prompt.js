/**
 * Merge Tool Calls — inject system prompt to force AI to batch
 * multiple similar tool calls (e.g. shell commands) into one.
 *
 * Enable via MERGE_TOOL_CALLS=1 in .env
 */

const MERGE_PROMPT = `
<tool_optimization>
CRITICAL EFFICIENCY RULE — You MUST follow this to minimize API round-trips:

When you need to run multiple shell/terminal commands, ALWAYS combine them into a SINGLE tool call using && or ; operators instead of making separate calls.

BAD (wastes 3 API calls):
- tool_call: sh("ls src/")
- tool_call: sh("cat package.json")
- tool_call: sh("git status")

GOOD (1 API call):
- tool_call: sh("ls src/ && cat package.json && git status")

Rules:
1. Combine independent read-only commands with && (ls, cat, grep, find, git status, git log, etc.)
2. For commands that might fail, use ; instead of && so subsequent commands still run
3. If commands have dependencies (output of one feeds into another), use pipes | or $() substitution
4. NEVER split file reads into separate tool calls — combine: cat file1.txt && cat file2.txt
5. For parallel file searches: find . -name "*.ts" -o -name "*.js" instead of separate finds
6. When reading multiple files, use a single command: cat file1 file2 file3 or use a for loop
7. This applies to ALL shell-like tools: sh, bash, shell, terminal, run_command, execute_command, run_terminal_command

This saves tokens and reduces latency significantly. Combine aggressively.
</tool_optimization>
`.trim();

/**
 * Inject merge-tool prompt into Claude system blocks.
 * @param {Array|string} system - existing system
 * @param {Array} tools - tool definitions to check if shell tools exist
 * @param {object} config
 * @returns {Array|string} modified system
 */
function injectMergeToolPrompt(system, tools, config) {
  if (!config.MERGE_TOOL_CALLS) return system;

  // Only inject if request actually has shell-like tools
  const mergeNames = new Set(config.MERGE_TOOL_NAMES);
  const hasShellTool = Array.isArray(tools) && tools.some(t => {
    const name = t?.name || t?.function?.name || "";
    return mergeNames.has(name);
  });
  if (!hasShellTool) return system;

  // Inject into system
  if (typeof system === "string") {
    return system + "\n\n" + MERGE_PROMPT;
  }
  if (Array.isArray(system)) {
    return [...system, { type: "text", text: MERGE_PROMPT }];
  }
  return [{ type: "text", text: MERGE_PROMPT }];
}

/**
 * Inject merge-tool prompt into OpenAI messages (prepend to system messages).
 * @param {Array} messages - chat messages
 * @param {Array} tools - tool definitions
 * @param {object} config
 * @returns {Array} modified messages
 */
function injectMergeToolPromptOpenAI(messages, tools, config) {
  if (!config.MERGE_TOOL_CALLS) return messages;

  const mergeNames = new Set(config.MERGE_TOOL_NAMES);
  const hasShellTool = Array.isArray(tools) && tools.some(t => {
    const name = t?.name || t?.function?.name || "";
    return mergeNames.has(name);
  });
  if (!hasShellTool) return messages;

  // Find last system message and append, or prepend a new one
  const idx = messages.findLastIndex(m => m?.role === "system");
  if (idx >= 0) {
    const copy = [...messages];
    const sys = copy[idx];
    copy[idx] = { ...sys, content: (sys.content || "") + "\n\n" + MERGE_PROMPT };
    return copy;
  }
  return [{ role: "system", content: MERGE_PROMPT }, ...messages];
}

module.exports = { MERGE_PROMPT, injectMergeToolPrompt, injectMergeToolPromptOpenAI };
