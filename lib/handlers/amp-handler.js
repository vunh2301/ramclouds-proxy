const { streamResponsesAPIToChat, emitStreamFinish } = require("./openai-stream");
const { resolveAmpMode, buildAmpResponsesBody } = require("../adapters/amp-cli");
const { WEB_SEARCH_ENABLED, convertWebSearchTools, search: webSearch, buildWebSearchFollowUp, extractQuery } = require("../web-search");

async function handleAmp(req, res, incoming, stream, config) {
  const openaiBase = String(config.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
  const responsesUrl = openaiBase.endsWith("/v1") ? openaiBase + "/responses" : openaiBase + "/v1/responses";
  const apiKey = config.OPENAI_API_KEY || config.PROVIDER_API_KEY;

  // Convert web_search_preview hosted tool → function tool
  const { tools: convertedTools, hasWebSearch } = convertWebSearchTools(incoming.tools);
  if (hasWebSearch) {
    console.log("[amp] web_search_preview detected → converted to function tool");
    incoming = { ...incoming, tools: convertedTools };
  }

  const mode = resolveAmpMode(req, incoming, config);
  const body = buildAmpResponsesBody(incoming, stream, mode, config);

  console.log("[amp] mode=", mode, "model=", body.model || incoming.model, "stream=", !!stream, "webSearch=", hasWebSearch);
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
      const chatId = "chatcmpl-" + Date.now();
      const streamOpts = {
        chatId,
        model: incoming.model,
        interceptToolNames: hasWebSearch ? new Set(["web_search"]) : undefined,
        autoFinish: !hasWebSearch,
      };

      const { assistantText, assistantToolCalls, interceptedCalls } = await streamResponsesAPIToChat(upRes, res, streamOpts);

      // Web search interception: execute search → re-query → stream follow-up
      if (interceptedCalls.length > 0) {
        const wsCall = interceptedCalls[0];
        const query = extractQuery(wsCall);
        console.log("[amp] web_search intercepted, query:", query);

        const searchResults = await webSearch(query);
        console.log("[amp] search results:", (searchResults || "").slice(0, 200));

        // Build follow-up request with search results injected
        const followUpBody = buildWebSearchFollowUp(body, wsCall, searchResults);
        followUpBody.stream = true;

        console.log("[amp] -> follow-up request with search results");
        const followUpRes = await fetch(responsesUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}),
          },
          body: JSON.stringify(followUpBody),
        });

        if (followUpRes.ok && followUpRes.body) {
          await streamResponsesAPIToChat(followUpRes, res, {
            chatId,
            model: incoming.model,
            skipHeader: true,
            skipRoleEmit: true,
          });
        } else {
          const errText = await followUpRes.text().catch(() => "");
          console.log("[amp] follow-up ERROR:", followUpRes.status, errText.slice(0, 200));
          emitStreamFinish(res, chatId, incoming.model);
        }
      } else if (hasWebSearch) {
        // web_search was available but model didn't use it → finish now
        emitStreamFinish(res, chatId, incoming.model);
      }
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
