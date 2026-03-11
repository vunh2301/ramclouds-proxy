const { spawn, spawnSync } = require("node:child_process");
const state = require("./state");
const { invalidateCache: invalidateSecretCache } = require("./secret");

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

function getSpawnSpec(command, action) {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `${command} ${action}`] };
  }
  return { command, args: [action] };
}

function runAmpLogoutBestEffort(command) {
  try {
    const env = createCleanEnv();
    const spec = getSpawnSpec(command, "logout");
    console.log("[amp-cli] logout: unset AMP_URL, AMP_API_KEY before amp logout");
    spawnSync(spec.command, spec.args, {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
      env,
      stdio: "ignore",
    });
  } catch {
    // best effort only
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

function extractFirstUrl(text) {
  const m = String(text || "").match(/https?:\/\/[^\s"'<>]+/i);
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
  if (!target) return;

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
  } catch {
    // best effort only
  }
}

function extractAuthCode(text) {
  const m = String(text || "").match(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,}\b/i);
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

function createAmpCliRunner(config) {
  const loginTimeoutMs = Math.max(1000, Number(config.AMP_CLI_LOGIN_TIMEOUT_MS || 480000));
  const cliCommand = String(config.AMP_CLI_COMMAND || "amp").trim() || "amp";
  const running = new Map();

  function start(sessionId) {
    state.cleanupExpired();
    const lock = state.tryStartSession(sessionId);
    if (!lock?.ok) return lock;

    runAmpLogoutBestEffort(cliCommand);
    const loginEnv = createLoginEnv();

    const spawnSpec = getSpawnSpec(cliCommand, "login");
    let logTail = "";
    let done = false;
    let discoveredLoginUrl = "";
    let discoveredAuthCode = "";

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: loginEnv,
    });

    running.set(sessionId, child);

    function pushChunk(chunk) {
      const rawChunk = String(chunk || "");
      const safeChunk = redactSensitive(rawChunk);
      logTail = appendLogTail(logTail, safeChunk);

      const maybeUrl = normalizeBrowserUrl(extractFirstUrl(rawChunk));
      if (maybeUrl && isLoginUrl(maybeUrl)) {
        const firstSeen = !discoveredLoginUrl;
        discoveredLoginUrl = maybeUrl;
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
      clearTimeout(timeout);
      if (done) return;
      done = true;
      running.delete(sessionId);

      const current = state.getSessionInternal(sessionId);
      if (!current) return;

      if (code === 0) {
        invalidateSecretCache();
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
  };
}

module.exports = {
  createAmpCliRunner,
  redactSensitive,
};
