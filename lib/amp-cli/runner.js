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
  // Resolve amp CLI to bun.exe directly, bypassing batch file chain
  // amp.bat → amp.bat → bun.exe run ... main.js — batch files can swallow stdout
  if (process.platform !== "win32") return null;
  try {
    const ampHome = process.env.AMP_HOME || path.join(os.homedir(), ".amp");
    const bunExe = path.join(ampHome, "bin", "bun.exe");
    const mainJs = path.join(ampHome, "package", "dist", "main.js");
    const pkgDir = path.join(ampHome, "package");
    if (fs.existsSync(bunExe) && fs.existsSync(mainJs)) {
      return { bunExe, mainJs, pkgDir, ampHome };
    }
  } catch { /* fallback to cmd.exe */ }
  return null;
}

function getSpawnSpec(command, action) {
  if (process.platform === "win32") {
    const bun = resolveAmpBun();
    if (bun) {
      return {
        command: bun.bunExe,
        args: ["run", "--cwd", bun.pkgDir, bun.mainJs, action],
        extraEnv: {
          AMP_HOME: bun.ampHome,
          AMP_PWD: process.cwd(),
          AMP_RIPGREP_PATH: path.join(bun.ampHome, "bin", "rg.exe"),
        },
      };
    }
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `${command} ${action}`] };
  }
  return { command, args: [action] };
}

function runAmpLogoutBestEffort(command) {
  try {
    const env = createLoginEnv(); // Use AMP_URL=https://ampcode.com so logout targets the right endpoint
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
      console.log("[amp-cli] logout timed out (5s), killing leftover amp processes");
      // On Windows, amp CLI = bun.exe running main.js, not amp.exe
      try {
        if (process.platform === "win32") {
          spawnSync("wmic", [
            "process", "where",
            "name='bun.exe' and CommandLine like '%amp%main.js%'",
            "delete",
          ], { timeout: 5000, encoding: "utf8", windowsHide: true });
        } else {
          spawnSync("pkill", ["-f", "amp.*main.js"], { timeout: 3000, stdio: "ignore" });
        }
        console.log("[amp-cli] logout: killed stale amp/bun processes");
      } catch { /* best effort */ }
    }
  } catch (err) {
    console.log(`[amp-cli] logout: exception: ${err?.message || err}`);
  }
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
  // Only accept URLs with auth path or query string — not bare domain
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
  if (!target) {
    console.log("[amp-cli] browser: skipped (empty URL)");
    return;
  }

  console.log("[amp-cli] browser: opening login URL");
  try {
    if (process.platform === "win32") {
      const browser = spawn("cmd.exe", ["/d", "/s", "/c", `start \"\" \"${target}\"`], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      browser.unref();
      return;
    }

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
  // Try JWT token first (eyJ...)
  const jwt = s.match(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+)*/);
  if (jwt) return jwt[0];
  // Fallback: XXXX-XXXX format
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
  if (process.platform === "win32") {
    return [
      path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "amp", "settings.json"),
      path.join(os.homedir(), ".config", "amp", "settings.json"),
    ];
  }
  if (process.platform === "darwin") {
    return [
      path.join(os.homedir(), ".config", "amp", "settings.json"),
      path.join(os.homedir(), "Library", "Application Support", "amp", "settings.json"),
    ];
  }
  return [path.join(os.homedir(), ".config", "amp", "settings.json")];
}

function restoreSettingsUrl(proxyUrl) {
  // amp login ghi de settings.json voi ampcode.com -> restore proxy URL
  for (const settingsPath of getSettingsPaths()) {
    try {
      if (!fs.existsSync(settingsPath)) continue;
      const raw = fs.readFileSync(settingsPath, "utf8");
      const obj = JSON.parse(raw.replace(/^\uFEFF/, "")); // strip BOM
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
  // Copy token tu apiKey@ampcode.com sang apiKey@localhost
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

    // Kill stale amp processes to free callback port (e.g. 35789)
    // amp CLI is actually bun.exe running main.js, NOT amp.exe
    if (process.platform === "win32") {
      try {
        // wmic to kill bun.exe processes running amp's main.js
        spawnSync("wmic", [
          "process", "where",
          "name='bun.exe' and CommandLine like '%amp%main.js%'",
          "delete",
        ], { timeout: 5000, encoding: "utf8", windowsHide: true });
        // status=0 with "No Instance(s)" is normal (no stale processes)
      } catch { /* best effort */ }
    } else {
      try {
        spawnSync("pkill", ["-f", "amp.*main.js"], { timeout: 3000, stdio: "ignore" });
      } catch { /* best effort */ }
    }

    const loginEnv = createLoginEnv();
    const spawnSpec = getSpawnSpec(cliCommand, "login");
    const childEnv = { ...loginEnv, ...(spawnSpec.extraEnv || {}) };
    let logTail = "";
    let done = false;
    let discoveredLoginUrl = "";
    let discoveredAuthCode = "";
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
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
        // Restore settings.json + copy secret cho proxy URL
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
