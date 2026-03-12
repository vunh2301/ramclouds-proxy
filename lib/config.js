const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function toInt(v, d) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : d;
}
function toBool(v, d = false) {
  if (v === undefined || v === null) return d;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return d;
}
function toList(v, fallback = "") {
  const raw = String(v ?? fallback);
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}
function normalizeBaseUrl(u) {
  if (!u) return { origin: "", basePath: "" };
  const trimmed = String(u).trim().replace(/\/+$/, "");
  const m = trimmed.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
  if (!m) return { origin: trimmed, basePath: "" };
  return { origin: m[1], basePath: (m[2] || "").replace(/\/+$/, "") };
}
function joinUrl(origin, ...parts) {
  const s = [origin, ...parts].filter(Boolean).map(String).join("/");
  return s.replace(/([^:]\/)\/+/g, "$1");
}

function loadJsonObject(raw, label) {
  const src = (raw || "").trim();
  if (!src) return {};
  try {
    const obj = JSON.parse(src);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch (e) {
    console.log(`[config] ${label} parse error:`, e?.message);
  }
  return {};
}

function loadModelMap() {
  return loadJsonObject(process.env.MODEL_MAP_JSON, "MODEL_MAP_JSON");
}

function stripJsoncComments(text) {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Load amp-models.jsonc → parse "role/model": [fallbacks] format.
 * Returns { modelMap: {model: primary}, fallbackMap: {model: [chain]}, roles: {model: role} }
 */
function loadAmpModelMap() {
  // Try JSONC file first
  const filePaths = [
    path.join(process.cwd(), "amp-models.jsonc"),
    path.join(process.cwd(), "amp-models.json"),
  ];

  let raw = "";
  for (const fp of filePaths) {
    try {
      raw = fs.readFileSync(fp, "utf8");
      console.log("[config] loaded AMP model map from", fp);
      break;
    } catch { /* try next */ }
  }

  // Fallback to env var
  if (!raw) {
    raw = (process.env.AMP_MODEL_MAP_JSON || "").trim();
  }

  if (!raw) return { modelMap: {}, fallbackMap: {}, roles: {} };

  let parsed;
  try {
    parsed = JSON.parse(stripJsoncComments(raw));
  } catch (e) {
    console.log("[config] AMP model map parse error:", e?.message);
    return { modelMap: {}, fallbackMap: {}, roles: {} };
  }

  const modelMap = {};
  const fallbackMap = {};
  const roles = {};

  for (const [key, value] of Object.entries(parsed)) {
    // key format: "role/model" or just "model"
    const slashIdx = key.indexOf("/");
    const role = slashIdx >= 0 ? key.slice(0, slashIdx) : "";
    const model = slashIdx >= 0 ? key.slice(slashIdx + 1) : key;

    if (!model) continue;

    const chain = Array.isArray(value) ? value.filter(v => typeof v === "string" && v.trim()) : (typeof value === "string" ? [value] : []);
    if (chain.length === 0) continue;

    modelMap[model] = chain[0]; // primary
    fallbackMap[model] = chain;
    if (role) roles[model] = role;
  }

  return { modelMap, fallbackMap, roles };
}

function loadAmpModePresets() {
  const defaults = {
    smart: {},
    deep: {
      reasoning: { effort: "high" },
      parallel_tool_calls: true,
    },
    fast: {
      reasoning: { effort: "low" },
      parallel_tool_calls: false,
    },
    plan: {
      reasoning: { effort: "medium" },
      tool_choice: "required",
      parallel_tool_calls: false,
    },
  };

  const custom = loadJsonObject(process.env.AMP_MODE_MAP_JSON, "AMP_MODE_MAP_JSON");
  const merged = { ...defaults };
  for (const [mode, preset] of Object.entries(custom)) {
    if (preset && typeof preset === "object" && !Array.isArray(preset)) {
      merged[mode] = { ...(merged[mode] || {}), ...preset };
    }
  }
  return merged;
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s || ""), "utf8").digest("hex");
}

function getConfig() {
  const PORT = toInt(process.env.PORT, 8080);
  const PROVIDER_BASE_URL_RAW = (process.env.PROVIDER_BASE_URL || "").trim();
  const PROVIDER_API_KEY = (process.env.PROVIDER_API_KEY || "").trim();
  const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "").trim();
  const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
  const OPENAI_MODEL_MAP = loadJsonObject(process.env.OPENAI_MODEL_MAP, "OPENAI_MODEL_MAP");
  const PROVIDER_MODE_RAW = (process.env.PROVIDER_MODE || "ramclouds").trim().toLowerCase();
  const PROVIDER_MODE = ["ramclouds", "openai", "auto"].includes(PROVIDER_MODE_RAW) ? PROVIDER_MODE_RAW : "ramclouds";
  // Thinking level: low=2048, medium=8192, high=32768, or custom via THINKING_BUDGET
  const THINKING_LEVEL_MAP = { low: 2048, medium: 8192, high: 32768 };
  const THINKING_LEVEL = (process.env.THINKING_LEVEL || "").trim().toLowerCase();
  const THINKING_BUDGET = THINKING_LEVEL_MAP[THINKING_LEVEL]
    || toInt(process.env.THINKING_BUDGET, 8192);
  // Reasoning effort for OpenAI Responses API (maps from THINKING_LEVEL)
  const REASONING_EFFORT = THINKING_LEVEL || "medium"; // low | medium | high

  const RAM_SOFT_LIMIT_TOKENS = toInt(process.env.RAM_SOFT_LIMIT_TOKENS, 185000);
  const RAM_HARD_LIMIT_TOKENS = toInt(process.env.RAM_HARD_LIMIT_TOKENS, 188000);
  const KEEP_LAST_MESSAGES = toInt(process.env.KEEP_LAST_MESSAGES, 12);
  const SUMMARY_MAX_TOKENS = toInt(process.env.SUMMARY_MAX_TOKENS, 900);

  const SANITIZE_SYSTEM = toBool(process.env.SANITIZE_SYSTEM, true);
  const TRIM_TOOLS = toBool(process.env.TRIM_TOOLS, true);

  const BATCH_TOOL_RESULTS = toBool(process.env.BATCH_TOOL_RESULTS, false);
  const BATCH_WINDOW_MS = toInt(process.env.BATCH_WINDOW_MS, 350);

  const MERGE_TOOL_CALLS = toBool(process.env.MERGE_TOOL_CALLS, false);
  const MERGE_TOOL_NAMES = toList(process.env.MERGE_TOOL_NAMES, "sh,bash,shell,terminal,run_command,execute_command,run_terminal_command");

  const MODEL_MAP = loadModelMap();
  const REVERSE_MODEL_MAP = Object.fromEntries(Object.entries(MODEL_MAP).map(([k, v]) => [v, k]));
  const EXTRA_MODEL_MAP = (process.env.EXTRA_MODEL_MAP || "").trim();

  const { modelMap: AMP_MODEL_MAP, fallbackMap: AMP_FALLBACK_MAP, roles: AMP_MODEL_ROLES } = loadAmpModelMap();
  const AMP_DEFAULT_MODEL = (process.env.AMP_DEFAULT_MODEL || "").trim() || null;

  const AMP_ENABLED = toBool(process.env.AMP_ENABLED, true);
  const AMP_PREFIXES = toList(process.env.AMP_PREFIXES, "amp-");
  const AMP_DEFAULT_MODE = (process.env.AMP_DEFAULT_MODE || "smart").trim() || "smart";
  const AMP_ALLOWED_MODES = toList(process.env.AMP_ALLOWED_MODES, "smart,deep,fast,plan");
  const AMP_MODE_SOURCE_RAW = (process.env.AMP_MODE_SOURCE || "both").trim().toLowerCase();
  const AMP_MODE_SOURCE = ["metadata", "body", "both"].includes(AMP_MODE_SOURCE_RAW) ? AMP_MODE_SOURCE_RAW : "both";
  const AMP_MODE_FIELD = (process.env.AMP_MODE_FIELD || "mode").trim() || "mode";
  const AMP_ATTACH_MODE_TAG = toBool(process.env.AMP_ATTACH_MODE_TAG, true);
  const AMP_MODE_MAP_JSON = (process.env.AMP_MODE_MAP_JSON || "").trim();
  const AMP_MODE_PRESETS = loadAmpModePresets();

  const AMP_PROXY_ENABLED = toBool(process.env.AMP_PROXY_ENABLED, false);
  const AMP_BASE_URL = (process.env.AMP_BASE_URL || "").trim();
  const AMP_ACCESS_TOKEN = (process.env.AMP_ACCESS_TOKEN || "").trim();
  const AMP_INBOUND_API_KEYS_RAW = (process.env.AMP_INBOUND_API_KEYS || "").trim();
  const AMP_INBOUND_API_KEYS = toList(AMP_INBOUND_API_KEYS_RAW || AMP_ACCESS_TOKEN, "");
  const AMP_REQUIRE_LOCALHOST = toBool(process.env.AMP_REQUIRE_LOCALHOST, false);
  const AMP_UPSTREAM_API_KEY = (process.env.AMP_UPSTREAM_API_KEY || AMP_ACCESS_TOKEN || "").trim();
  const AMP_TIMEOUT_MS = toInt(process.env.AMP_TIMEOUT_MS, 60000);

  const AMP_CLI_ENABLED = toBool(process.env.AMP_CLI_ENABLED, false);
  const AMP_CLI_COMMAND = (process.env.AMP_CLI_COMMAND || "amp").trim() || "amp";
  const AMP_CLI_LOGIN_TIMEOUT_MS = toInt(process.env.AMP_CLI_LOGIN_TIMEOUT_MS, 480000);
  const AMP_CLI_SESSION_TTL_MS = toInt(process.env.AMP_CLI_SESSION_TTL_MS, 600000);
  const AMP_CLI_STATUS_RETENTION_MS = toInt(process.env.AMP_CLI_STATUS_RETENTION_MS, 120000);
  const AMP_CLI_MAX_CONCURRENT = Math.max(1, toInt(process.env.AMP_CLI_MAX_CONCURRENT, 1));

  const { origin: PROVIDER_ORIGIN, basePath: PROVIDER_BASEPATH } = normalizeBaseUrl(PROVIDER_BASE_URL_RAW);
  const { origin: AMP_ORIGIN, basePath: AMP_BASEPATH } = normalizeBaseUrl(AMP_BASE_URL);

  function providerEndpoint(pathAfterV1) {
    const v1Base = PROVIDER_BASEPATH && PROVIDER_BASEPATH.length > 0 ? PROVIDER_BASEPATH : "/v1";
    return joinUrl(PROVIDER_ORIGIN, v1Base, String(pathAfterV1 || "").replace(/^\/+/, ""));
  }

  function ampEndpoint(pathAfterBase) {
    return joinUrl(AMP_ORIGIN, AMP_BASEPATH, String(pathAfterBase || "").replace(/^\/+/, ""));
  }

  return {
    PORT,
    PROVIDER_BASE_URL_RAW,
    PROVIDER_API_KEY,
    THINKING_BUDGET,
    REASONING_EFFORT,
    RAM_SOFT_LIMIT_TOKENS,
    RAM_HARD_LIMIT_TOKENS,
    KEEP_LAST_MESSAGES,
    SUMMARY_MAX_TOKENS,
    SANITIZE_SYSTEM,
    TRIM_TOOLS,
    BATCH_TOOL_RESULTS,
    BATCH_WINDOW_MS,
    MERGE_TOOL_CALLS,
    MERGE_TOOL_NAMES,
    MODEL_MAP,
    REVERSE_MODEL_MAP,
    EXTRA_MODEL_MAP,
    PROVIDER_ORIGIN,
    PROVIDER_BASEPATH,
    OPENAI_BASE_URL,
    OPENAI_API_KEY,
    OPENAI_MODEL_MAP,
    PROVIDER_MODE,
    AMP_MODEL_MAP,
    AMP_FALLBACK_MAP,
    AMP_MODEL_ROLES,
    AMP_DEFAULT_MODEL,
    AMP_ENABLED,
    AMP_PREFIXES,
    AMP_DEFAULT_MODE,
    AMP_ALLOWED_MODES,
    AMP_MODE_SOURCE,
    AMP_MODE_FIELD,
    AMP_ATTACH_MODE_TAG,
    AMP_MODE_MAP_JSON,
    AMP_MODE_PRESETS,
    AMP_PROXY_ENABLED,
    AMP_BASE_URL,
    AMP_ACCESS_TOKEN,
    AMP_INBOUND_API_KEYS,
    AMP_REQUIRE_LOCALHOST,
    AMP_UPSTREAM_API_KEY,
    AMP_TIMEOUT_MS,
    AMP_CLI_ENABLED,
    AMP_CLI_COMMAND,
    AMP_CLI_LOGIN_TIMEOUT_MS,
    AMP_CLI_SESSION_TTL_MS,
    AMP_CLI_STATUS_RETENTION_MS,
    AMP_CLI_MAX_CONCURRENT,
    AMP_ORIGIN,
    AMP_BASEPATH,
    providerEndpoint,
    ampEndpoint,
    sha1,
  };
}

module.exports = { getConfig };
