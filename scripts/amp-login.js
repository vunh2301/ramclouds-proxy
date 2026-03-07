#!/usr/bin/env node
/**
 * AMP CLI Login — run via `npm run amp-login`
 *
 * Logs out any existing session, then runs `amp login` pointing at ampcode.com.
 * On success, credentials are saved to the local secrets file and the proxy
 * can read them automatically.
 */

const { spawnSync, spawn } = require("node:child_process");
const path = require("node:path");
const { getSecretsFilePath, readSecretsFile } = require("../lib/amp-cli/secret");

const AMP_BROWSER_HOST = "ampcode.com";
const CLI_COMMAND = process.env.AMP_CLI_COMMAND || "amp";

function createCleanEnv() {
  const env = { ...process.env };
  delete env.AMP_URL;
  delete env.AMP_API_KEY;
  return env;
}

function getSpawnSpec(action) {
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `${CLI_COMMAND} ${action}`] };
  }
  return { command: CLI_COMMAND, args: [action] };
}

// Step 1: logout
console.log("[amp-login] Logging out existing session...");
try {
  const spec = getSpawnSpec("logout");
  spawnSync(spec.command, spec.args, {
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    env: createCleanEnv(),
    stdio: "ignore",
  });
} catch { /* best effort */ }

// Step 2: login (interactive — inherits stdio so user sees browser URL + code)
console.log("[amp-login] Starting amp login...");
console.log(`[amp-login] AMP_URL = https://${AMP_BROWSER_HOST}`);
console.log("[amp-login] A browser window should open. Complete the login there.\n");

const loginEnv = createCleanEnv();
loginEnv.AMP_URL = `https://${AMP_BROWSER_HOST}`;

const loginSpec = getSpawnSpec("login");
const child = spawnSync(loginSpec.command, loginSpec.args, {
  env: loginEnv,
  stdio: "inherit",
  windowsHide: true,
  timeout: 480000, // 8 min
});

if (child.status === 0) {
  console.log("\n[amp-login] Login successful!");

  // Verify secrets file
  const secretsPath = getSecretsFilePath();
  const secrets = readSecretsFile();
  if (secrets) {
    const keys = Object.keys(secrets).filter(k => k.startsWith("apiKey@"));
    console.log(`[amp-login] Credentials saved to: ${secretsPath}`);
    console.log(`[amp-login] Found ${keys.length} API key(s)`);
  } else {
    console.log(`[amp-login] Warning: Could not read secrets file at ${secretsPath}`);
  }

  console.log("\n[amp-login] Done! The proxy will automatically use these credentials.");
  console.log("[amp-login] Run `npm start` to start the proxy.");
} else {
  console.error(`\n[amp-login] Login failed (exit code ${child.status}).`);
  process.exit(1);
}
