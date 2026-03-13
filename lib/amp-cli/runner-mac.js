// Mac/Linux version of amp CLI runner
// Spawns bun directly (same approach as Windows runner.js)
// Does NOT share code with runner.js to avoid cross-platform interference

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const state = require("./state");
const { invalidateCache: invalidateSecretCache, getSecretsFilePaths } = require("./secret");

const AMP_BROWSER_HOST = "ampcode.com";

function redactSensitive(text) {
  return String(text || "")
    .replace(/\b(sk|rk|pk)-[a-zA-Z0-9_-]{10,}\b/g, "$1-***")
    .replace(/\b(sgamp_[a-zA-Z0-9_-]{16,})\b/g, "sgamp_***")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{8,}\b/gi, "$1***")
    .replace(/\b(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, "$1***")
    .replace(/\b(token\s*[:=]\s*)[^\s,;]+/gi, "$1***");
}

function appendLogTail(prev, nextChunk, limit = 1200) {
  const merged = `${prev || ""}${nextChunk || ""}`;
  return merged.slice(-limit);
}

function resolveAmpBun() {
  // Resolve amp CLI to bun directly, bypassing shell wrapper
  // Mac: amp (shell script) → bun run ... main.js
  try {
    const ampHome = process.env.AMP_HOME || path.join(os.homedir(), ".amp");
    const bunPath = path.join(ampHome, "bin", "bun");
    const mainJs = path.join(ampHome, "package", "dist", "main.js");
    const pkgDir = path.join(ampHome, "package");
    if (fs.existsSync(bunPath) && fs.existsSync(mainJs)) {
      return { bunPath, mainJs, pkgDir, ampHome };
    }
  } catch { /* fallback */ }
  return null;
}

function getSpawnSpec(command, action) {
  const bun = resolveAmpBun();
  if (bun) {
    return {
      command: bun.bunPath,
      args: ["run", "--cwd", bun.pkgDir, bun.mainJs, action],
      extraEnv: {
        AMP_HOME: bun.ampHome,
        AMP_PWD: process.cwd(),
        AMP_RIPGREP_PATH: path.join(bun.ampHome, "bin", "rg"),
      },
    };
  }
  // Fallback: amp command directly
  return { command, args: [action] };
}

function createCleanEnv() {
  const env = { ...process.env };
  delete env.AMP_URL;
  delete env.AMP_API_KEY;
  return env;
}

function createLoginEnv() {
  const env = createCleanEnv();
  env.AMP_URL = `https://${AMP_BROWSER_HOST}`;
  return env;
}

function runAmpLogoutBestEffort(command) {
  try {
    const env = createLoginEnv();
    const spec = getSpawnSpec(command, "logout");
    const logoutEnv = { ...env, ...(spec.extraEnv || {}) };
    const t0 = Date.now();
    console.log("[amp-cli] logout: starting (timeout 5s)...");
    const result = spawnSync(spec.command, spec.args, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      env: logoutEnv,
      stdio: "ignore",
    });
    const elapsed = Date.now() - t0;
    console.log(`[amp-cli] logout: done in ${elapsed}ms (status=${result.status})`);
    if (result.error?.code === "ETIMEDOUT") {
      console.log("[amp-cli] logout timed out, killing stale amp processes");
      try {
        spawnSync("pkill", ["-f", "amp.*main.js"], { timeout: 3000, stdio: "ignore" });
      } catch { /* best effort */ }
    }
  } catch (err) {
    console.log(`[amp-cli] logout: exception: ${err?.message || err}`);
  }
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function extractFirstUrl(text) {
  const clean = stripAnsi(text);
  const m = clean.match(/https?:\/\/[^\s"'<>\x00-\x1f]+/i);
  return m ? m[0] : "";
}

function isLoginUrl(url) {
  try {
    const u = new URL(url);
    return (u.pathname && u.pathname !== "/") || u.search;
  } catch {
    return false;
  }
}

function normalizeBrowserUrl(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = (url.hostname || "").toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      url.hostname = AMP_BROWSER_HOST;
      return url.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

function maybeOpenBrowser(url) {
  const target = String(url || "").trim();
  if (!target) return;

  console.log("[amp-cli] browser: opening login URL");
  try {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    const browser = spawn(opener, [target], {
      detached: true,
      stdio: "ignore",
    });
    browser.unref();
  } catch (err) {
    console.log(`[amp-cli] browser: failed to open: ${err?.message || err}`);
  }
}

function extractAuthCode(text) {
  const s = String(text || "");
  const jwt = s.match(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/);
  if (jwt) return jwt[0];
  const m = s.match(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,}\b/i);
  return m ? m[0].toUpperCase() : "";
}

function parseStateFromLine(line, loginUrl, authCode) {
  const s = String(line || "").toLowerCase();
  if (!s.trim()) return null;

  if (
    s.includes("copy authentication code")
    || s.includes("paste authentication code")
    || s.includes("enter code")
    || s.includes("device code")
    || s.includes("verification code")
    || (s.includes("open") && (s.includes("browser") || s.includes("url")))
    || (s.includes("visit") && s.includes("http"))
    || (s.includes("waiting for") && s.includes("login"))
    || s.includes("go to")
  ) {
    const codeMsg = authCode ? ` Code: ${authCode}` : "";
    return {
      state: "awaiting_user",
      message: loginUrl
        ? `Open URL, approve login, then wait for verification.${codeMsg} ${loginUrl}`.trim()
        : `Waiting for user to complete AMP login in browser.${codeMsg}`.trim(),
    };
  }

  if (
    s.includes("verifying")
    || (s.includes("checking") && s.includes("session"))
    || (s.includes("authenticat") && !s.includes("failed"))
  ) {
    return { state: "verifying", message: "Verifying AMP CLI authentication." };
  }

  if (
    s.includes("login successful")
    || s.includes("authenticated")
    || s.includes("logged in")
    || (s.includes("successfully") && s.includes("login"))
  ) {
    return { state: "authenticated", message: "AMP CLI login succeeded." };
  }

  if (
    s.includes("error")
    || s.includes("failed")
    || s.includes("denied")
    || s.includes("unauthorized")
    || s.includes("timed out")
  ) {
    return { state: "failed", message: "AMP CLI login failed." };
  }

  return null;
}

function getSettingsPaths() {
  if (process.platform === "darwin") {
    return [
      path.join(os.homedir(), ".config", "amp", "settings.json"),
      path.join(os.homedir(), "Library", "Application Support", "amp", "settings.json"),
    ];
  }
  return [path.join(os.homedir(), ".config", "amp", "settings.json")];
}

function restoreSettingsUrl(proxyUrl) {
  for (const settingsPath of getSettingsPaths()) {
    try {
      if (!fs.existsSync(settingsPath)) continue;
      const raw = fs.readFileSync(settingsPath, "utf8");
      const obj = JSON.parse(raw.replace(/^\uFEFF/, ""));
      if (obj["amp.url"] === proxyUrl) continue;
      obj["amp.url"] = proxyUrl;
      fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2), "utf8");
      console.log(`[amp-cli] restored amp.url=${proxyUrl} in ${settingsPath}`);
    } catch {
      // best effort
    }
  }
}

function copySecretToProxy(proxyUrl) {
  const proxyKey = `apiKey@${proxyUrl.replace(/\/$/, "")}/`;
  for (const secretsPath of getSecretsFilePaths()) {
    try {
      if (!fs.existsSync(secretsPath)) continue;
      const raw = fs.readFileSync(secretsPath, "utf8");
      const secrets = JSON.parse(raw.replace(/^\uFEFF/, ""));
      let token = "";
      for (const [k, v] of Object.entries(secrets)) {
        if (k.startsWith("apiKey@") && v) { token = v; break; }
      }
      if (!token || secrets[proxyKey] === token) continue;
      secrets[proxyKey] = token;
      fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2), "utf8");
      console.log(`[amp-cli] copied token to ${proxyKey} in ${secretsPath}`);
    } catch {
      // best effort
    }
  }
}

function createAmpCliRunner(config) {
  const loginTimeoutMs = Math.max(1000, Number(config.AMP_CLI_LOGIN_TIMEOUT_MS || 480000));
  const cliCommand = String(config.AMP_CLI_COMMAND || "amp").trim() || "amp";
  const running = new Map();

  function start(sessionId) {
    console.log(`[amp-cli] start: session=${sessionId}`);
    state.cleanupExpired();
    const lock = state.tryStartSession(sessionId);
    if (!lock?.ok) return lock;

    runAmpLogoutBestEffort(cliCommand);

    // Kill stale amp/bun processes to free callback port
    try {
      spawnSync("pkill", ["-f", "amp.*main.js"], { timeout: 3000, stdio: "ignore" });
    } catch { /* best effort */ }

    const loginEnv = createLoginEnv();
    const spawnSpec = getSpawnSpec(cliCommand, "login");
    const childEnv = { ...loginEnv, ...(spawnSpec.extraEnv || {}) };
    let logTail = "";
    let done = false;
    let discoveredLoginUrl = "";
    let discoveredAuthCode = "";

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });

    running.set(sessionId, child);
    console.log(`[amp-cli] login spawned (pid=${child.pid})`);

    function pushChunk(chunk) {
      const rawChunk = String(chunk || "");
      const safeChunk = redactSensitive(rawChunk);
      logTail = appendLogTail(logTail, safeChunk);

      const maybeUrl = normalizeBrowserUrl(extractFirstUrl(rawChunk));
      if (maybeUrl && isLoginUrl(maybeUrl)) {
        const firstSeen = !discoveredLoginUrl;
        discoveredLoginUrl = maybeUrl;
        console.log(`[amp-cli] URL found: ${maybeUrl.substring(0, 60)}...`);
        if (firstSeen) maybeOpenBrowser(discoveredLoginUrl);
      }

      const maybeCode = extractAuthCode(rawChunk);
      if (maybeCode) discoveredAuthCode = maybeCode;

      const lines = safeChunk.split(/\r?\n/).filter(Boolean);
      let patch = { logTail };

      if (discoveredLoginUrl || discoveredAuthCode) {
        patch.metadata = {
          ...(discoveredLoginUrl ? { login_url: discoveredLoginUrl } : {}),
          ...(discoveredAuthCode ? { auth_code: discoveredAuthCode } : {}),
        };
      }

      for (const line of lines) {
        const transition = parseStateFromLine(line, discoveredLoginUrl, discoveredAuthCode);
        if (!transition) continue;
        patch = {
          ...patch,
          state: transition.state,
          message: transition.message,
        };
      }

      state.updateSession(sessionId, patch);
    }

    function finalizeFailure(message) {
      if (done) return;
      done = true;
      running.delete(sessionId);
      state.updateSession(sessionId, {
        state: "failed",
        message: redactSensitive(message),
        logTail,
        isRunning: false,
        finish: true,
      });
    }

    const timeout = setTimeout(() => {
      if (!child.killed) child.kill();
      finalizeFailure("AMP CLI login timed out.");
    }, loginTimeoutMs);

    child.stdout?.on("data", pushChunk);
    child.stderr?.on("data", pushChunk);

    child.on("error", (err) => {
      clearTimeout(timeout);
      finalizeFailure(`Failed to start AMP CLI login: ${err?.message || "unknown error"}`);
    });

    child.on("exit", (code) => {
      console.log(`[amp-cli] exit: code=${code}`);
      clearTimeout(timeout);
      if (done) return;
      done = true;
      running.delete(sessionId);

      const current = state.getSessionInternal(sessionId);
      if (!current) return;

      if (code === 0) {
        invalidateSecretCache();
        const proxyUrl = `http://localhost:${config.PORT || process.env.PORT || 8080}`;
        restoreSettingsUrl(proxyUrl);
        copySecretToProxy(proxyUrl);
        state.updateSession(sessionId, {
          state: "authenticated",
          message: "AMP CLI login completed. Credentials loaded from secrets file.",
          logTail,
          isRunning: false,
          finish: true,
        });
        return;
      }

      state.updateSession(sessionId, {
        state: "failed",
        message: `AMP CLI login failed (exit ${typeof code === "number" ? code : -1}).`,
        logTail,
        isRunning: false,
        finish: true,
      });
    });

    return { ok: true, session: lock.session };
  }

  return {
    start,
    isRunning(sessionId) {
      return running.has(sessionId);
    },
    getChild(sessionId) {
      return running.get(sessionId) || null;
    },
  };
}

module.exports = {
  createAmpCliRunner,
  redactSensitive,
};
