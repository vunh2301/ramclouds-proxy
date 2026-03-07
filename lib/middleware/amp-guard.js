function isLoopbackIp(ip) {
  const v = String(ip || "").trim();
  if (!v) return false;
  return v === "127.0.0.1" || v === "::1" || v === "::ffff:127.0.0.1";
}

function readHeader(req, name) {
  const v = req.headers?.[name];
  if (Array.isArray(v)) return v[0] || "";
  return typeof v === "string" ? v : "";
}

function extractInboundKey(req) {
  const authorization = readHeader(req, "authorization");
  if (authorization) {
    const m = authorization.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }
  return readHeader(req, "x-api-key").trim();
}

function createAmpGuard(config) {
  const expectedKeys = Array.isArray(config.AMP_INBOUND_API_KEYS) ? config.AMP_INBOUND_API_KEYS : [];
  const requireLocalhost = !!config.AMP_REQUIRE_LOCALHOST;

  return function ampGuard(req, res, next) {
    if (requireLocalhost && !isLoopbackIp(req.socket?.remoteAddress)) {
      return res.status(403).json({ error: { message: "Forbidden", type: "amp_forbidden" } });
    }

    const inboundKey = extractInboundKey(req);
    if (!inboundKey || !expectedKeys.includes(inboundKey)) {
      return res.status(401).json({ error: { message: "Unauthorized", type: "amp_unauthorized" } });
    }

    return next();
  };
}

module.exports = {
  isLoopbackIp,
  extractInboundKey,
  createAmpGuard,
};
