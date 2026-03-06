async function fetchJson(url, { apiKey, body }) {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify(body),
  });

  return resp;
}

module.exports = { fetchJson };
