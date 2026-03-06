const { injectImagesFromCursorTextBlocks } = require("./images");

const CLAUDE_OAUTH_TOOL_PREFIX = "";

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function tryParseJSON(str) {
  if (typeof str !== "string") return str;
  try { return JSON.parse(str); } catch { return str; }
}

function convertOpenAIToolChoice(choice) {
  if (!choice) return { type: "auto" };
  if (typeof choice === "object" && choice.type) return choice;
  if (choice === "auto" || choice === "none") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.function) return { type: "tool", name: choice.function.name };
  return { type: "auto" };
}

function pickMaxTokens(openaiBody) {
  if (typeof openaiBody.max_tokens === "number") return openaiBody.max_tokens;
  if (typeof openaiBody.max_completion_tokens === "number") return openaiBody.max_completion_tokens;
  return 1024;
}

function getContentBlocksFromMessage(msg) {
  const blocks = [];

  if (msg.role === "tool") {
    blocks.push({ type: "tool_result", tool_use_id: msg.tool_call_id, content: msg.content });
    return blocks;
  }

  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      const b = msg.content ? [{ type: "text", text: msg.content }] : [];
      return injectImagesFromCursorTextBlocks(b);
    }
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (!part) continue;
        if (part.type === "text" && part.text) blocks.push({ type: "text", text: part.text });
        else if (part.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            tool_use_id: part.tool_use_id,
            content: part.content,
            ...(part.is_error ? { is_error: true } : {}),
          });
        } else if (part.type === "image_url" && part.image_url?.url) {
          blocks.push({ type: "image", source: { type: "url", url: part.image_url.url } });
        }
      }
      return injectImagesFromCursorTextBlocks(blocks);
    }
    return blocks;
  }

  // assistant
  if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part) continue;
      if ((part.type === "text" || part.type === "output_text") && part.text) blocks.push({ type: "text", text: part.text });
      else if (part.type === "tool_use") blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
    }
  } else if (msg.content) {
    const text = typeof msg.content === "string" ? msg.content : extractTextContent(msg.content);
    if (text) blocks.push({ type: "text", text });
  }

  if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc && tc.type === "function" && tc.function) {
        const toolName = CLAUDE_OAUTH_TOOL_PREFIX + tc.function.name;
        blocks.push({ type: "tool_use", id: tc.id, name: toolName, input: tryParseJSON(tc.function.arguments) });
      }
    }
  }

  return blocks;
}

function openaiToClaudeRequest(openaiBody, stream, config) {
  const toolNameMap = new Map();

  const originalModel = openaiBody.model || "unknown-model";
  const providerModel = config.MODEL_MAP[originalModel] || originalModel;

  const result = {
    model: providerModel,
    max_tokens: pickMaxTokens(openaiBody),
    stream: !!stream,
  };

  if (openaiBody.temperature !== undefined) result.temperature = openaiBody.temperature;

  // System messages (from messages array AND from top-level system field)
  const systemParts = [];
  if (openaiBody.system) {
    if (typeof openaiBody.system === "string") systemParts.push(openaiBody.system);
    else if (Array.isArray(openaiBody.system)) systemParts.push(...openaiBody.system.map(s => typeof s === "string" ? s : (s?.text || "")));
  }
  const messages = Array.isArray(openaiBody.messages) ? openaiBody.messages : [];
  for (const msg of messages) {
    if (msg && msg.role === "system") {
      systemParts.push(typeof msg.content === "string" ? msg.content : extractTextContent(msg.content));
    }
  }

  const nonSystemMessages = messages.filter((m) => m && m.role !== "system");

  result.messages = [];
  let currentRole;
  let currentParts = [];

  const flushCurrentMessage = () => {
    if (currentRole && currentParts.length > 0) {
      result.messages.push({ role: currentRole, content: currentParts });
      currentParts = [];
    }
  };

  for (const msg of nonSystemMessages) {
    const newRole = msg.role === "user" || msg.role === "tool" ? "user" : "assistant";
    const blocks = getContentBlocksFromMessage(msg);

    const hasToolUse = blocks.some((b) => b.type === "tool_use");
    const hasToolResult = blocks.some((b) => b.type === "tool_result");

    if (hasToolResult) {
      const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");
      const otherBlocks = blocks.filter((b) => b.type !== "tool_result");

      flushCurrentMessage();
      if (toolResultBlocks.length > 0) result.messages.push({ role: "user", content: toolResultBlocks });
      if (otherBlocks.length > 0) {
        currentRole = newRole;
        currentParts.push(...otherBlocks);
      }
      continue;
    }

    if (currentRole !== newRole) {
      flushCurrentMessage();
      currentRole = newRole;
    }

    currentParts.push(...blocks);

    if (hasToolUse) flushCurrentMessage();
  }

  flushCurrentMessage();

  // Add cache_control to last assistant block (optional, helps caching if supported)
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i];
    if (message.role === "assistant" && Array.isArray(message.content) && message.content.length > 0) {
      const lastBlock = message.content[message.content.length - 1];
      if (lastBlock) {
        lastBlock.cache_control = { type: "ephemeral" };
        break;
      }
    }
  }

  // system field for Claude
  if (systemParts.length > 0) {
    const systemText = systemParts.join("\n");
    result.system = [{ type: "text", text: systemText, cache_control: { type: "ephemeral", ttl: "1h" } }];
  } else {
    result.system = [];
  }

  // Tools: OpenAI tools[] -> Claude tools[]
  if (Array.isArray(openaiBody.tools)) {
    result.tools = [];
    for (const tool of openaiBody.tools) {
      if (!tool) continue;
      const toolType = tool.type;
      if (toolType && toolType !== "function") {
        // Skip non-function tools that have no name (would cause 400 from Claude)
        if (!tool.name) continue;
        result.tools.push(tool);
        continue;
      }
      const toolData = toolType === "function" && tool.function ? tool.function : tool;
      const originalName = toolData.name;
      // Skip tools with empty or missing names
      if (!originalName) continue;
      const toolName = CLAUDE_OAUTH_TOOL_PREFIX + originalName;

      toolNameMap.set(toolName, originalName);

      result.tools.push({
        name: toolName,
        description: toolData.description || "",
        input_schema: toolData.parameters || toolData.input_schema || { type: "object", properties: {}, required: [] },
      });
    }
    if (result.tools.length > 0) result.tools[result.tools.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
  }

  // Tool choice
  if (openaiBody.tool_choice) result.tool_choice = convertOpenAIToolChoice(openaiBody.tool_choice);

  // Thinking
  if (openaiBody.thinking) {
    result.thinking = {
      type: openaiBody.thinking.type || "enabled",
      ...(openaiBody.thinking.budget_tokens ? { budget_tokens: openaiBody.thinking.budget_tokens } : {}),
      ...(openaiBody.thinking.max_tokens ? { max_tokens: openaiBody.thinking.max_tokens } : {}),
    };
  } else {
    result.thinking = { type: "enabled", budget_tokens: config.THINKING_BUDGET };
  }

  // Ensure max_tokens > thinking budget (otherwise 0 tokens left for response)
  const thinkingBudget = result.thinking?.budget_tokens || 0;
  if (thinkingBudget > 0 && result.max_tokens <= thinkingBudget) {
    result.max_tokens = thinkingBudget + 8192;
  }

  return { claudeBody: result, originalModel, providerModel, toolNameMap };
}

module.exports = { openaiToClaudeRequest };
