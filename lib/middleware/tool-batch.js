/**
 * Tool Result Batching Middleware
 *
 * When Claude responds with multiple tool_use blocks, the client (Cursor)
 * may send each tool result as a separate request. This middleware buffers
 * incomplete requests and waits for all tool results before forwarding,
 * saving upstream API calls.
 *
 * Enable via BATCH_TOOL_RESULTS=1 in .env
 */

const session = require("../session");

// Per-session pending request buffer
const pending = new Map();

/**
 * Count tool_use ids in the last assistant message and
 * tool_result ids that follow it.
 */
function countToolUseAndResults(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { useIds: new Set(), resultIds: new Set() };

  // Find last assistant message index
  let lastAIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i]?.role;
    if (role === "assistant") { lastAIdx = i; break; }
  }
  if (lastAIdx === -1) return { useIds: new Set(), resultIds: new Set() };

  // Collect tool_use ids from the last assistant message
  const useIds = new Set();
  const content = messages[lastAIdx]?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === "tool_use" && b.id) useIds.add(b.id);
    }
  }
  // OpenAI format: tool_calls array
  const toolCalls = messages[lastAIdx]?.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      if (tc?.id) useIds.add(tc.id);
    }
  }

  if (useIds.size === 0) return { useIds, resultIds: new Set() };

  // Collect tool_result / tool ids from messages after the assistant
  const resultIds = new Set();
  for (let i = lastAIdx + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    // OpenAI format: role=tool with tool_call_id
    if (m.role === "tool" && m.tool_call_id) {
      resultIds.add(m.tool_call_id);
      continue;
    }
    // Claude format: content blocks with type=tool_result
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === "tool_result" && b.tool_use_id) resultIds.add(b.tool_use_id);
      }
    }
  }

  return { useIds, resultIds };
}

function isIncomplete(messages) {
  const { useIds, resultIds } = countToolUseAndResults(messages);
  if (useIds.size === 0) return false;
  // Check if every tool_use has a matching result
  for (const id of useIds) {
    if (!resultIds.has(id)) return true;
  }
  return false;
}

/**
 * Express middleware factory.
 * @param {object} config - app config (needs BATCH_TOOL_RESULTS, BATCH_WINDOW_MS)
 */
function createToolBatchMiddleware(config) {
  if (!config.BATCH_TOOL_RESULTS) {
    // Disabled — pass through
    return (_req, _res, next) => next();
  }

  const windowMs = config.BATCH_WINDOW_MS;

  return function toolBatchMiddleware(req, res, next) {
    const incoming = req.body || {};
    const messages = incoming.messages;

    // Only batch if there are messages with incomplete tool results
    if (!Array.isArray(messages) || !isIncomplete(messages)) {
      // Complete or not tool-related — forward immediately
      // But first, check if there's a pending request for this session to cancel the timer
      const sessionKey = session.getSessionKey(req, incoming);
      const entry = pending.get(sessionKey);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(sessionKey);
        // The old request was incomplete but now we got a complete one — let the complete one through
        // Respond to old request with 204 (superseded)
        if (!entry.res.headersSent) {
          entry.res.status(204).end();
        }
        console.log("[batch] superseded incomplete request for session", sessionKey);
      }
      return next();
    }

    // Incomplete tool results — buffer this request
    const sessionKey = session.getSessionKey(req, incoming);
    const { useIds, resultIds } = countToolUseAndResults(messages);
    console.log(`[batch] incomplete tool results: ${resultIds.size}/${useIds.size} for session ${sessionKey}, waiting ${windowMs}ms`);

    // Cancel any previous pending request for this session
    const prev = pending.get(sessionKey);
    if (prev) {
      clearTimeout(prev.timer);
      if (!prev.res.headersSent) {
        prev.res.status(204).end();
      }
      console.log("[batch] replaced previous pending request");
    }

    // Set up new pending entry
    const timer = setTimeout(() => {
      const entry = pending.get(sessionKey);
      if (!entry) return;
      pending.delete(sessionKey);
      const { useIds: u, resultIds: r } = countToolUseAndResults(entry.req.body?.messages);
      console.log(`[batch] timeout — forwarding with ${r.size}/${u.size} tool results`);
      entry.next();
    }, windowMs);

    pending.set(sessionKey, { req, res, next, timer });
  };
}

module.exports = { createToolBatchMiddleware, isIncomplete, countToolUseAndResults };
