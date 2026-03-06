/**
 * Session Manager — conversation history cache.
 * Used by both Claude and OpenAI handlers.
 */

const SESSION = new Map();
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [k, v] of SESSION.entries()) {
    if (!v?.updatedAt || now - v.updatedAt > SESSION_TTL_MS) SESSION.delete(k);
  }
}

function get(key) { return SESSION.get(key); }

function set(key, data) {
  SESSION.set(key, { ...data, updatedAt: Date.now() });
}

function remove(key) { SESSION.delete(key); }

function getSessionKey(req, incoming) {
  return (
    incoming?.metadata?.user_id ||
    req.headers["x-user-id"] ||
    req.headers["x-cursor-user-id"] ||
    req.ip ||
    "anon"
  );
}

/**
 * Commit assistant turn to session.
 * @param {string} key - session key
 * @param {object} content - content blocks (claude) or message object (openai)
 * @param {"claude"|"openai"} format
 */
function commitAssistantTurn(key, content, format = "claude") {
  const cur = SESSION.get(key);
  if (!cur) return;
  const tail = cur.messages[cur.messages.length - 1];
  if (tail?.role === "assistant") return;
  if (!content || (Array.isArray(content) && content.length === 0)) return;

  let msg;
  if (format === "claude") {
    msg = { role: "assistant", content }; // content = [{type:"text",...}, {type:"tool_use",...}]
  } else {
    msg = content; // already a {role:"assistant", content, tool_calls} object
  }

  SESSION.set(key, {
    ...cur,
    messages: [...cur.messages, msg],
    updatedAt: Date.now(),
  });
}

module.exports = { cleanup, get, set, remove, getSessionKey, commitAssistantTurn };
