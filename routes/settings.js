/**
 * settings.js — Express routes for AI key status checking.
 *
 * Endpoints:
 *   GET /api/ai-key-status   — Check if a specific AI model's key is configured
 *   GET /api/ai-key-overview — Overview of which AI providers have keys set
 *
 * Keys can come from either the server's .env file or be sent at runtime
 * from the browser's localStorage (stateless cloud deployment model).
 */

const express = require("express");
const router = express.Router();

/**
 * GET /api/ai-key-status?aiModel=<modelId>
 * Check if the API key for the specified AI model is available in .env.
 *
 * Supported model ID formats:
 *   - "gemini-2.5-flash"      → checks GEMINI_API_KEY
 *   - "groq:<model-name>"     → checks GROQ_API_KEY
 *   - "cerebras:<model-name>" → checks CEREBRAS_API_KEY
 */
router.get("/ai-key-status", (req, res) => {
  try {
    const modelId = String(req.query.aiModel || "groq:llama-3.3-70b-versatile").trim();
    const modelIdLower = modelId.toLowerCase();

    let provider = "unknown";
    let envVar = "";

    if (modelIdLower === "gemini-2.5-flash") {
      provider = "gemini";
      envVar = "GEMINI_API_KEY";
    } else if (modelIdLower.startsWith("groq:")) {
      provider = "groq";
      envVar = "GROQ_API_KEY";
    } else if (modelIdLower.startsWith("cerebras:")) {
      provider = "cerebras";
      envVar = "CEREBRAS_API_KEY";
    }

    if (!envVar) {
      return res.status(400).json({ ok: false, error: "Unsupported model: " + modelId });
    }

    const value = process.env[envVar];
    const hasKey = typeof value === "string" && value.trim().length > 0;
    res.json({ ok: hasKey, provider, envVar, hasKey });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/ai-key-overview
 * Returns which AI provider keys are configured in the server environment.
 * The UI uses this to show green/red indicators in the Settings modal.
 */
router.get("/ai-key-overview", (req, res) => {
  try {
    const has = (k) => typeof process.env[k] === "string" && process.env[k].trim().length > 0;
    res.json({
      ok: true,
      providers: {
        gemini: has("GEMINI_API_KEY"),
        groq: has("GROQ_API_KEY"),
        cerebras: has("CEREBRAS_API_KEY"),
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
