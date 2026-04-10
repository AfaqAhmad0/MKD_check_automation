/**
 * index.js — Main entry point for the Check-in Tracking Dashboard.
 *
 * This file handles:
 *   1. Express server setup and static file serving
 *   2. SSE (Server-Sent Events) for real-time UI updates
 *   3. whatsapp-web.js WhatsApp connection (headless Chrome)
 *   4. Check-in detection from live and historical WhatsApp messages
 *
 * Route handlers are split into separate files under /routes:
 *   - routes/groups.js    — Employee group roster CRUD
 *   - routes/projects.js  — Project catalog CRUD
 *   - routes/checkout.js  — AI checkout processing
 *   - routes/gitea.js     — Gitea repo commit checking
 *   - routes/settings.js  — AI key status
 *
 * Utility modules under /utils:
 *   - utils/csv.js        — All CSV read/write/parse helpers
 *   - utils/message.js    — WhatsApp message body extraction
 *   - utils/config.js     — Config file loading
 *   - utils/paths.js      — Path resolution for pkg/dev environments
 */

const fs = require("fs");
const path = require("path");

// ─── Module Imports ──────────────────────────────────────────────────────────
const { APP_ROOT, bundlePath, dataPath } = require("./utils/paths");
const { loadConfig } = require("./utils/config");
const {
  EMPLOYEE_GROUPS_CSV_HEADER,
  getEmployeeGroupsPath,
  parseCsvLine,
  escapeCsvCell,
  truncateCheckinText,
  normalizeGroupName,
  toGroupKey,
  normalizeEmployeeType,
} = require("./utils/csv");
const { matchRules } = require("./matcher");

// ─── Seed Data Files ─────────────────────────────────────────────────────────
// On first run, copy default CSV files to the data directory if they don't exist.
function ensureSeedDataFiles() {
  for (const name of ["repo_projects.csv", "repo_team.csv"]) {
    const dest = dataPath(name);
    const src = bundlePath(name);
    if (!fs.existsSync(dest) && fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dest);
        console.log("[SETUP] Seeded", name, "into", APP_ROOT);
      } catch (e) {
        console.warn("[WARN] Could not seed", name, ":", e.message);
      }
    }
  }
}
ensureSeedDataFiles();

// ─── Environment Configuration ───────────────────────────────────────────────
require("dotenv").config({ path: path.join(APP_ROOT, ".env") });

const express = require("express");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum number of messages to fetch per group on each scan. */
const HISTORY_FETCH_LIMIT = 500;

/** Directory for whatsapp-web.js session data (headless Chrome profile). */
const SESSION_DIR = dataPath("wwebjs_auth");

// ─── Public Directory Resolution ─────────────────────────────────────────────

function resolvePublicDir() {
  function tryReadIndex(dir) {
    try {
      fs.readFileSync(path.join(dir, "index.html"));
      return dir;
    } catch {
      return null;
    }
  }

  const ordered = [];
  if (process.pkg) {
    ordered.push(path.join(path.dirname(process.execPath), "public"));
  }
  ordered.push(
    path.join(__dirname, "public"),
    path.join(__dirname, "dist", "public"),
    path.join(__dirname, "..", "public"),
    path.join(__dirname, "..", "checkin_tracking", "dist", "public"),
    path.join(__dirname, "..", "checkin-tracking", "dist", "public")
  );

  let walk = __dirname;
  for (let depth = 0; depth < 10; depth++) {
    ordered.push(path.join(walk, "public"));
    ordered.push(path.join(walk, "dist", "public"));
    const parent = path.dirname(walk);
    if (parent === walk) break;
    walk = parent;
  }

  const seen = new Set();
  for (const d of ordered) {
    const norm = path.resolve(d);
    if (seen.has(norm)) continue;
    seen.add(norm);
    const found = tryReadIndex(norm);
    if (found) return found;
  }

  console.warn(
    "[UI] public/index.html not found; tried",
    seen.size,
    "paths."
  );
  return path.join(__dirname, "public");
}

const PUBLIC_DIR = resolvePublicDir();

// ─── Express Server Setup ────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/", (req, res, next) => {
  res.sendFile(path.resolve(PUBLIC_DIR, "index.html"), (err) => {
    if (err) next(err);
  });
});
app.get("/checkout.html", (req, res, next) => {
  res.sendFile(path.resolve(PUBLIC_DIR, "checkout.html"), (err) => {
    if (err) next(err);
  });
});
app.use(express.static(PUBLIC_DIR, { index: "index.html" }));

// ─── SSE (Server-Sent Events) ────────────────────────────────────────────────

const sseClients = new Set();
let botState = "init";
let botText = "Connecting to WhatsApp...";
let qrString = "";

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function updateState(state, text) {
  botState = state;
  botText = text;
  broadcastEvent("state", { state, text });
}

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.get("/api/status", (req, res) => res.json({ state: botState, text: botText }));
app.get("/api/qr", (req, res) => res.json({ qr: qrString || "" }));

// ─── Runtime State ───────────────────────────────────────────────────────────

/** In-memory representation of employee_groups.csv. */
const csvData = [];

/** All WhatsApp group chats fetched from the connected account. */
let allGroupChats = [];

/** Set of WhatsApp group IDs we're actively monitoring. */
const targetGroupIds = new Set();

/** Map of groupId → human-readable group name. */
const groupNameById = new Map();

/** Set of processed message IDs to prevent duplicates. */
const loggedMessageIds = new Set();

/** Lifecycle flags. */
let readySyncInProgress = false;
let startupScanCompleted = false;
let liveMonitoringEnabled = false;
let readyAnnounced = false;
let isWritingCsv = false;

/** The whatsapp-web.js Client instance. */
let waClient = null;

/** Callback set by startWhatsApp() — triggered on Start Scan click. */
let _triggerPerformReadySync = null;

// ─── Utility Functions ───────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearMatchCache() {
  loggedMessageIds.clear();
  console.log("[HARD_RESCAN] Cleared in-memory message cache.");
}

/**
 * Classify a message as check-in, check-out, or neither.
 */
function classifyCheckinCheckoutMessage(messageBody, config) {
  const matchedRules = matchRules(messageBody, config.rules);
  const checkoutRegex =
    /(?:check(?:ed|ing|s)?[\s-]?out|work[\s-]*summary|repo[\s-]*update[\s-]*status|video[\s-]*summary)/i;
  const isCheckout = checkoutRegex.test(messageBody) || matchedRules.includes("checkout_detection");
  const matches = matchedRules.includes("checkin_detection") || isCheckout;
  const rulesForPayload =
    matchedRules.length > 0 ? matchedRules : matches ? ["checkout_detection"] : [];
  return { matchedRules, matches, rulesForPayload };
}

/**
 * Get a human-readable sender label from a whatsapp-web.js message.
 */
function getSenderLabel(msg) {
  // whatsapp-web.js provides _data.notifyName or author for group messages
  return (
    msg._data?.notifyName ||
    msg.author?.split("@")[0] ||
    msg.from?.split("@")[0] ||
    "unknown"
  );
}

/**
 * Extract text body from a whatsapp-web.js message.
 * whatsapp-web.js normalizes message content into msg.body for most types.
 */
function extractWWebMessageBody(msg) {
  if (!msg) return "";
  // msg.body contains the text for text messages, captions for media, etc.
  return msg.body || "";
}

// ─── CSV Loading & Saving ────────────────────────────────────────────────────

function loadCsv() {
  try {
    const egPath = getEmployeeGroupsPath();
    if (!fs.existsSync(egPath)) return;

    const content = fs.readFileSync(egPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);

    csvData.length = 0;
    targetGroupIds.clear();
    groupNameById.clear();

    const newTargetGroupNames = new Set();

    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      if (cells.length < 2) continue;

      const name = (cells[0] || "").trim();
      const groupName = normalizeGroupName(cells[1]);
      const checkinsRaw = (cells[2] || "0").trim();
      const checkins = checkinsRaw === "1" ? 1 : 0;
      const type = normalizeEmployeeType(cells[3]);
      const checkinText = cells.length > 4 ? String(cells[4] || "").trim() : "";

      csvData.push({ name, group: groupName, checkin: checkins, type, checkinText });
      newTargetGroupNames.add(groupName);
    }

    // Map CSV group names to WhatsApp group IDs by case-insensitive matching
    const groupsByKey = new Map();
    for (const group of allGroupChats) {
      const key = toGroupKey(group.name);
      if (!groupsByKey.has(key)) groupsByKey.set(key, group);
    }

    const foundGroupNames = new Set();
    for (const row of csvData) {
      const matchedGroup = groupsByKey.get(toGroupKey(row.group));
      if (!matchedGroup) continue;

      row.groupId = matchedGroup.id;
      targetGroupIds.add(matchedGroup.id);
      groupNameById.set(matchedGroup.id, matchedGroup.name);
      foundGroupNames.add(row.group);
    }

    if (allGroupChats.length > 0) {
      for (const targetName of newTargetGroupNames) {
        if (!foundGroupNames.has(targetName)) {
          console.warn(
            `[WARN] Target group '${targetName}' from CSV was NOT found in WhatsApp chats!`
          );
        }
      }
    }
  } catch (err) {
    console.error("[CSV_ERROR] Failed to read employee_groups.csv:", err.message);
  }
}

function saveCsv() {
  isWritingCsv = true;
  let csvContent = `${EMPLOYEE_GROUPS_CSV_HEADER}\n`;
  for (const row of csvData) {
    const safeType = (row.type || "dev").toString().trim().toLowerCase() || "dev";
    const text = row.checkinText != null ? String(row.checkinText) : "";
    csvContent += `${escapeCsvCell(row.name)},${escapeCsvCell(row.group)},${row.checkin},${safeType},${escapeCsvCell(text)}\n`;
  }
  fs.writeFileSync(getEmployeeGroupsPath(), csvContent, "utf8");
  setTimeout(() => {
    isWritingCsv = false;
  }, 1000);
}

// Watch for external changes to employee_groups.csv
try {
  fs.watch(getEmployeeGroupsPath(), (eventType) => {
    if (!isWritingCsv && eventType === "change") {
      console.log("[CSV_SYNC] External change detected in employee_groups.csv. Reloading...");
      loadCsv();
      console.log(`[CSV_SYNC] Now monitoring ${targetGroupIds.size} group(s).`);
      broadcastEvent("live_update", {});
    }
  });
} catch (err) {
  console.warn("[WARN] Could not setup file watcher on employee_groups.csv.");
}

// ─── Core API Routes ─────────────────────────────────────────────────────────

app.get("/api/data", (req, res) => res.json(csvData));

app.post("/api/update", (req, res) => {
  const { name, group, checkin } = req.body;
  let updated = false;
  for (const row of csvData) {
    if (row.name === name && row.group === group) {
      row.checkin = checkin;
      if (checkin === 0) row.checkinText = "";
      updated = true;
    }
  }
  if (updated) {
    saveCsv();
    broadcastEvent("live_update", {});
  }
  res.json({ success: updated });
});

// Temporary debug endpoint to discover WhatsApp Web DOM structure
app.get("/api/debug-dom", async (req, res) => {
  try {
    if (!waClient || !waClient.pupPage) return res.json({ error: "No page" });
    const page = waClient.pupPage;
    
    // First open a specific chat
    const jid = req.query.jid;
    if (jid) {
      await page.evaluate(async (jid) => {
        try {
          const chat = window.Store?.Chat?.get(jid);
          if (chat && window.Store.OpenChat) await window.Store.OpenChat.open(chat);
          else if (chat?.open) await chat.open();
        } catch(e) {}
      }, jid);
      await new Promise(r => setTimeout(r, 2000));
    }

    const info = await page.evaluate(() => {
      const result = {};
      result.dataIdCount = document.querySelectorAll("[data-id]").length;
      result.messageIn = document.querySelectorAll("div.message-in").length;
      result.messageOut = document.querySelectorAll("div.message-out").length;
      result.copyable = document.querySelectorAll("span.copyable-text").length;
      result.selectable = document.querySelectorAll("span.selectable-text").length;
      result.rows = document.querySelectorAll('[role="row"]').length;
      
      // Check what Store methods are available for opening chat
      result.storeKeys = Object.keys(window.Store || {}).sort();
      result.hasOpenChat = !!(window.Store && window.Store.OpenChat);
      result.hasCmd = !!(window.Store && window.Store.Cmd);
      result.cmdKeys = window.Store?.Cmd ? Object.keys(window.Store.Cmd).slice(0, 20) : [];
      
      // Check ChatModel prototype methods
      if (window.Store?.Chat) {
        const chat = window.Store.Chat.getModelsArray ? window.Store.Chat.getModelsArray()[0] : null;
        if (chat) {
          result.chatProtoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(chat)).filter(k => typeof chat[k] === 'function').slice(0, 30);
        }
      }
      
      // Get all unique data-testid values
      const testIds = new Set();
      document.querySelectorAll("[data-testid]").forEach(el => testIds.add(el.getAttribute("data-testid")));
      result.testIds = [...testIds].sort();
      
      // Sample first few message-like elements
      result.samples = [];
      const candidates = document.querySelectorAll('[data-id], div.message-in, div.message-out, [role="row"]');
      for (let i = 0; i < Math.min(5, candidates.length); i++) {
        result.samples.push({
          tag: candidates[i].tagName,
          class: candidates[i].className?.slice(0, 200),
          dataId: candidates[i].getAttribute("data-id"),
          html: candidates[i].outerHTML.slice(0, 500)
        });
      }
      
      // Also get the main content area HTML structure (first 2000 chars)
      const main = document.querySelector("#main") || document.querySelector('[data-tab="8"]');
      result.mainHTML = main ? main.innerHTML.slice(0, 3000) : "NO #main FOUND";
      
      return result;
    });
    
    res.json(info);
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post("/api/start-scan", (req, res) => {
  try {
    const hours = req.body.hours || 24;
    const hardRescan = Boolean(req.body.hardRescan);
    if (hardRescan) clearMatchCache();
    if (_triggerPerformReadySync) {
      _triggerPerformReadySync(hours, hardRescan);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/reset", (req, res) => {
  if (readySyncInProgress) return res.json({ ok: false });
  startupScanCompleted = false;
  liveMonitoringEnabled = false;
  updateState("ready", "Monitoring Suspended. Configure New Scan.");
  res.json({ ok: true });
});

// ─── Mount Route Modules ─────────────────────────────────────────────────────

app.locals.onGroupsSaved = () => {
  loadCsv();
  broadcastEvent("live_update", {});
};

app.locals.triggerPerformReadySync = (...args) => {
  if (_triggerPerformReadySync) return _triggerPerformReadySync(...args);
  return [];
};

app.locals.clearMatchCache = clearMatchCache;

app.use("/api/groups", require("./routes/groups"));
app.use("/api/projects", require("./routes/projects"));
app.use("/api", require("./routes/checkout"));
app.use("/api", require("./routes/gitea"));
app.use("/api", require("./routes/settings"));

// ─── whatsapp-web.js Connection ──────────────────────────────────────────────

/**
 * Boot the Express server and connect to WhatsApp via headless Chrome.
 *
 * whatsapp-web.js uses Puppeteer to run a real Chromium browser that
 * connects to web.whatsapp.com. This means:
 *   - Sessions persist across restarts (LocalAuth saves the Chrome profile)
 *   - Offline messages are automatically synced (just like opening WhatsApp Web)
 *   - No encryption key staleness issues
 *   - Messages can be actively fetched with chat.fetchMessages()
 */
async function startWhatsApp() {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log("[UI] Launching the interactive Web Dashboard!");
    console.log(`[UI] => Please open http://localhost:${PORT} in your browser.`);
    console.log(`[UI] Data directory: ${APP_ROOT}`);
    console.log(`[UI] Web UI from: ${PUBLIC_DIR}`);
  });

  // Create the whatsapp-web.js client with local auth persistence.
  // Uses puppeteer-core + system Chrome to avoid downloading a separate Chromium.
  const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  console.log(`[WHATSAPP] Using system Chrome: ${CHROME_PATH}`);

  waClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: SESSION_DIR,
    }),
    // Do NOT use webVersionCache — pinning to a specific/alpha version causes
    // WhatsApp to auto-refresh the page to the latest stable release, which
    // destroys the Puppeteer execution context and breaks all API calls.
    // Let whatsapp-web.js load whatever version WhatsApp serves natively.
    puppeteer: {
      headless: true,
      executablePath: CHROME_PATH,
      protocolTimeout: 300_000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--disable-background-timer-throttling",
      ],
    },
  });

  // ── QR Code ──────────────────────────────────────────────────────────
  waClient.on("qr", (qr) => {
    console.log("[WHATSAPP] QR received. Scan with your phone.");
    qrcode.generate(qr, { small: true });
    qrString = qr;
    updateState("qr", "Authentication Required. Please scan QR.");
    broadcastEvent("qr", qr);
  });

  // ── Authentication ───────────────────────────────────────────────────
  waClient.on("authenticated", () => {
    console.log("[WHATSAPP] Authenticated successfully.");
  });

  waClient.on("auth_failure", (msg) => {
    console.error("[WHATSAPP] Auth failure:", msg);
    updateState("qr", "Authentication failed. Please scan QR again.");
  });

  // ── Ready ────────────────────────────────────────────────────────────
  waClient.on("ready", async () => {
    console.log("[WHATSAPP] Client is ready!");
    qrString = "";
    updateState("init", "Loading WhatsApp groups...");

    try {
      // Use a lightweight direct query instead of the heavy getChats() method.
      // getChats() serializes ALL chats (393+) with full metadata — takes 5+ min.
      // This direct store query only pulls group IDs and names — runs in <1 second.
      await delay(3000); // Brief pause to let WhatsApp Web's store initialize

      const groups = await waClient.pupPage.evaluate(() => {
        // Discover the correct store reference — whatsapp-web.js injects window.Store
        const store = window.Store && window.Store.Chat;
        if (!store) return { error: "no_store", keys: Object.keys(window.Store || {}).slice(0, 20) };

        // Try multiple methods to get the chat models array
        let models = [];
        if (typeof store.getModelsArray === "function") {
          models = store.getModelsArray();
        } else if (store._models && Array.isArray(store._models)) {
          models = store._models;
        } else if (store.models && typeof store.models === "object") {
          models = Array.from(store.models.values ? store.models.values() : []);
        } else if (Array.isArray(store)) {
          models = store;
        }

        if (models.length === 0) {
          // Debug: what does the store look like?
          const sample = store;
          const info = {
            type: typeof sample,
            constructor: sample?.constructor?.name,
            keys: Object.keys(sample || {}).slice(0, 30),
            hasLength: "length" in (sample || {}),
            length: sample?.length,
          };
          return { error: "no_models", storeInfo: info, totalChats: 0 };
        }

        // Check first model to discover property names
        const first = models[0];
        const sampleProps = first ? {
          hasIsGroup: "isGroup" in first,
          hasId: "id" in first,
          hasName: "name" in first,
          hasFormattedTitle: "formattedTitle" in first,
          hasContact: "contact" in first,
          idType: typeof first.id,
          sample_id: first.id?._serialized || first.id?.toString?.() || String(first.id),
        } : null;

        // Filter to groups — try multiple approaches
        const groupModels = models.filter((c) => {
          if (typeof c.isGroup === "boolean") return c.isGroup;
          // Group JIDs end with @g.us
          const jid = c.id?._serialized || c.id?.toString?.() || "";
          return jid.endsWith("@g.us");
        });

        return {
          total: models.length,
          groups: groupModels.map((c) => ({
            id: c.id?._serialized || c.id?.toString?.() || "",
            name: c.formattedTitle || c.name || c.contact?.name || c.id?._serialized || "",
          })),
          sampleProps,
        };
      });

      // Handle diagnostic/error results
      if (groups.error) {
        console.warn(`[WHATSAPP] Store query issue: ${groups.error}`, JSON.stringify(groups).slice(0, 500));
        throw new Error(`Store issue: ${groups.error}`);
      }

      console.log(`[WHATSAPP] Store has ${groups.total} total chats, ${groups.groups.length} groups`);
      if (groups.sampleProps) {
        console.log(`[WHATSAPP] Sample model props:`, JSON.stringify(groups.sampleProps));
      }

      allGroupChats = groups.groups.map((g) => ({
        id: g.id,
        name: g.name,
        isGroup: true,
      }));

      console.log(`[WHATSAPP] Found ${allGroupChats.length} group chats.`);
      loadCsv();
      readyAnnounced = true;
      updateState(
        "ready",
        "WhatsApp connected. Choose lookback hours and click Start Scan."
      );
    } catch (err) {
      console.warn(`[WHATSAPP] Could not fetch groups: ${err.message}`);
      // Fallback: try the normal getChats() in case the store query fails
      try {
        console.log("[WHATSAPP] Trying fallback getChats()...");
        const chats = await waClient.getChats();
        allGroupChats = chats
          .filter((c) => c.isGroup)
          .map((c) => ({
            id: c.id._serialized,
            name: c.name,
            isGroup: true,
          }));
        console.log(`[WHATSAPP] Fallback found ${allGroupChats.length} group chats.`);
      } catch (fallbackErr) {
        console.warn(`[WHATSAPP] Fallback also failed: ${fallbackErr.message}`);
        allGroupChats = [];
      }
      loadCsv();
      readyAnnounced = true;
      updateState(
        "ready",
        allGroupChats.length > 0
          ? "WhatsApp connected. Choose lookback hours and click Start Scan."
          : "WhatsApp connected but group list failed to load. Restart to retry."
      );
    }
  });

  // ── Live Message Listener ────────────────────────────────────────────
  // Real-time check-in detection for messages arriving while monitoring.
  waClient.on("message", (msg) => {
    if (!liveMonitoringEnabled) return;
    const jid = msg.from;
    if (!jid || !targetGroupIds.has(jid)) return;

    const messageBody = extractWWebMessageBody(msg);
    if (!messageBody) return;

    const config = loadConfig();
    const { matchedRules, matches } = classifyCheckinCheckoutMessage(messageBody, config);

    if (matches && matchedRules.includes("checkin_detection")) {
      let updated = false;
      for (const row of csvData) {
        if (row.groupId === jid) {
          row.checkin = 1;
          row.checkinText = truncateCheckinText(messageBody);
          updated = true;
        }
      }
      if (updated) {
        saveCsv();
        broadcastEvent("live_update", {});
        console.log(`[LIVE_OP] Caught check-in for group: ${jid}`);
      }
    }
  });

  // ── Disconnected ─────────────────────────────────────────────────────
  waClient.on("disconnected", (reason) => {
    console.warn(`[WHATSAPP] Disconnected: ${reason}`);
    readyAnnounced = false;
    startupScanCompleted = false;
    liveMonitoringEnabled = false;
    updateState("init", "Disconnected. Reconnecting...");
    // whatsapp-web.js will attempt to reconnect automatically
  });

  // ── History Scan Function ────────────────────────────────────────────
  // This is the core scan logic, triggered by Start Scan click.
  // Uses chat.fetchMessages() to ACTIVELY pull messages from WhatsApp Web,
  // rather than relying on a passive in-memory store.
  //
  // This is the key advantage over Baileys: messages are fetched on demand
  // from WhatsApp's servers, so it doesn't matter if the bot was offline.

  _triggerPerformReadySync = async (lookbackHours, force = false) => {
    if (!readyAnnounced || readySyncInProgress || (!force && startupScanCompleted)) return [];
    readySyncInProgress = true;
    const collectedMatches = [];
    const config = loadConfig();

    try {
      liveMonitoringEnabled = true;
      updateState("scanning", "Scanning past history...");
      const scanThresholdMs = Date.now() - lookbackHours * 60 * 60 * 1000;

      // Reset all check-in statuses before scanning
      loadCsv();
      for (const row of csvData) {
        row.checkin = 0;
        row.checkinText = "";
      }

      const targetIds = [...targetGroupIds];
      if (targetIds.length === 0) {
        console.warn(
          "[SCAN] No monitored groups mapped from employee_groups.csv. Names must match WhatsApp exactly."
        );
      } else {
        console.log(`[SCAN] Monitoring ${targetIds.length} group(s).`);
      }

      let i = 0;
      const totalToScan = targetIds.length || 1;

      for (const groupId of targetIds) {
        i++;
        const groupName = groupNameById.get(groupId) || groupId;
        const percentage = Math.round((i / totalToScan) * 100);
        broadcastEvent("progress", { percentage, groupName });

        try {
          // SIMPLE DIRECT FETCH FLOW
          // As requested, this fetches messages directly from WhatsApp's internal store
          // for the target group, without any complex loops or timeouts.
          const msgs = await waClient.pupPage.evaluate((jid, limit, lookbackSec) => {
            const limitTime = Math.floor(Date.now() / 1000) - lookbackSec;

            if (!window.Store || !window.Store.Msg) return [];
            
            // Get all messages currently known to WhatsApp Web
            let allMsgs = [];
            if (typeof window.Store.Msg.getModelsArray === "function") {
              allMsgs = window.Store.Msg.getModelsArray();
            } else if (Array.isArray(window.Store.Msg.models)) {
              allMsgs = window.Store.Msg.models;
            } else if (Array.isArray(window.Store.Msg._models)) {
              allMsgs = window.Store.Msg._models;
            }

            // Filter for this specific group and time range
            return allMsgs
              .filter(m => m && (m.from === jid || m.to === jid || (m.id && m.id.remote === jid)) && m.t >= limitTime)
              .map(m => ({
                body: m.body || m.caption || m.text || "",
                timestamp: m.t || 0,
                id: m.id?._serialized || String(m.id) || "",
                author: m.author?._serialized || m.author || "",
                from: jid,
                _data: { notifyName: m.notifyName || m.senderObj?.notifyName || m.sender?.notifyName || "" }
              }))
              .slice(-limit);
          }, groupId, HISTORY_FETCH_LIMIT, lookbackHours * 3600);

          console.log(`[SCAN] Group '${groupName}': fetched ${msgs.length} messages.`);

          for (const msg of msgs) {
            const msgTimestampMs = (msg.timestamp || 0) * 1000;
            if (!Number.isFinite(msgTimestampMs) || msgTimestampMs < scanThresholdMs) continue;

            const messageBody = extractWWebMessageBody(msg);
            if (!messageBody) continue;

            const { matchedRules, matches, rulesForPayload } =
              classifyCheckinCheckoutMessage(messageBody, config);
            if (!matches) continue;

            // Check-in detection
            if (matchedRules.includes("checkin_detection")) {
              for (const row of csvData) {
                if (row.groupId === groupId) {
                  row.checkin = 1;
                  row.checkinText = truncateCheckinText(messageBody);
                }
              }
            }

            const messageId = typeof msg.id === "string" ? msg.id : (msg.id?._serialized || msg.id?.id);
            if (!force && messageId && loggedMessageIds.has(messageId)) continue;

            const matchPayload = {
              timestamp: new Date(msgTimestampMs).toISOString(),
              groupName,
              sender: getSenderLabel(msg),
              messageBody,
              matchedRules: rulesForPayload,
            };

            collectedMatches.push(matchPayload);
            if (messageId) loggedMessageIds.add(messageId);
          }
        } catch (error) {
          console.error(`[SCAN_ERROR] Group '${groupName}': ${error.message}\n${error.stack}`);
        }
      }

      saveCsv();
      startupScanCompleted = true;
      updateState("monitoring", "Live monitoring is active.");
      console.log("[STARTUP] Historical scan complete. Fetched " + collectedMatches.length + " matches.");

      return collectedMatches;
    } catch (error) {
      console.error(`[READY_ERROR] ${error.message}`);
      liveMonitoringEnabled = false;
      return collectedMatches;
    } finally {
      readySyncInProgress = false;
    }
  };

  // ── Initialize ───────────────────────────────────────────────────────
  console.log("[WHATSAPP] Initializing headless Chrome...");
  updateState("init", "Starting WhatsApp Web (headless Chrome)...");
  await waClient.initialize();
}

// ─── Global Error Handlers ───────────────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error(`[UNHANDLED_REJECTION] ${reason instanceof Error ? reason.message : String(reason)}`);
});

process.on("uncaughtException", (error) => {
  console.error(`[UNCAUGHT_EXCEPTION] ${error.message}`);
});

// ─── Boot ────────────────────────────────────────────────────────────────────

startWhatsApp().catch((error) => {
  console.error(`[FATAL_STARTUP] ${error.message}`);
  process.exit(1);
});