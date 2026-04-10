/**
 * csv.js — CSV reading, writing, parsing, and escaping utilities.
 *
 * All CSV file I/O for the check-in tracking system is centralized here.
 * The application uses four CSV files as its persistence layer:
 *
 *   1. employee_groups.csv  — Developer roster (name, group, checkin status, type, last text)
 *   2. repo_projects.csv    — Project-to-repository URL mappings
 *   3. repo_team.csv        — Developer name to Git alias mappings
 *   4. checkout_projects.csv — AI-parsed checkout summaries with project statuses
 *
 * CSV FORMATTING RULES:
 *   - All cells that may contain commas, quotes, or newlines are double-quoted
 *   - Internal double quotes are escaped by doubling them: " → ""
 *   - Line endings are normalized to \n on write
 */

const fs = require("fs");
const { dataPath } = require("./paths");

// ─── Constants ───────────────────────────────────────────────────────────────

/** Header row for employee_groups.csv (5 columns). */
const EMPLOYEE_GROUPS_CSV_HEADER = "Name,Group Name,Checkins,Type,Last check-in text";

/** Maximum length for stored check-in text (truncated to avoid CSV bloat). */
const CHECKIN_TEXT_MAX_LEN = 400;

// ─── File Paths ──────────────────────────────────────────────────────────────

function getEmployeeGroupsPath() {
  return dataPath("employee_groups.csv");
}

function getProjectsPath() {
  return dataPath("repo_projects.csv");
}

function getTeamPath() {
  return dataPath("repo_team.csv");
}

function getCheckoutProjectsPath() {
  return dataPath("checkout_projects.csv");
}

// ─── Generic CSV Utilities ───────────────────────────────────────────────────

/**
 * Parse a single CSV line into an array of cell values.
 * Handles double-quoted fields (with escaped inner quotes) and unquoted fields.
 *
 * @param {string} line - A single CSV row (no trailing newline)
 * @returns {string[]} Array of cell values
 */
function parseCsvLine(line) {
  const regex = /(?:^|,)(?:"([^"]*)"|([^",]*))/g;
  const cells = [];
  let match;

  while ((match = regex.exec(line))) {
    // match[1] = quoted value (without quotes), match[2] = unquoted value
    cells.push((match[1] !== undefined ? match[1] : match[2]) || "");
  }

  return cells;
}

/**
 * Wrap a value in double quotes for safe CSV embedding.
 * Any internal double quotes are escaped by doubling: " → "".
 *
 * @param {*} value - The value to escape (converted to string)
 * @returns {string} The double-quoted CSV cell
 */
function escapeCsvCell(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

/**
 * Truncate check-in text to prevent CSV files from growing too large.
 * Appends an ellipsis character if truncated.
 *
 * @param {string} text - Raw check-in message text
 * @returns {string} Truncated text
 */
function truncateCheckinText(text) {
  // Replace newlines with a space to prevent breaking CSV row formatting
  let s = String(text || "").replace(/\r?\n/g, " ").trim();
  if (!s) return "";
  if (s.length <= CHECKIN_TEXT_MAX_LEN) return s;
  return s.slice(0, CHECKIN_TEXT_MAX_LEN) + "…";
}

// ─── Group Name Normalization ────────────────────────────────────────────────

/**
 * Normalize a WhatsApp group name for consistent comparison.
 * Strips trailing ",0" or ",1" patterns that may leak from CSV checkin columns.
 *
 * @param {string} rawGroupName - Raw group name from CSV or WhatsApp
 * @returns {string} Cleaned group name
 */
function normalizeGroupName(rawGroupName) {
  const value = (rawGroupName || "").trim();
  // Remove trailing checkin flags that sometimes leak into group name column
  return value.replace(/,\s*[01]\s*$/g, "").trim();
}

/**
 * Create a lowercase key from a group name for case-insensitive matching.
 * Collapses multiple spaces into single spaces.
 *
 * @param {string} groupName - Group name to create key from
 * @returns {string} Lowercase space-normalized key
 */
function toGroupKey(groupName) {
  return normalizeGroupName(groupName).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Normalize employee type to lowercase, defaulting to 'dev'.
 * @param {string} rawType - Raw type string from CSV
 * @returns {string} Normalized type ('dev', 'qa', 'tester', 'trainee', 'va')
 */
function normalizeEmployeeType(rawType) {
  return String(rawType || "dev").trim().toLowerCase() || "dev";
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

/**
 * Detect if a "developer" label is actually leaked message text.
 * This catches cases where the WhatsApp sender name extraction failed
 * and returned part of the message body instead.
 *
 * @param {string} label - The supposed developer name
 * @returns {boolean} True if the label looks like message text, not a name
 */
function looksLikeLeakedDeveloperLabel(label) {
  const t = String(label || "").trim();
  if (!t) return true;
  if (/[\r\n]/.test(t)) return true;       // Names don't span multiple lines
  if (t.length > 120) return true;          // Names aren't this long
  if (/^[\s]*[-•*]\s/.test(t)) return true; // Bullet points = message text
  return false;
}

/**
 * Detect if a "group name" label is actually leaked message text.
 *
 * @param {string} label - The supposed group name
 * @returns {boolean} True if the label looks invalid
 */
function looksLikeLeakedGroupLabel(label) {
  const t = String(label || "").trim();
  if (!t) return true;
  if (/[\r\n]/.test(t)) return true;
  if (t.length > 200) return true;
  return false;
}

// ─── Employee Groups CSV ─────────────────────────────────────────────────────

/**
 * Read the employee groups roster from CSV.
 * Returns structured rows with name, group, type (checkins are not included
 * because the editor/catalog view doesn't need runtime checkin state).
 *
 * @returns {Array<{ name: string, group: string, type: string }>}
 */
function readEmployeeGroupsCatalog() {
  const groupsPath = getEmployeeGroupsPath();
  if (!fs.existsSync(groupsPath)) return [];

  const lines = fs.readFileSync(groupsPath, "utf8").split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length < 2) continue;

    const name = String(cells[0] || "").trim();
    const group = normalizeGroupName(cells[1]);
    const type = normalizeEmployeeType(cells[3]);
    if (!name || !group) continue;

    rows.push({ name, group, type });
  }

  // Sort alphabetically by name, then by group
  rows.sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (nameCmp !== 0) return nameCmp;
    return a.group.localeCompare(b.group, undefined, { sensitivity: "base" });
  });

  return rows;
}

/**
 * Write the employee groups roster to CSV.
 * Deduplicates by (name + group + type) and resets checkins to 0 on save
 * (the editor is for roster management, not runtime state).
 *
 * @param {Array<{ name: string, group: string, type: string }>} rows
 * @returns {Array<{ name: string, group: string, type: string }>} Cleaned rows
 */
function writeEmployeeGroupsCatalog(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const cleaned = [];
  const seen = new Set();

  for (const row of list) {
    const name = String(row?.name || "").trim();
    const group = normalizeGroupName(row?.group || "");
    const type = normalizeEmployeeType(row?.type);
    if (!name || !group) continue;

    const key = `${name.toLowerCase()}|${group.toLowerCase()}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    cleaned.push({ name, group, type });
  }

  cleaned.sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    if (nameCmp !== 0) return nameCmp;
    return a.group.localeCompare(b.group, undefined, { sensitivity: "base" });
  });

  let content = `${EMPLOYEE_GROUPS_CSV_HEADER}\n`;
  for (const row of cleaned) {
    // Reset checkins to 0 when saving from the editor — runtime state is separate
    content += `${escapeCsvCell(row.name)},${escapeCsvCell(row.group)},0,${row.type},${escapeCsvCell("")}\n`;
  }

  fs.writeFileSync(getEmployeeGroupsPath(), content, "utf8");
  return cleaned;
}

// ─── Projects Catalog CSV ────────────────────────────────────────────────────

/**
 * Read the project-to-repository mapping catalog.
 * Each project can have multiple repo links.
 *
 * @returns {Array<{ name: string, repos: string[] }>}
 */
function readProjectsCatalog() {
  const map = new Map();
  const projectsPath = getProjectsPath();
  if (!fs.existsSync(projectsPath)) return [];

  const lines = fs.readFileSync(projectsPath, "utf8").split(/\r?\n/).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = (cells[0] || "").trim();
    if (!name) continue;
    const link = (cells[1] || "").trim();
    if (!map.has(name)) map.set(name, []);
    if (link && link.toLowerCase() !== "no repo") {
      map.get(name).push(link);
    }
  }

  return Array.from(map.entries()).map(([name, repos]) => ({ name, repos }));
}

/**
 * Write the project catalog to CSV. Sorts alphabetically by project name.
 * Projects with multiple repos get one row per repo link.
 *
 * @param {Array<{ name: string, repos: string[] }>} projectsArray
 * @returns {Array<{ name: string, repos: string[] }>} Sorted array
 */
function writeProjectsCatalog(projectsArray) {
  let out = "project_name,repo_link\n";
  const sortable = [...projectsArray].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  for (const proj of sortable) {
    const name = String(typeof proj === "object" ? proj.name : proj).trim();
    if (!name) continue;
    const repos =
      typeof proj === "object" && Array.isArray(proj.repos)
        ? proj.repos.map((r) => String(r).trim()).filter(Boolean)
        : [];

    if (repos.length === 0) {
      out += `${escapeCsvCell(name)},${escapeCsvCell("")}\n`;
    } else {
      for (const link of repos) {
        if (link) out += `${escapeCsvCell(name)},${escapeCsvCell(link)}\n`;
      }
    }
  }

  fs.writeFileSync(getProjectsPath(), out, "utf8");
  return sortable;
}

// ─── Team / Alias CSV ────────────────────────────────────────────────────────

/**
 * Read the developer→Git alias mapping from repo_team.csv.
 * Aliases are semicolon-separated in the CSV. The developer name itself
 * is always included as an alias.
 *
 * @returns {Array<{ name: string, aliases: string[] }>}
 */
function readTeamCsv() {
  const csvPath = getTeamPath();
  if (!fs.existsSync(csvPath)) return [];

  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  const devs = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = (cells[0] || "").trim();
    if (!name) continue;
    const aliasesRaw = (cells[1] || "").split(";").map((a) => a.trim().toLowerCase()).filter(Boolean);
    const aliases = [...new Set([name.toLowerCase(), ...aliasesRaw])];
    devs.push({ name, aliases });
  }

  return devs;
}

// ─── Checkout Projects CSV ───────────────────────────────────────────────────

/**
 * Format a single checkout row as a CSV line.
 * Projects are serialized as "name::status" pairs joined by " | " to avoid
 * confusion with the CSV comma delimiter.
 *
 * @param {{ developer: string, groupName: string, projects: Array }} row
 * @returns {string} A single CSV line (with trailing newline)
 */
function formatCheckoutProjectsCell(row) {
  // Join project entries with " | " (pipe) instead of ", " to prevent
  // CSV parsing confusion when project names contain commas
  const pString = Array.isArray(row.projects)
    ? row.projects
        .map((p) => (typeof p === "object" && p !== null ? `${p.name}::${p.status}` : p))
        .join(" | ")
    : String(row.projects || "");

  return `${escapeCsvCell(row.developer)},${escapeCsvCell(row.groupName)},${escapeCsvCell(pString)}\n`;
}

/**
 * Read the repo_projects.csv and parse it into a Map of project name → repo info.
 * Used by the Gitea repo checking routes.
 *
 * @returns {Map<string, Array<{ link: string, owner: string, repo: string, isGitea: boolean }>>}
 */
function readRepoProjectsCsv() {
  const csvPath = getProjectsPath();
  if (!fs.existsSync(csvPath)) return new Map();

  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  const map = new Map();

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = (cells[0] || "").trim();
    const link = (cells[1] || "").trim();
    if (!name) continue;

    if (!map.has(name)) map.set(name, []);
    if (link && link.toLowerCase() !== "no repo") {
      map.get(name).push(parseRepoLink(link));
    }
  }

  return map;
}

/**
 * Parse a repository URL into owner/repo components.
 * Detects whether the repo is hosted on the Gitea instance.
 *
 * @param {string} link - Repository URL
 * @returns {{ link: string, owner: string, repo: string, isGitea: boolean }}
 */
function parseRepoLink(link) {
  const clean = link.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const isGitea = clean.includes("personalsoftware.space");
  try {
    const u = new URL(clean);
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    return { link, owner: parts[0] || "", repo: parts[1] || "", isGitea };
  } catch {
    return { link, owner: "", repo: "", isGitea };
  }
}

// ─── AI Response Normalization ───────────────────────────────────────────────

/**
 * Sanitize the LLM's mapped project dictionary.
 * LLMs sometimes return string keys or hallucinated extra keys.
 * This keeps only valid numeric indices 0..maxIndex-1.
 *
 * @param {object} raw - Raw parsed JSON from the AI response
 * @param {number} maxIndex - Number of input messages sent to the AI
 * @returns {object} Cleaned dictionary with numeric keys
 */
function normalizeMappedAiDict(raw, maxIndex) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (let i = 0; i < maxIndex; i += 1) {
    const v = raw[i] ?? raw[String(i)];
    if (Array.isArray(v)) out[i] = v;
  }
  return out;
}

module.exports = {
  // Constants
  EMPLOYEE_GROUPS_CSV_HEADER,
  CHECKIN_TEXT_MAX_LEN,

  // Paths
  getEmployeeGroupsPath,
  getProjectsPath,
  getTeamPath,
  getCheckoutProjectsPath,

  // Parsing & escaping
  parseCsvLine,
  escapeCsvCell,
  truncateCheckinText,

  // Normalization
  normalizeGroupName,
  toGroupKey,
  normalizeEmployeeType,

  // Validation
  looksLikeLeakedDeveloperLabel,
  looksLikeLeakedGroupLabel,

  // File readers/writers
  readEmployeeGroupsCatalog,
  writeEmployeeGroupsCatalog,
  readProjectsCatalog,
  writeProjectsCatalog,
  readTeamCsv,
  readRepoProjectsCsv,
  parseRepoLink,

  // Checkout formatting
  formatCheckoutProjectsCell,

  // AI normalization
  normalizeMappedAiDict,
};
