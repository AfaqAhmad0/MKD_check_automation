/**
 * diagnose.js — Connects to WhatsApp with the existing session and logs
 * exactly what Baileys delivers. Run this INSTEAD of the main app to see
 * whether offline messages are actually arriving.
 *
 * Usage: node diagnose.js
 * Then wait ~30 seconds and check the output.
 */

require("dotenv/config");
const nodeCrypto = require("crypto");
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto?.subtle) {
  globalThis.crypto = nodeCrypto.webcrypto;
}

const fs = require("fs");
const path = require("path");
const { dataPath } = require("./utils/paths");
const { extractMessageBody } = require("./utils/message");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestWaWebVersion,
} = require("@whiskeysockets/baileys");

const AUTH_DIR = dataPath("baileys_auth");
const STORE_PATH = dataPath("baileys_store.json");
const PENDING_STORE_PATH = dataPath("pending_store.json");

// Counters
let upsertNotifyCount = 0;
let upsertAppendCount = 0;
let historySetCount = 0;
let totalHistoryMsgs = 0;
let pendingNotificationsReceived = false;
const groupMessageCounts = new Map(); // jid -> count of messages received

async function run() {
  console.log("=== BAILEYS DIAGNOSTIC ===");
  console.log(`Auth dir: ${AUTH_DIR}`);
  console.log(`Auth exists: ${fs.existsSync(AUTH_DIR)}`);
  console.log(`Store file exists: ${fs.existsSync(STORE_PATH)}`);
  console.log(`Pending store exists: ${fs.existsSync(PENDING_STORE_PATH)}`);

  // Check existing store
  if (fs.existsSync(STORE_PATH)) {
    try {
      const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
      console.log(`\nExisting baileys_store.json: ${store.length} groups`);
      for (const [jid, msgs] of store) {
        if (msgs.length > 0) {
          const oldest = new Date((msgs[0].messageTimestamp || 0) * 1000);
          const newest = new Date((msgs[msgs.length - 1].messageTimestamp || 0) * 1000);
          console.log(`  ${jid}: ${msgs.length} msgs (${oldest.toISOString()} → ${newest.toISOString()})`);
        }
      }
    } catch (e) {
      console.log(`  Error reading store: ${e.message}`);
    }
  }

  if (fs.existsSync(PENDING_STORE_PATH)) {
    try {
      const pending = JSON.parse(fs.readFileSync(PENDING_STORE_PATH, "utf8"));
      console.log(`\nExisting pending_store.json: ${pending.length} groups`);
      for (const [jid, msgs] of pending) {
        console.log(`  ${jid}: ${msgs.length} msgs`);
      }
    } catch (e) {
      console.log(`  Error reading pending store: ${e.message}`);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let waVersion;
  try {
    const { version } = await fetchLatestWaWebVersion({});
    waVersion = version;
    console.log(`\nWA Web version: ${version}`);
  } catch (e) {
    console.log("\nCould not fetch WA version, using default");
  }

  const sock = makeWASocket({
    auth: state,
    browser: Browsers.ubuntu("CheckinTracker"),
    ...(waVersion ? { version: waVersion } : {}),
    syncFullHistory: true,
    shouldSyncHistoryMessage: () => true,
    generateHighQualityLinkPreview: false,
  });

  const startTime = Date.now();

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    for (const msg of messages) {
      const jid = msg.key?.remoteJid || "unknown";
      const isGroup = jid.endsWith("@g.us");
      if (!isGroup) continue;

      if (type === "notify") upsertNotifyCount++;
      if (type === "append") upsertAppendCount++;

      groupMessageCounts.set(jid, (groupMessageCounts.get(jid) || 0) + 1);

      // Check if it has extractable text
      const body = extractMessageBody(msg.message);
      const ts = new Date((msg.messageTimestamp || 0) * 1000);
      const age = Math.round((Date.now() - ts.getTime()) / 3600000);

      if (body && /check[\s-]?in/i.test(body)) {
        console.log(`  [CHECKIN FOUND] type=${type} group=${jid} age=${age}h sender=${msg.pushName || msg.key?.participant || "?"}`);
        console.log(`    text: ${body.substring(0, 120)}`);
      }
    }
  });

  sock.ev.on("messaging-history.set", ({ messages }) => {
    historySetCount++;
    totalHistoryMsgs += messages.length;
    let groupMsgs = 0;
    for (const msg of messages) {
      const jid = msg.key?.remoteJid || "";
      if (jid.endsWith("@g.us")) {
        groupMsgs++;
        groupMessageCounts.set(jid, (groupMessageCounts.get(jid) || 0) + 1);

        const body = extractMessageBody(msg.message);
        const ts = new Date((msg.messageTimestamp || 0) * 1000);
        const age = Math.round((Date.now() - ts.getTime()) / 3600000);

        if (body && /check[\s-]?in/i.test(body)) {
          console.log(`  [HISTORY CHECKIN] group=${jid} age=${age}h sender=${msg.pushName || msg.key?.participant || "?"}`);
          console.log(`    text: ${body.substring(0, 120)}`);
        }
      }
    }
    console.log(`[HISTORY_SET #${historySetCount}] ${messages.length} total, ${groupMsgs} group msgs`);
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;

    if (qr) {
      console.log("\n[QR CODE RECEIVED] — You need to scan QR. Session may be expired.");
      console.log("Run: node reset-session.js && npm start (then scan QR there)");
      process.exit(1);
    }

    if (receivedPendingNotifications) {
      pendingNotificationsReceived = true;
      console.log(`\n[PENDING NOTIFICATIONS COMPLETE] All offline messages delivered.`);
      printReport();
    }

    if (connection === "open") {
      console.log(`\n[CONNECTED] at ${new Date().toISOString()}`);
      console.log("Waiting for offline messages to arrive...");

      // Print periodic status
      const interval = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`\n--- ${elapsed}s elapsed ---`);
        console.log(`  upsert notify: ${upsertNotifyCount}, append: ${upsertAppendCount}`);
        console.log(`  history.set batches: ${historySetCount} (${totalHistoryMsgs} msgs)`);
        console.log(`  groups with messages: ${groupMessageCounts.size}`);
        console.log(`  pendingNotifications received: ${pendingNotificationsReceived}`);
      }, 10000);

      // After 60s, print final report regardless
      setTimeout(() => {
        clearInterval(interval);
        console.log("\n=== 60 SECOND TIMEOUT ===");
        printReport();
        process.exit(0);
      }, 60000);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[DISCONNECTED] code=${code}`);
      if (code === DisconnectReason.loggedOut) {
        console.log("Session logged out. Run: node reset-session.js");
      }
      process.exit(1);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  function printReport() {
    console.log("\n========== DIAGNOSTIC REPORT ==========");
    console.log(`messages.upsert (notify): ${upsertNotifyCount}`);
    console.log(`messages.upsert (append): ${upsertAppendCount}`);
    console.log(`messaging-history.set batches: ${historySetCount}`);
    console.log(`messaging-history.set total msgs: ${totalHistoryMsgs}`);
    console.log(`receivedPendingNotifications: ${pendingNotificationsReceived}`);
    console.log(`\nGroups that received messages:`);

    const sorted = [...groupMessageCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [jid, count] of sorted) {
      console.log(`  ${jid}: ${count} messages`);
    }

    if (groupMessageCounts.size === 0) {
      console.log("  (NONE — Baileys received zero group messages)");
      console.log("\n  DIAGNOSIS: Baileys is NOT delivering offline messages.");
      console.log("  This means the WhatsApp session cannot see past group messages.");
      console.log("  You need to re-link (reset-session.js + scan QR) to get a fresh sync.");
    }

    console.log("========================================\n");
  }
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
