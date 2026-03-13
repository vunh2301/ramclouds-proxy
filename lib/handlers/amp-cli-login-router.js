const express = require("express");
const state = require("../amp-cli/state");
const { createAmpCliRunner } = process.platform === "win32"
  ? require("../amp-cli/runner")
  : require("../amp-cli/runner-mac");

function err(res, status, message, type = "proxy_runtime_error") {
  return res.status(status).json({ error: { message, type } });
}

function pickMetadata(body) {
  if (!body || typeof body !== "object") return {};
  const out = {};
  if (typeof body.workspace_id === "string") out.workspace_id = body.workspace_id;
  if (typeof body.provider === "string") out.provider = body.provider;
  return out;
}

function createAmpCliLoginRouter(config) {
  state.setOptions({
    sessionTtlMs: config.AMP_CLI_SESSION_TTL_MS,
    statusRetentionMs: config.AMP_CLI_STATUS_RETENTION_MS,
    maxConcurrent: config.AMP_CLI_MAX_CONCURRENT,
  });

  const runner = createAmpCliRunner(config);
  const router = express.Router();

  router.post("/configure", (req, res) => {
    state.cleanupExpired();
    const session = state.createSession(pickMetadata(req.body || {}));
    return res.json(session);
  });

  router.post("/start", (req, res) => {
    state.cleanupExpired();
    const sessionId = String(req.body?.session_id || "").trim();
    if (!sessionId) return err(res, 400, "session_id is required", "proxy_validation_error");

    const started = runner.start(sessionId);
    if (!started?.ok) {
      if (started.code === "not_found") return err(res, 404, "Session not found", "proxy_not_found");
      if (started.code === "expired") return err(res, 409, "Session expired", "proxy_conflict_error");
      if (started.code === "already_running") return err(res, 409, "Session already running", "proxy_conflict_error");
      if (started.code === "max_concurrent") return err(res, 409, "Maximum concurrent AMP CLI logins reached", "proxy_conflict_error");
      return err(res, 500, started.message || "Failed to start AMP CLI login");
    }

    return res.json({
      session_id: started.session.session_id,
      state: "starting",
      message: "AMP CLI login started.",
      expires_at: started.session.expires_at,
    });
  });

  // Submit auth code to running AMP CLI stdin
  router.post("/submit-code", (req, res) => {
    state.cleanupExpired();
    const sessionId = String(req.body?.session_id || "").trim();
    const code = String(req.body?.code || "").trim();
    if (!sessionId) return err(res, 400, "session_id is required", "proxy_validation_error");
    if (!code) return err(res, 400, "code is required", "proxy_validation_error");

    const child = runner.getChild(sessionId);
    if (!child) return err(res, 404, "No running login session found", "proxy_not_found");

    try {
      child.stdin.write(code + "\n");
      console.log(`[amp-cli] submitted auth code to session ${sessionId} (${code.length} chars)`);
      return res.json({ ok: true, message: "Auth code submitted." });
    } catch (e) {
      return err(res, 500, `Failed to submit code: ${e?.message}`);
    }
  });

  router.get("/status", (req, res) => {
    state.cleanupExpired();
    const sessionId = String(req.query?.session_id || "").trim();
    if (!sessionId) return err(res, 400, "session_id is required", "proxy_validation_error");

    const session = state.getSession(sessionId);
    if (!session) return err(res, 404, "Session not found", "proxy_not_found");

    return res.json({
      session_id: session.session_id,
      state: session.state,
      message: session.message,
      expires_at: session.expires_at,
      updated_at: session.updated_at,
      log_tail: session.log_tail,
      metadata: session.metadata,
    });
  });

  return router;
}

module.exports = {
  createAmpCliLoginRouter,
};
