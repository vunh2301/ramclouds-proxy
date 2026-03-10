const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _cache = null; // { value, expiresAt }

function getSecretsFilePath() {
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, "amp", "secrets.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "amp", "secrets.json");
  }
  return path.join(os.homedir(), ".local", "share", "amp", "secrets.json");
}

function readSecretsFile() {
  const filePath = getSecretsFilePath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Get the amp upstream API key.
 * Precedence: explicitKey > AMP_API_KEY env > secrets file
 *
 * @param {string} [explicitKey] - config-provided key (highest priority)
 * @param {string} [ampUrl] - the AMP URL to look up in secrets (e.g. "https://ampcode.com")
 */
function getAmpSecret(explicitKey, ampUrl) {
  if (explicitKey) return explicitKey;

  const envKey = (process.env.AMP_API_KEY || "").trim();
  if (envKey) return envKey;

  // Check cache
  if (_cache && Date.now() < _cache.expiresAt) return _cache.value;

  // Read from file
  const secrets = readSecretsFile();
  if (!secrets || typeof secrets !== "object") {
    _cache = { value: "", expiresAt: Date.now() + CACHE_TTL_MS };
    return "";
  }

  // Try multiple key patterns
  const urls = [
    ampUrl,
    "https://ampcode.com/",
    "https://ampcode.com",
    "http://localhost:2301",
  ].filter(Boolean);

  let key = "";
  for (const u of urls) {
    const v = secrets["apiKey@" + u];
    if (typeof v === "string" && v.trim()) {
      key = v.trim();
      break;
    }
  }

  // Also check all keys if no match
  if (!key) {
    for (const [k, v] of Object.entries(secrets)) {
      if (k.startsWith("apiKey@") && typeof v === "string" && v.trim()) {
        key = v.trim();
        break;
      }
    }
  }

  _cache = { value: key, expiresAt: Date.now() + CACHE_TTL_MS };
  return key;
}

function invalidateCache() {
  _cache = null;
}

module.exports = {
  getSecretsFilePath,
  readSecretsFile,
  getAmpSecret,
  invalidateCache,
};
