const { streamResponsesAPIToChat } = require("./openai-stream");
const { resolveAmpMode, buildAmpResponsesBody } = require("../adapters/amp-cli");

async function handleAmp(req, res, incoming, stream, config) {
  const openaiBase = String(config.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
  const responsesUrl = openaiBase.endsWith("/v1") ? openaiBase + "/responses" : openaiBase + "/v1/responses";
  const apiKey = config.OPENAI_API_KEY || config.PROVIDER_API_KEY;

  const mode = resolveAmpMode(req, incoming, config);
  const body = buildAmpResponsesBody(incoming, stream, mode, config);

  console.log("[amp] mode=", mode, "model=", body.model || incoming.model, "stream=", !!stream);
  console.log("[amp] ->", responsesUrl);

  try {
    const upRes = await fetch(responsesUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
      },
      body: JSON.stringify(body),
    });

    console.log("[amp] status:", upRes.status);

    if (!upRes.ok) {
      const t = await upRes.text().catch(() => "");
      console.log("[amp] ERROR:", t.slice(0, 300));
      if (res.headersSent) return res.end();
      return res.status(upRes.status).send(t || "Error " + upRes.status);
    }

    if (stream && upRes.body) {
      await streamResponsesAPIToChat(upRes, res, { chatId: "chatcmpl-" + Date.now(), model: incoming.model });
      return;
    }

    const json = await upRes.json();
    if (res.headersSent) return res.end();
    return res.json(json);
  } catch (e) {
    console.log("[amp] ERROR:", e?.message || e);
    if (res.headersSent) return res.end();
    return res.status(500).json({ error: { message: e?.message || String(e), type: "proxy_runtime_error" } });
  }
}

module.exports = { handleAmp };
