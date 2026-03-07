/**
 * Model Router — resolve model aliases and detect provider.
 *
 * ALL model mappings come from config (MODEL_MAP env var).
 * Provider detection uses ANTHROPIC_PREFIXES from env (default: "claude-").
 *
 * To add a new provider:
 *   1. Add PROVIDER_PREFIXES env (e.g. GEMINI_PREFIXES=gemini-)
 *   2. Add isXxxModel() detection function
 *   3. Add routing case in main.cjs
 */

/**
 * Parse model map from config. Returns { modelMap, defaultModel, allModelIds }.
 */
function loadModelConfig(config) {
    const modelMap = { ...(config.MODEL_MAP || {}) };

    // Merge EXTRA_MODEL_MAP if present
    try {
        const raw = config.EXTRA_MODEL_MAP || process.env.EXTRA_MODEL_MAP || "{}";
        const extra = JSON.parse(raw);
        Object.assign(modelMap, extra);
    } catch (e) {
        console.log("[router] EXTRA_MODEL_MAP parse error:", e?.message);
    }

    const defaultModel = (process.env.DEFAULT_MODEL || "").trim() || null;
    const allModelIds = Object.keys(modelMap);

    if (allModelIds.length > 0) console.log("[router] model map:", modelMap);
    if (defaultModel) console.log("[router] default model:", defaultModel);

    return { modelMap, defaultModel, allModelIds };
}

/**
 * Resolve incoming model name using the model map.
 */
function resolveModel(model, modelMap, defaultModel) {
    if (!model) return defaultModel || model;
    if (modelMap[model]) return modelMap[model];
    return model;
}

/**
 * Detect if a model should use the Anthropic (Claude) path.
 * Uses ANTHROPIC_PREFIXES env (comma-separated, default: "claude-").
 */
function loadAnthropicPrefixes() {
    const raw = (process.env.ANTHROPIC_PREFIXES || "claude-").trim();
    return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function isAnthropicModel(model, prefixes) {
    if (!model) return true; // default to anthropic
    return prefixes.some(p => model.startsWith(p));
}

function loadAmpPrefixes(config) {
    if (Array.isArray(config?.AMP_PREFIXES) && config.AMP_PREFIXES.length > 0) return config.AMP_PREFIXES;
    const raw = (process.env.AMP_PREFIXES || "amp-").trim();
    return raw.split(",").map(s => s.trim()).filter(Boolean);
}

function isAmpModel(model, prefixes) {
    if (!model) return false;
    return (prefixes || []).some(p => model.startsWith(p));
}

function readHeader(req, name) {
    const v = req?.headers?.[name];
    if (Array.isArray(v)) return v[0];
    if (typeof v === "string") return v;
    return "";
}

function isAmpRequest(req, incoming, ampPrefixes) {
    const metadata = (incoming && typeof incoming.metadata === "object" && incoming.metadata) || {};
    const metaClient = String(metadata.client || metadata.source || "").trim().toLowerCase();
    if (metaClient === "amp-cli" || metaClient === "amp") return true;

    const xAmpCli = readHeader(req, "x-amp-cli");
    if (xAmpCli) return true;

    const xClient = readHeader(req, "x-client").trim().toLowerCase();
    if (xClient === "amp-cli" || xClient === "amp") return true;

    return isAmpModel(incoming?.model, ampPrefixes);
}

module.exports = {
    loadModelConfig,
    resolveModel,
    loadAnthropicPrefixes,
    isAnthropicModel,
    loadAmpPrefixes,
    isAmpModel,
    isAmpRequest,
};
