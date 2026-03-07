const { randomUUID } = require("node:crypto");

const SESSIONS = new Map();

const ACTIVE_STATES = new Set(["starting", "awaiting_user", "verifying"]);
const TERMINAL_STATES = new Set(["authenticated", "failed", "expired"]);

let OPTIONS = {
  sessionTtlMs: 600000,
  statusRetentionMs: 120000,
  maxConcurrent: 1,
};

function setOptions(opts = {}) {
  OPTIONS = {
    sessionTtlMs: Math.max(1, Number(opts.sessionTtlMs || OPTIONS.sessionTtlMs || 600000)),
    statusRetentionMs: Math.max(1, Number(opts.statusRetentionMs || OPTIONS.statusRetentionMs || 120000)),
    maxConcurrent: Math.max(1, Number(opts.maxConcurrent || OPTIONS.maxConcurrent || 1)),
  };
}

function nowMs() {
  return Date.now();
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function toPublic(session) {
  return {
    session_id: session.id,
    state: session.state,
    message: session.message,
    metadata: session.metadata,
    created_at: toIso(session.createdAt),
    updated_at: toIso(session.updatedAt),
    expires_at: toIso(session.expiresAt),
    finished_at: session.finishedAt ? toIso(session.finishedAt) : null,
    log_tail: session.logTail || "",
  };
}

function createSession(metadata = {}) {
  cleanupExpired();

  const now = nowMs();
  const id = randomUUID().replace(/-/g, "");
  const session = {
    id,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    state: "configured",
    message: "Session configured. Ready to start amp login.",
    createdAt: now,
    updatedAt: now,
    expiresAt: now + OPTIONS.sessionTtlMs,
    finishedAt: null,
    isRunning: false,
    logTail: "",
  };

  SESSIONS.set(id, session);
  return toPublic(session);
}

function getSession(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  const session = SESSIONS.get(key);
  if (!session) return null;
  markExpiredIfNeeded(key);
  const latest = SESSIONS.get(key);
  return latest ? toPublic(latest) : null;
}

function getSessionInternal(id) {
  const key = String(id || "").trim();
  if (!key) return null;
  return SESSIONS.get(key) || null;
}

function updateSession(id, patch = {}) {
  const session = getSessionInternal(id);
  if (!session) return null;

  const now = nowMs();
  const next = { ...session };

  if (typeof patch.state === "string" && patch.state) next.state = patch.state;
  if (typeof patch.message === "string") next.message = patch.message;
  if (typeof patch.logTail === "string") next.logTail = patch.logTail;
  if (patch.metadata && typeof patch.metadata === "object") {
    next.metadata = { ...next.metadata, ...patch.metadata };
  }

  if (patch.expiresAt) {
    const n = Number(patch.expiresAt);
    if (Number.isFinite(n) && n > 0) next.expiresAt = n;
  }

  if (typeof patch.isRunning === "boolean") next.isRunning = patch.isRunning;

  if (patch.finish === true || TERMINAL_STATES.has(next.state)) {
    next.finishedAt = now;
    next.isRunning = false;
  }

  next.updatedAt = now;
  SESSIONS.set(next.id, next);
  return toPublic(next);
}

function markExpiredIfNeeded(id) {
  const session = getSessionInternal(id);
  if (!session) return null;

  if (session.state === "expired") return toPublic(session);

  if (nowMs() > session.expiresAt) {
    const expired = {
      ...session,
      state: "expired",
      message: "Session expired.",
      isRunning: false,
      finishedAt: session.finishedAt || nowMs(),
      updatedAt: nowMs(),
    };
    SESSIONS.set(expired.id, expired);
    return toPublic(expired);
  }

  return toPublic(session);
}

function activeCount() {
  let count = 0;
  for (const session of SESSIONS.values()) {
    if (session.isRunning || ACTIVE_STATES.has(session.state)) count += 1;
  }
  return count;
}

function tryStartSession(id) {
  cleanupExpired();
  const session = getSessionInternal(id);
  if (!session) {
    return { ok: false, code: "not_found", message: "Session not found." };
  }

  markExpiredIfNeeded(id);
  const latest = getSessionInternal(id);
  if (!latest) {
    return { ok: false, code: "not_found", message: "Session not found." };
  }

  if (latest.state === "expired") {
    return { ok: false, code: "expired", message: "Session expired." };
  }

  if (latest.isRunning || ACTIVE_STATES.has(latest.state)) {
    return { ok: false, code: "already_running", message: "Session is already running." };
  }

  if (activeCount() >= OPTIONS.maxConcurrent) {
    return { ok: false, code: "max_concurrent", message: "Maximum concurrent AMP CLI logins reached." };
  }

  const started = {
    ...latest,
    state: "starting",
    message: "Starting amp login process.",
    updatedAt: nowMs(),
    isRunning: true,
    finishedAt: null,
  };

  SESSIONS.set(started.id, started);
  return { ok: true, session: toPublic(started) };
}

function cleanupExpired() {
  const now = nowMs();
  for (const [id, session] of SESSIONS.entries()) {
    if (!session) {
      SESSIONS.delete(id);
      continue;
    }

    if (now > session.expiresAt) {
      if (session.state !== "expired") {
        SESSIONS.set(id, {
          ...session,
          state: "expired",
          message: "Session expired.",
          isRunning: false,
          finishedAt: session.finishedAt || now,
          updatedAt: now,
        });
        continue;
      }

      const expiredAt = session.finishedAt || session.updatedAt;
      if (now - expiredAt > OPTIONS.statusRetentionMs) {
        SESSIONS.delete(id);
      }
      continue;
    }

    if (TERMINAL_STATES.has(session.state) && session.finishedAt && now - session.finishedAt > OPTIONS.statusRetentionMs) {
      SESSIONS.delete(id);
    }
  }
}

module.exports = {
  setOptions,
  createSession,
  getSession,
  getSessionInternal,
  updateSession,
  markExpiredIfNeeded,
  cleanupExpired,
  tryStartSession,
};
