/**
 * checkout.js — Express routes for AI-powered checkout processing.
 *
 * Endpoints:
 *   POST /api/process-checkouts — Scan WhatsApp, extract checkouts, send to AI for parsing
 *   POST /api/save-checkouts    — Manually save/override parsed checkout data
 *
 * WORKFLOW:
 *   1. Trigger a WhatsApp history scan to pull recent messages
 *   2. Filter for checkout/work-summary messages from "dev" type employees only
 *   3. Aggregate messages per developer
 *   4. Send to an LLM (Gemini/Groq/Cerebras) to extract project names + repo status
 *   5. Save results to checkout_projects.csv
 *
 * The checkout regex checks for keywords like "checkout", "checked out",
 * "work summary", "repo update status", "video summary" in messages.
 */

const express = require("express");
const fs = require("fs");
const {
  readProjectsCatalog,
  readEmployeeGroupsCatalog,
  getEmployeeGroupsPath,
  getCheckoutProjectsPath,
  parseCsvLine,
  normalizeGroupName,
  toGroupKey,
  looksLikeLeakedDeveloperLabel,
  looksLikeLeakedGroupLabel,
  formatCheckoutProjectsCell,
  normalizeMappedAiDict,
} = require("../utils/csv");

const router = express.Router();

/**
 * Regex for detecting checkout/work-summary messages.
 *
 * Matches: "checked out", "checkout", "checking out", "work summary",
 *          "repo update status", "video summary"
 *
 * NOTE: This regex is used in a JavaScript RegExp literal, so \s is
 * correctly single-escaped (unlike the config.json string patterns
 * which require double-escaping for JSON).
 */
const CHECKOUT_REGEX = /(?:check(?:ed|ing|s)?[\s-]?out|work[\s-]*summary|repo[\s-]*update[\s-]*status|video[\s-]*summary)/i;

/**
 * POST /api/process-checkouts
 * Main AI extraction pipeline.
 *
 * Body: {
 *   hours: number,               — Lookback window in hours (default 24)
 *   hardRescan: boolean,         — If true, clear message cache before scanning
 *   runtimeApiKey: string,       — API key sent from browser localStorage
 *   aiModel: string,             — AI model ID (e.g. "groq:llama-3.3-70b-versatile")
 *   apiKeys: { gemini, groq, cerebras } — Fallback keys from localStorage
 * }
 */
router.post("/process-checkouts", async (req, res) => {
  try {
    const lookbackHours = req.body.hours || 24;
    const hardRescan = Boolean(req.body.hardRescan);
    const runtimeApiKey = typeof req.body.runtimeApiKey === "string" ? req.body.runtimeApiKey.trim() : "";
    const scanThresholdMs = Date.now() - lookbackHours * 60 * 60 * 1000;

    // ── Step 1: Validate project catalog ────────────────────────────
    const validProjectsRaw = readProjectsCatalog();
    if (!validProjectsRaw || validProjectsRaw.length === 0) {
      return res.status(400).json({ error: "repo_projects.csv missing or empty" });
    }
    const validProjects = validProjectsRaw.map((p) => p.name);

    // ── Step 2: Trigger WhatsApp history scan ───────────────────────
    let inMemoryMatches = [];
    const triggerSync = req.app.locals.triggerPerformReadySync;

    if (hardRescan && typeof req.app.locals.clearMatchCache === "function") {
      req.app.locals.clearMatchCache();
    }

    if (typeof triggerSync === "function") {
      try {
        console.log(`[AI ENGINE] Syncing live WhatsApp history for the last ${lookbackHours} hours...`);
        inMemoryMatches = (await triggerSync(lookbackHours, true)) || [];
      } catch (err) {
        console.warn(`[WARN] WhatsApp live sync failed: ${err.message}`);
      }
    }

    if (!inMemoryMatches || inMemoryMatches.length === 0) {
      return res.json({ results: [] });
    }

    // ── Step 3: Load employee roster for type filtering ─────────────
    const employeeGroupsPath = getEmployeeGroupsPath();
    let localCsvData = [];
    if (fs.existsSync(employeeGroupsPath)) {
      const gLines = fs.readFileSync(employeeGroupsPath, "utf8").split(/\r?\n/).filter(Boolean).slice(1);
      gLines.forEach((l) => {
        const cells = parseCsvLine(l);
        if (cells.length >= 4) {
          localCsvData.push({
            name: cells[0].trim(),
            group: normalizeGroupName(cells[1]),
            type: cells[3].trim().toLowerCase(),
          });
        } else if (cells.length >= 2) {
          localCsvData.push({
            name: cells[0].trim(),
            group: normalizeGroupName(cells[1]),
            type: "dev",
          });
        }
      });
    }

    // ── Step 4: Filter and aggregate checkout messages ───────────────
    // Only process "dev" type employees — skip QA, VA, Tester, Trainee
    const devMap = new Map();
    inMemoryMatches.forEach((m) => {
      try {
        const logTimeMs = m.timestamp ? new Date(m.timestamp).getTime() : 0;
        if (logTimeMs > 0 && logTimeMs < scanThresholdMs) return;

        const gn = typeof m.groupName === "string" ? m.groupName.trim() : "";
        const empLookup = localCsvData.find((e) => e.group.toLowerCase() === gn.toLowerCase());
        const eType = empLookup ? empLookup.type : "unknown";

        // Strict type filter: only process developer checkouts
        if (eType !== "dev") return;

        const isTagged = Array.isArray(m.matchedRules) && m.matchedRules.includes("checkout_detection");
        const matchesRegex = typeof m.messageBody === "string" && CHECKOUT_REGEX.test(m.messageBody);

        if (isTagged || matchesRegex) {
          const devId = m.sender;
          if (!devMap.has(devId)) {
            devMap.set(devId, {
              sender: m.sender,
              groupName: m.groupName,
              messages: [m.messageBody.trim()],
            });
          } else {
            const existing = devMap.get(devId);
            if (!existing.messages.includes(m.messageBody.trim())) {
              existing.messages.push(m.messageBody.trim());
            }
          }
        }
      } catch (err) {
        console.warn("[WARN] Skipped malformed log entry.");
      }
    });

    // Combine multiple checkout messages from the same dev
    const checkoutMessages = Array.from(devMap.values()).map((d) => ({
      sender: d.sender,
      groupName: d.groupName,
      messageBody: d.messages.join("\n\n--- ADDITIONAL CHECKOUT ---\n\n"),
    }));

    // Build dev roster for ensuring all devs appear in output
    const devRoster = localCsvData.filter((r) => (r.type || "").toLowerCase() === "dev");

    // ── Step 5: Send to AI for project extraction ───────────────────
    const batchPayload = checkoutMessages.map((msg, i) => ({ id: i, text: msg.messageBody }));

    const prompt = `You are a highly intelligent data extraction API. Here is the master list of valid 'projects':
${JSON.stringify(validProjects)}

Below is a JSON array of work summaries provided by developers. Read each work summary "text" and figure out which projects they worked on.
CRITICAL RULES:
1. Developers often use shorthand, acronyms, or slight misspellings (e.g., "EQ" instead of "Equality Records(EQ)").
2. You MUST USE aggressive fuzzy matching to map their informal project mentions into the EXACT project names from my valid 'projects' list. 
3. If a developer mentions multiple separate projects, you MUST map every single one. Do NOT miss any.
4. Your final output must ONLY contain the EXACT strings strictly copied from the master 'projects' list.
5. REPO UPDATE STATUS CHECK: For EACH project you find in the developer's summary, you MUST determine if the repository was updated today:
   - "yes" = The summary text explicitly mentions words like "UPDATED REPO", "Repo Update Today", "pushed", "committed", or provides a repository URL/link for that specific project.
   - "no" = The summary text explicitly states it was NOT updated or no push was made.
   - "not mentioned" = The summary does not mention anything about repo updates for that specific project.

Input summaries:
${JSON.stringify(batchPayload)}

Return ONLY a valid JSON object mapping the numeric 'id' to an array of objects. Each object MUST have exactly two keys: "name" (the EXACT project name from the master list) and "status" (one of "yes", "no", "not mentioned"). Map unrecognizable summaries to an empty array. Do not include markdown like \`\`\`json.`;

    let mappedDict = {};
    if (checkoutMessages.length > 0) {
      const modelId = String(req.body.aiModel || "groq:llama-3.3-70b-versatile").trim();
      const apiKeys = req.body.apiKeys || {};
      const modelIdLower = modelId.toLowerCase();
      console.log(`[AI ENGINE] Starting data extraction using model pipeline: ${modelId}`);

      let textBlob = "";

      // ── AI Provider Routing ─────────────────────────────────────
      if (modelIdLower === "gemini-2.5-flash") {
        const geminiKey = runtimeApiKey || apiKeys.gemini || process.env.GEMINI_API_KEY;
        if (!geminiKey) throw new Error("Missing Google Gemini API Key. Please add it in ⚙ Settings.");
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const aiResp = await model.generateContent(prompt);
        textBlob = aiResp.response.text();
      } else if (modelIdLower.startsWith("groq:")) {
        const groqKey = runtimeApiKey || apiKeys.groq || process.env.GROQ_API_KEY;
        if (!groqKey) throw new Error("Missing Groq API Key. Please add it in ⚙ Settings.");
        const gModelRaw = modelId.replace(/^groq:/i, "").trim();
        const groqModelAliases = {
          "llama-4-scout-17b": "meta-llama/llama-4-scout-17b-16e-instruct",
          "kimi-k2-instruct": "llama-3.3-70b-versatile",
        };
        const gModel = groqModelAliases[gModelRaw] || gModelRaw;
        const gPayload = { model: gModel, messages: [{ role: "user", content: prompt }] };
        const gRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${groqKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(gPayload),
        });
        if (!gRes.ok) throw new Error("Groq API error: " + (await gRes.text()));
        const gData = await gRes.json();
        textBlob = gData.choices[0].message.content;
      } else if (modelIdLower.startsWith("cerebras:")) {
        const cerebrasKey = runtimeApiKey || apiKeys.cerebras || process.env.CEREBRAS_API_KEY;
        if (!cerebrasKey) throw new Error("Missing Cerebras API Key. Please add it in ⚙ Settings.");
        const groqKey = apiKeys.groq || process.env.GROQ_API_KEY;
        const geminiKey = apiKeys.gemini || process.env.GEMINI_API_KEY;

        const cModel = modelId.replace(/^cerebras:/i, "");
        const cPayload = { model: cModel, messages: [{ role: "user", content: prompt }] };
        let useGroqFallback = false;
        let cerebrasDetails = "";

        try {
          const cRes = await fetch("https://api.cerebras.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cerebrasKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(cPayload),
          });

          if (!cRes.ok) {
            cerebrasDetails = await cRes.text();
            useGroqFallback = true;
          } else {
            const cData = await cRes.json();
            const maybeContent = cData?.choices?.[0]?.message?.content;
            if (typeof maybeContent === "string" && maybeContent.trim()) {
              textBlob = maybeContent;
            } else {
              cerebrasDetails = JSON.stringify(cData).slice(0, 800);
              useGroqFallback = true;
            }
          }
        } catch (err) {
          cerebrasDetails = err.message;
          useGroqFallback = true;
        }

        // Fallback chain: Cerebras → Groq → Gemini
        if (useGroqFallback) {
          if (groqKey && groqKey.trim()) {
            console.warn(
              `[AI_FALLBACK] Cerebras failed. Falling back to Groq. Details: ${cerebrasDetails}`
            );
            const fallbackPayload = {
              model: "llama-3.3-70b-versatile",
              messages: [{ role: "user", content: prompt }],
            };
            const fallbackRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${groqKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(fallbackPayload),
            });
            if (!fallbackRes.ok) {
              throw new Error("Cerebras failed and Groq fallback failed: " + (await fallbackRes.text()));
            }
            const fallbackData = await fallbackRes.json();
            textBlob = fallbackData.choices[0].message.content;
          } else if (geminiKey && geminiKey.trim()) {
            console.warn(
              `[AI_FALLBACK] Cerebras failed. Falling back to Gemini. Details: ${cerebrasDetails}`
            );
            const { GoogleGenerativeAI } = require("@google/generative-ai");
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const aiResp = await model.generateContent(prompt);
            textBlob = aiResp.response.text();
          } else {
            throw new Error(
              `Cerebras failed and no fallback provider key is available. Details: ${cerebrasDetails}`
            );
          }
        }
      } else {
        throw new Error(
          `Unsupported AI model: ${modelId}. Supported providers are Gemini, Groq, and Cerebras.`
        );
      }

      // ── Parse AI response ───────────────────────────────────────
      // Strip markdown code fences that LLMs sometimes wrap around JSON
      textBlob = textBlob.replace(/```json/gi, "").replace(/```/g, "").trim();
      // Extract the JSON object (LLMs sometimes add extra text around it)
      const jsonMatch = textBlob.match(/\{[\s\S]*\}$/m);
      if (jsonMatch) textBlob = jsonMatch[0];

      mappedDict = JSON.parse(textBlob);
    }

    mappedDict = normalizeMappedAiDict(mappedDict, checkoutMessages.length);

    // ── Step 6: Build results and write CSV ─────────────────────────
    const results = [];
    let compiledCsv = "Developer,Group Name,Projects\n";

    const parsedByGroup = new Map();
    checkoutMessages.forEach((msg, i) => {
      const extractedProjects = mappedDict[i] || [];
      const lookupGroup = (msg.groupName || "").toLowerCase().trim();
      const matchedDev = localCsvData.find((r) => (r.group || "").toLowerCase().trim() === lookupGroup);
      const properDevName = matchedDev ? matchedDev.name : msg.sender;

      // Guard: skip rows where the sender name looks like leaked message text
      if (!matchedDev && looksLikeLeakedDeveloperLabel(properDevName)) {
        console.warn("[CHECKOUT] Skipping row: sender label looks like message text, not a developer name.");
        return;
      }
      if (looksLikeLeakedGroupLabel(String(msg.groupName || ""))) {
        console.warn("[CHECKOUT] Skipping row: invalid group name.");
        return;
      }

      const parsedRow = {
        developer: properDevName,
        groupName: msg.groupName,
        projects: extractedProjects,
        originalText: msg.messageBody,
      };

      results.push(parsedRow);
      parsedByGroup.set(toGroupKey(msg.groupName), parsedRow);
    });

    // Ensure every dev appears even when they have no checkout summary
    devRoster.forEach((dev) => {
      const key = toGroupKey(dev.group);
      if (parsedByGroup.has(key)) return;

      results.push({
        developer: dev.name,
        groupName: dev.group,
        projects: [],
        originalText: "",
      });
    });

    // Write CSV
    results.forEach((row) => {
      compiledCsv += formatCheckoutProjectsCell(row);
    });
    fs.writeFileSync(getCheckoutProjectsPath(), compiledCsv, "utf8");

    res.json({ results });
  } catch (err) {
    console.error("AI parse error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/save-checkouts
 * Manually save checkout data (e.g., after manual edits in the UI).
 *
 * Body: { results: [{ developer, groupName, projects }] }
 */
router.post("/save-checkouts", (req, res) => {
  try {
    const list = req.body.results || [];
    let compiledCsv = "Developer,Group Name,Projects\n";

    for (const item of list) {
      if (looksLikeLeakedDeveloperLabel(item.developer)) continue;
      if (looksLikeLeakedGroupLabel(String(item.groupName || ""))) continue;
      compiledCsv += formatCheckoutProjectsCell({
        developer: item.developer,
        groupName: item.groupName,
        projects: item.projects,
      });
    }

    fs.writeFileSync(getCheckoutProjectsPath(), compiledCsv, "utf8");
    res.json({ ok: true });
  } catch (err) {
    console.error("Save error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
