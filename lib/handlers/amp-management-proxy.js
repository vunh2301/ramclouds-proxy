const express = require("express");
const { getAmpSecret } = require("../amp-cli/secret");

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function shouldProxyAmpPath(path) {
  const p = String(path || "");
  return p === "/auth"
    || p.startsWith("/auth/")
    || p === "/user"
    || p.startsWith("/user/")
    || p === "/threads"
    || p.startsWith("/threads/")
    || p === "/meta"
    || p.startsWith("/meta/")
    || p === "/telemetry"
    || p.startsWith("/telemetry/")
    || p === "/internal"
    || p.startsWith("/internal/")
    || p === "/otel"
    || p.startsWith("/otel/")
    || p === "/tab"
    || p.startsWith("/tab/")
    || p === "/ads"
    || p.startsWith("/ads/");
}

function copyResponseHeaders(upRes, res) {
  for (const [k, v] of upRes.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(String(k).toLowerCase())) continue;
    res.setHeader(k, v);
  }
  res.setHeader("Cache-Control", upRes.headers.get("cache-control") || "no-cache, no-transform");
}

function buildUpstreamHeaders(req, config) {
  const headers = {};

  for (const [rawKey, rawValue] of Object.entries(req.headers || {})) {
    const key = String(rawKey || "").toLowerCase();
    if (!key || HOP_BY_HOP_HEADERS.has(key)) continue;
    if (key === "authorization" || key === "x-api-key") continue;

    if (Array.isArray(rawValue)) {
      headers[key] = rawValue.join(", ");
    } else if (typeof rawValue === "string") {
      headers[key] = rawValue;
    }
  }

  const upstreamKey = config.AMP_UPSTREAM_API_KEY || getAmpSecret(null, config.AMP_BASE_URL);
  if (upstreamKey) {
    headers.authorization = "Bearer " + upstreamKey;
    headers["x-api-key"] = upstreamKey;
  }

  return headers;
}

async function pipeResponse(upRes, res) {
  res.status(upRes.status);
  copyResponseHeaders(upRes, res);

  if (!upRes.body) {
    res.end();
    return;
  }

  const reader = upRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}

function resolveTargetPath(req, config) {
  const mountPath = (req.baseUrl || "") + (req.path || "");
  const upstreamBasePath = String(config.AMP_BASEPATH || "").replace(/\/+$/, "");
  if (upstreamBasePath.endsWith("/api")) return req.path || "/";
  return mountPath || "/";
}

function createAmpManagementRouter(config) {
  const router = express.Router();

  router.use(async (req, res, next) => {
    if (!shouldProxyAmpPath(req.path)) return next();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, config.AMP_TIMEOUT_MS || 60000));

    try {
      const targetPath = resolveTargetPath(req, config);
      const targetUrl = config.ampEndpoint(targetPath + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""));
      const headers = buildUpstreamHeaders(req, config);

      const canHaveBody = req.method !== "GET" && req.method !== "HEAD";
      const body = canHaveBody ? JSON.stringify(req.body ?? {}) : undefined;
      if (canHaveBody && !headers["content-type"]) headers["content-type"] = "application/json";

      const upRes = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
      });

      return await pipeResponse(upRes, res);
    } catch (e) {
      if (res.headersSent) return res.end();
      return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
    } finally {
      clearTimeout(timeout);
    }
  });

  return router;
}

/**
 * Directly proxy a request to amp upstream for a given path.
 * Used for root-level routes like /threads, /auth, /docs, /settings.
 */
async function pipeAmpUpstream(req, res, config, targetPath) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, config.AMP_TIMEOUT_MS || 60000));

  try {
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const targetUrl = config.ampEndpoint((targetPath || req.path) + qs);
    const headers = buildUpstreamHeaders(req, config);

    const canHaveBody = req.method !== "GET" && req.method !== "HEAD";
    const body = canHaveBody ? JSON.stringify(req.body ?? {}) : undefined;
    if (canHaveBody && !headers["content-type"]) headers["content-type"] = "application/json";

    const upRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      signal: controller.signal,
    });

    return await pipeResponse(upRes, res);
  } catch (e) {
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  createAmpManagementRouter,
  pipeAmpUpstream,
};
