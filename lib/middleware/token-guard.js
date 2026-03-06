/**
 * Token Guard — predict token growth and trigger summarization.
 */

const TOKEN_HISTORY = new Map();

function predictNextTokens(est, sessionKey, config) {
  const hist = TOKEN_HISTORY.get(sessionKey) || [];
  hist.push(est);
  if (hist.length > 10) hist.splice(0, hist.length - 10);
  TOKEN_HISTORY.set(sessionKey, hist);

  if (hist.length < 2) return est + 5000;

  const growths = [];
  for (let i = 1; i < hist.length; i++) growths.push(hist[i] - hist[i - 1]);
  const avg = growths.reduce((a, b) => a + b, 0) / growths.length;
  const maxGrowth = Math.max(avg * 1.5, 5000);

  console.log("[token-guard] predict: maxGrowth=", Math.round(maxGrowth),
    "projected=", Math.round(est + maxGrowth),
    "softLimit=", config.RAM_SOFT_LIMIT_TOKENS, "hardLimit=", config.RAM_HARD_LIMIT_TOKENS);

  return est + maxGrowth;
}

function needsSummarize(est, predicted, config) {
  return est >= config.RAM_HARD_LIMIT_TOKENS || predicted > config.RAM_SOFT_LIMIT_TOKENS;
}

function resetHistory(sessionKey) { TOKEN_HISTORY.delete(sessionKey); }

module.exports = { predictNextTokens, needsSummarize, resetHistory };
