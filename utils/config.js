/**
 * config.js — Config file loader for check-in tracking rules.
 *
 * Reads config.json which defines the regex rules used to classify
 * WhatsApp messages as check-in or check-out events.
 *
 * Config file location priority:
 *   1. Writable data directory (next to .exe in pkg builds)
 *   2. Bundle/snapshot directory (inside pkg or project root in dev)
 */

const fs = require("fs");
const { bundlePath, dataPath } = require("./paths");

/**
 * Determine the path to config.json, preferring the writable data directory.
 * @returns {string} Absolute path to config.json
 */
function getConfigPath() {
  const localPath = dataPath("config.json");
  if (fs.existsSync(localPath)) return localPath;
  return bundlePath("config.json");
}

/**
 * Load and parse the configuration file.
 * @returns {{ rules: Array<{ name: string, pattern: string, flags: string, action: string }> }}
 */
function loadConfig() {
  const configPath = getConfigPath();
  const rawConfig = fs.readFileSync(configPath, "utf8");
  return JSON.parse(rawConfig);
}

module.exports = { loadConfig };
