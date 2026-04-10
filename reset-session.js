/**
 * reset-session.js — Clear the whatsapp-web.js session data.
 * Run this if you need to re-scan the QR code (e.g., logged out or session corruption).
 *
 * Usage: node reset-session.js
 */
const fs = require('fs');
const path = require('path');

const sessionDir = path.join(__dirname, 'wwebjs_auth');
const oldBaileysAuth = path.join(__dirname, 'baileys_auth');
const oldStore = path.join(__dirname, 'baileys_store.json');
const oldPendingStore = path.join(__dirname, 'pending_store.json');
const oldLastConnected = path.join(__dirname, 'last_connected.txt');

// Clean new session
if (fs.existsSync(sessionDir)) {
  fs.rmSync(sessionDir, { recursive: true, force: true });
  console.log('✅ Deleted wwebjs_auth folder');
}

// Clean up old Baileys artifacts if they exist
for (const f of [oldBaileysAuth]) {
  if (fs.existsSync(f)) {
    fs.rmSync(f, { recursive: true, force: true });
    console.log(`✅ Cleaned up old Baileys data: ${path.basename(f)}`);
  }
}
for (const f of [oldStore, oldPendingStore, oldLastConnected]) {
  if (fs.existsSync(f)) {
    fs.unlinkSync(f);
    console.log(`✅ Cleaned up old Baileys file: ${path.basename(f)}`);
  }
}

console.log('Session reset complete! Run `npm start` to get a fresh QR code.');
