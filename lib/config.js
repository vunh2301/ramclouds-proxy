const crypto = require("node:crypto");

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

function loadModelMap() {
  const raw = (process.env.MODEL_MAP_JSON || "").trim();
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
  } catch { }
  return {};
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
  const THINKING_BUDGET = toInt(process.env.THINKING_BUDGET, 4096);

  const RAM_SOFT_LIMIT_TOKENS = toInt(process.env.RAM_SOFT_LIMIT_TOKENS, 185000);
  const RAM_HARD_LIMIT_TOKENS = toInt(process.env.RAM_HARD_LIMIT_TOKENS, 188000);
  const KEEP_LAST_MESSAGES = toInt(process.env.KEEP_LAST_MESSAGES, 12);
  const SUMMARY_MAX_TOKENS = toInt(process.env.SUMMARY_MAX_TOKENS, 900);

  const SANITIZE_SYSTEM = toBool(process.env.SANITIZE_SYSTEM, true);
  const TRIM_TOOLS = toBool(process.env.TRIM_TOOLS, true);

  const MODEL_MAP = loadModelMap();
  const REVERSE_MODEL_MAP = Object.fromEntries(Object.entries(MODEL_MAP).map(([k, v]) => [v, k]));
  const EXTRA_MODEL_MAP = (process.env.EXTRA_MODEL_MAP || "").trim();

  const { origin: PROVIDER_ORIGIN, basePath: PROVIDER_BASEPATH } = normalizeBaseUrl(PROVIDER_BASE_URL_RAW);

  function providerEndpoint(pathAfterV1) {
    const v1Base = PROVIDER_BASEPATH && PROVIDER_BASEPATH.length > 0 ? PROVIDER_BASEPATH : "/v1";
    return joinUrl(PROVIDER_ORIGIN, v1Base, String(pathAfterV1 || "").replace(/^\/+/, ""));
  }

  return {
    PORT,
    PROVIDER_BASE_URL_RAW,
    PROVIDER_API_KEY,
    THINKING_BUDGET,
    RAM_SOFT_LIMIT_TOKENS,
    RAM_HARD_LIMIT_TOKENS,
    KEEP_LAST_MESSAGES,
    SUMMARY_MAX_TOKENS,
    SANITIZE_SYSTEM,
    TRIM_TOOLS,
    MODEL_MAP,
    REVERSE_MODEL_MAP,
    EXTRA_MODEL_MAP,
    PROVIDER_ORIGIN,
    PROVIDER_BASEPATH,
    OPENAI_BASE_URL,
    OPENAI_API_KEY,
    providerEndpoint,
    sha1,
  };
}

module.exports = { getConfig };
