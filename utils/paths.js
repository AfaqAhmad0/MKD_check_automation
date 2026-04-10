/**
 * paths.js — Central path resolution for the check-in tracking app.
 *
 * When packaged with `pkg`, the embedded snapshot filesystem (__dirname)
 * differs from the real disk location (process.execPath). This module
 * provides two helpers:
 *   • bundlePath()  — resolves paths inside the snapshot (read-only assets)
 *   • dataPath()    — resolves paths next to the .exe (writable: CSV, .env, auth)
 *
 * In development both resolve to __dirname (the project root).
 */

const path = require("path");

/** Root directory for writable data files (CSVs, auth, .env). */
function getAppRoot() {
  if (process.pkg) {
    return path.dirname(process.execPath);
  }
  // In dev, the project root is one level up from /utils
  return path.resolve(__dirname, "..");
}

const APP_ROOT = getAppRoot();

/**
 * Resolve a path relative to the bundle snapshot (read-only in pkg builds).
 * In dev mode this is the project root.
 */
function bundlePath(...parts) {
  return path.join(path.resolve(__dirname, ".."), ...parts);
}

/**
 * Resolve a path relative to the writable data directory.
 * In pkg builds this is next to the .exe; in dev it's the project root.
 */
function dataPath(...parts) {
  return path.join(APP_ROOT, ...parts);
}

module.exports = { APP_ROOT, bundlePath, dataPath };
