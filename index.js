const fs = require("fs");
const path = require("path");
require("dotenv").config();
const express = require("express");
const qrcode = require("qrcode-terminal");
const { Client, NoAuth } = require("whatsapp-web.js");
const { matchRules } = require("./matcher");

const HISTORY_FETCH_LIMIT = 500;

// Setup Express UI Server
const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: '10mb' }));

const sseClients = new Set();
let botState = 'init';
let botText = 'Connecting to WhatsApp...';
let qrString = '';

function broadcastEvent(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function updateState(state, text) {
  botState = state;
  botText = text;
  broadcastEvent('state', { state, text });
}

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('/api/status', (req, res) => res.json({ state: botState, text: botText }));
app.get('/api/qr', (req, res) => res.json({ qr: qrString || '' }));

// Globals
const csvData = [];
let allGroupChats = [];
const targetGroupIds = new Set();
const groupNameById = new Map();
const loggedMessageIds = new Set();
let readySyncInProgress = false;
let startupScanCompleted = false;
let readyAnnounced = false;
let isWritingCsv = false;
let _triggerPerformReadySync = null;

// Error normalization utilities
function normalizeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isTransientExecutionContextError(error) {
  const message = normalizeError(error).toLowerCase();
  return (
    message.includes("execution context was destroyed") ||
    message.includes("cannot find context with specified id") ||
    message.includes("target closed") ||
    message.includes("navigation")
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearMatchCache() {
  loggedMessageIds.clear();
  console.log('[HARD_RESCAN] Cleared in-memory message cache.');
}

function loadConfig() {
  const configPath = path.resolve(__dirname, "config.json");
  const rawConfig = fs.readFileSync(configPath, "utf8");
  return JSON.parse(rawConfig);
}

function clearSessionLocks(sessionPath) {
  try {
    const resolved = path.resolve(sessionPath || './session');
    const profileDir = path.join(resolved, 'session');
    const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];

    for (const fileName of lockFiles) {
      const target = path.join(profileDir, fileName);
      if (fs.existsSync(target)) {
        try {
          fs.unlinkSync(target);
          console.log(`[SESSION_LOCK] Removed stale lock: ${target}`);
        } catch (err) {
          console.warn(`[SESSION_LOCK] Could not remove lock ${target}: ${normalizeError(err)}`);
        }
      }
    }
  } catch (err) {
    console.warn(`[SESSION_LOCK] Skip lock cleanup: ${normalizeError(err)}`);
  }
}

function getSenderLabel(message) {
  return message._data?.notifyName || message.author || message.from || "unknown";
}

function getMessageTimestampIso(message) {
  const timestampMs = Number(message.timestamp) * 1000;
  if (Number.isFinite(timestampMs) && timestampMs > 0) {
    return new Date(timestampMs).toISOString();
  }
  return new Date().toISOString();
}

function parseCsvLine(line) {
  const regex = /(?:^|,)(?:"([^"]*)"|([^",]*))/g;
  const cells = [];
  let match;

  while ((match = regex.exec(line))) {
    cells.push((match[1] !== undefined ? match[1] : match[2]) || "");
  }

  return cells;
}

function normalizeGroupName(rawGroupName) {
  const value = (rawGroupName || "").trim();
  // Backward-compat cleanup for legacy CSV rows where checkin value leaked into group name.
  return value.replace(/,\s*[01]\s*$/g, "").trim();
}

function toGroupKey(groupName) {
  return normalizeGroupName(groupName).toLowerCase().replace(/\s+/g, " ").trim();
}

const PROJECTS_CSV_HEADER = 'project_name';
const EMPLOYEE_GROUPS_CSV_HEADER = 'Name,Group Name,Checkins,Type';

function getProjectsPath() {
  return path.resolve(__dirname, 'repo_projects.csv');
}

function readProjectsCatalog() {
  const map = new Map();
  const projectsPath = getProjectsPath();
  if (!fs.existsSync(projectsPath)) return [];
  const lines = fs.readFileSync(projectsPath, 'utf8').split(/\r?\n/).filter(Boolean);
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = (cells[0] || '').trim();
    if (!name) continue;
    const link = (cells[1] || '').trim();
    if (!map.has(name)) map.set(name, []);
    if (link && link.toLowerCase() !== 'no repo') {
      map.get(name).push(link);
    }
  }
  return Array.from(map.entries()).map(([name, repos]) => ({ name, repos }));
}

function writeProjectsCatalog(projectsArray) {
  let out = 'project_name,repo_link\n';
  const sortable = [...projectsArray].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  for (const proj of sortable) {
    const name = String(typeof proj === 'object' ? proj.name : proj).trim();
    if (!name) continue;
    const repos = (typeof proj === 'object' && Array.isArray(proj.repos)) ? proj.repos.map(r => String(r).trim()).filter(Boolean) : [];
    if (repos.length === 0) {
      out += `"${name}",""\n`;
    } else {
      for (const link of repos) {
        if (link) out += `"${name}","${link}"\n`;
      }
    }
  }
  fs.writeFileSync(getProjectsPath(), out, 'utf8');
  return sortable;
}

function getEmployeeGroupsPath() {
  return path.resolve(__dirname, 'employee_groups.csv');
}

function normalizeEmployeeType(rawType) {
  return String(rawType || 'dev').trim().toLowerCase() || 'dev';
}

function readEmployeeGroupsCatalog() {
  const groupsPath = getEmployeeGroupsPath();
  if (!fs.existsSync(groupsPath)) return [];

  const lines = fs.readFileSync(groupsPath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length < 2) continue;

    const name = String(cells[0] || '').trim();
    const group = normalizeGroupName(cells[1]);
    const type = normalizeEmployeeType(cells[3]);
    if (!name || !group) continue;

    rows.push({ name, group, type });
  }

  rows.sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (nameCmp !== 0) return nameCmp;
    return a.group.localeCompare(b.group, undefined, { sensitivity: 'base' });
  });

  return rows;
}

function escapeCsvCell(value) {
  return `"${String(value || '').replace(/"/g, '""')}"`;
}

function writeEmployeeGroupsCatalog(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const cleaned = [];
  const seen = new Set();

  for (const row of list) {
    const name = String(row?.name || '').trim();
    const group = normalizeGroupName(row?.group || '');
    const type = normalizeEmployeeType(row?.type);
    if (!name || !group) continue;

    const key = `${name.toLowerCase()}|${group.toLowerCase()}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);

    cleaned.push({ name, group, type });
  }

  cleaned.sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (nameCmp !== 0) return nameCmp;
    return a.group.localeCompare(b.group, undefined, { sensitivity: 'base' });
  });

  let content = `${EMPLOYEE_GROUPS_CSV_HEADER}\n`;
  for (const row of cleaned) {
    // Per editor requirement, all saved rows reset Checkins to 0.
    content += `${escapeCsvCell(row.name)},${escapeCsvCell(row.group)},0,${row.type}\n`;
  }

  isWritingCsv = true;
  fs.writeFileSync(getEmployeeGroupsPath(), content, 'utf8');
  setTimeout(() => {
    isWritingCsv = false;
  }, 1000);

  loadCsv();
  broadcastEvent('live_update', {});
  return cleaned;
}

function loadCsv() {
  try {
    if (!fs.existsSync("employee_groups.csv")) return;

    const content = fs.readFileSync("employee_groups.csv", "utf8");
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
      const checkins = (checkinsRaw === "1") ? 1 : 0;
      const type = ((cells[3] || "dev").trim() || "dev").toLowerCase();

      csvData.push({ name, group: groupName, checkin: checkins, type });
      newTargetGroupNames.add(groupName);
    }

    const groupsByKey = new Map();
    for (const group of allGroupChats) {
      const key = toGroupKey(group.name);
      if (!groupsByKey.has(key)) groupsByKey.set(key, group);
    }

    const foundGroupNames = new Set();
    for (const row of csvData) {
      const matchedGroup = groupsByKey.get(toGroupKey(row.group));
      if (!matchedGroup) continue;

      row.groupId = matchedGroup.id._serialized;
      targetGroupIds.add(matchedGroup.id._serialized);
      groupNameById.set(matchedGroup.id._serialized, matchedGroup.name);
      foundGroupNames.add(row.group);
    }

    // Check if any mapped groups from the CSV were NOT found in WhatsApp
    if (allGroupChats.length > 0) {
      for (const targetName of newTargetGroupNames) {
        if (!foundGroupNames.has(targetName)) {
          console.warn(`[WARN] Target group '${targetName}' from CSV was NOT found in WhatsApp chats! Check exact spelling/casing.`);
        }
      }
    }
  } catch (err) {
    console.error("[CSV_ERROR] Failed to read employee_groups.csv:", err.message);
  }
}

function saveCsv() {
  isWritingCsv = true;
  let csvContent = "Name,Group Name,Checkins,Type\n";
  for (const row of csvData) {
    const safeType = (row.type || "dev").toString().trim().toLowerCase() || "dev";
    csvContent += `${row.name},"${row.group}",${row.checkin},${safeType}\n`;
  }
  fs.writeFileSync("employee_groups.csv", csvContent, "utf8");

  // Debounce to prevent the watcher from immediately triggering a reload when we save
  setTimeout(() => {
    isWritingCsv = false;
  }, 1000);
}

try {
  fs.watch("employee_groups.csv", (eventType) => {
    if (!isWritingCsv && eventType === "change") {
      console.log("[CSV_SYNC] External change detected in employee_groups.csv. Reloading targets...");
      loadCsv();
      console.log(`[CSV_SYNC] Now monitoring ${targetGroupIds.size} group(s).`);
      broadcastEvent('live_update', {});
    }
  });
} catch (err) {
  console.warn("[WARN] Could not setup file watcher on employee_groups.csv. Ensure it exists.");
}

// API Routes
app.get('/api/data', (req, res) => res.json(csvData));

app.get('/api/groups', (req, res) => {
  try {
    const rows = readEmployeeGroupsCatalog();
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: normalizeError(err) });
  }
});

app.post('/api/groups/save', (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) {
      return res.status(400).json({ ok: false, error: 'rows must be an array.' });
    }

    const savedRows = writeEmployeeGroupsCatalog(rows);
    res.json({ ok: true, rows: savedRows });
  } catch (err) {
    res.status(500).json({ ok: false, error: normalizeError(err) });
  }
});

app.get('/api/projects', (req, res) => {
  try {
    const projects = readProjectsCatalog();
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: normalizeError(err) });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Project name is required.' });

    const existing = readProjectsCatalog();
    const exists = existing.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (exists) return res.status(409).json({ ok: false, error: 'Project already exists.' });

    const repos = Array.isArray(req.body?.repos) ? req.body.repos : [];
    const projects = writeProjectsCatalog([...existing, { name, repos }]);
    res.json({ ok: true, projects });
  } catch (err) {
    res.status(500).json({ ok: false, error: normalizeError(err) });
  }
});

app.patch('/api/projects', (req, res) => {
  try {
    const oldName = String(req.body?.oldName || '').trim();
    const newName = String(req.body?.newName || '').trim();

    if (!oldName || !newName) {
      return res.status(400).json({ ok: false, error: 'Both oldName and newName are required.' });
    }

    const projects = readProjectsCatalog();
    const targetIndex = projects.findIndex((p) => p.name.toLowerCase() === oldName.toLowerCase());
    if (targetIndex < 0) {
      return res.status(404).json({ ok: false, error: 'Project to update was not found.' });
    }

    const duplicate = projects.some((p, idx) => idx !== targetIndex && p.name.toLowerCase() === newName.toLowerCase());
    if (duplicate) {
      return res.status(409).json({ ok: false, error: 'A project with that name already exists.' });
    }

    projects[targetIndex].name = newName;
    if (req.body.repos !== undefined) {
      projects[targetIndex].repos = Array.isArray(req.body.repos) ? req.body.repos : [];
    }

    const updated = writeProjectsCatalog(projects);
    res.json({ ok: true, projects: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: normalizeError(err) });
  }
});

app.delete('/api/projects', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Project name is required.' });

    const projects = readProjectsCatalog();
    const next = projects.filter((p) => p.name.toLowerCase() !== name.toLowerCase());

    if (next.length === projects.length) {
      return res.status(404).json({ ok: false, error: 'Project not found.' });
    }

    const updated = writeProjectsCatalog(next);
    res.json({ ok: true, projects: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: normalizeError(err) });
  }
});

// Compatibility aliases for environments that proxy/block PATCH/DELETE.
app.post('/api/projects/rename', (req, res) => {
  try {
    const oldName = String(req.body?.oldName || '').trim();
    const newName = String(req.body?.newName || '').trim();

    if (!oldName || !newName) {
      return res.status(400).json({ ok: false, error: 'Both oldName and newName are required.' });
    }

    const projects = readProjectsCatalog();
    const targetIndex = projects.findIndex((p) => p.name.toLowerCase() === oldName.toLowerCase());
    if (targetIndex < 0) {
      return res.status(404).json({ ok: false, error: 'Project to rename was not found.' });
    }

    const duplicate = projects.some((p, idx) => idx !== targetIndex && p.name.toLowerCase() === newName.toLowerCase());
    if (duplicate) {
      return res.status(409).json({ ok: false, error: 'A project with that name already exists.' });
    }

    projects[targetIndex].name = newName;
    if (req.body.repos !== undefined) {
      projects[targetIndex].repos = Array.isArray(req.body.repos) ? req.body.repos : [];
    }
    const updated = writeProjectsCatalog(projects);
    res.json({ ok: true, projects: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: normalizeError(err) });
  }
});

app.post('/api/projects/delete', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Project name is required.' });

    const projects = readProjectsCatalog();
    const next = projects.filter((p) => p.name.toLowerCase() !== name.toLowerCase());

    if (next.length === projects.length) {
      return res.status(404).json({ ok: false, error: 'Project not found.' });
    }

    const updated = writeProjectsCatalog(next);
    res.json({ ok: true, projects: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: normalizeError(err) });
  }
});

app.get('/api/ai-key-status', (req, res) => {
  try {
    const modelId = String(req.query.aiModel || 'groq:llama-3.3-70b-versatile').trim();
    const modelIdLower = modelId.toLowerCase();
    let provider = 'unknown', envVar = '';
    if (modelIdLower === 'gemini-2.5-flash') { provider = 'gemini'; envVar = 'GEMINI_API_KEY'; }
    else if (modelIdLower.startsWith('groq:')) { provider = 'groq'; envVar = 'GROQ_API_KEY'; }
    else if (modelIdLower.startsWith('cerebras:')) { provider = 'cerebras'; envVar = 'CEREBRAS_API_KEY'; }
    if (!envVar) return res.status(400).json({ ok: false, error: 'Unsupported model: ' + modelId });
    const value = process.env[envVar];
    const hasKey = typeof value === 'string' && value.trim().length > 0;
    res.json({ ok: hasKey, provider, envVar, hasKey });
  } catch (err) { res.status(500).json({ ok: false, error: normalizeError(err) }); }
});

app.get('/api/ai-key-overview', (req, res) => {
  try {
    const has = (k) => typeof process.env[k] === 'string' && process.env[k].trim().length > 0;
    res.json({ ok: true, providers: { gemini: has('GEMINI_API_KEY'), groq: has('GROQ_API_KEY'), cerebras: has('CEREBRAS_API_KEY') } });
  } catch (err) { res.status(500).json({ ok: false, error: normalizeError(err) }); }
});

app.post('/api/update', (req, res) => {
  const { name, group, checkin } = req.body;
  let updated = false;
  for (const row of csvData) {
    if (row.name === name && row.group === group) {
      row.checkin = checkin;
      updated = true;
    }
  }
  if (updated) {
    saveCsv();
    broadcastEvent('live_update', {});
  }
  res.json({ success: updated });
});

app.post('/api/start-scan', (req, res) => {
  try {
    const hours = req.body.hours || 24;
    const hardRescan = Boolean(req.body.hardRescan);

    if (hardRescan) clearMatchCache();

    if (_triggerPerformReadySync) {
      _triggerPerformReadySync(hours, hardRescan);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: normalizeError(err) });
  }
});

app.post('/api/reset', (req, res) => {
  if (readySyncInProgress) return res.json({ ok: false });
  startupScanCompleted = false;
  updateState('ready', 'Monitoring Suspended. Configure New Scan.');
  res.json({ ok: true });
});

app.post('/api/process-checkouts', async (req, res) => {
  try {
    const lookbackHours = req.body.hours || 24;
    const hardRescan = Boolean(req.body.hardRescan);
    const runtimeApiKey = typeof req.body.runtimeApiKey === 'string' ? req.body.runtimeApiKey.trim() : '';
    const scanThresholdMs = Date.now() - lookbackHours * 60 * 60 * 1000;

    const validProjectsRaw = readProjectsCatalog();
    if (!validProjectsRaw || validProjectsRaw.length === 0) return res.status(400).json({ error: 'repo_projects.csv missing or empty' });
    const validProjects = validProjectsRaw.map(p => p.name);

    let inMemoryMatches = [];
    if (hardRescan) {
      clearMatchCache();
    }
    if (typeof _triggerPerformReadySync === 'function') {
      try {
        console.log(`[AI ENGINE] Syncing live WhatsApp history for the last ${lookbackHours} hours...`);
        inMemoryMatches = await _triggerPerformReadySync(lookbackHours, true) || [];
      } catch (err) {
        console.warn(`[WARN] WhatsApp live sync failed: ${err.message}`);
      }
    }

    if (!inMemoryMatches || inMemoryMatches.length === 0) return res.json({ results: [] });
    
    const checkoutRegex = /(?:check(?:ed|ing|s)?[\\s-]?out|work[\\s-]*summary|repo[\\s-]*update[\\s-]*status|video[\\s-]*summary)/i;

    // Atomic Dev Mapping to bypass Whatsapp Boot delays and map Type accurately
    const employeeGroupsPath = path.resolve(__dirname, 'employee_groups.csv');
    let localCsvData = [];
    if (fs.existsSync(employeeGroupsPath)) {
      const gLines = fs.readFileSync(employeeGroupsPath, "utf8").split(/\r?\n/).filter(Boolean).slice(1);
      gLines.forEach(l => {
        const regex = /(?:^|,)(?:"([^"]*)"|([^",]*))/g;
        let cells = [];
        let match;
        while (match = regex.exec(l)) {
            cells.push((match[1] !== undefined ? match[1] : match[2]) || '');
        }
        if (cells.length >= 4) {
          localCsvData.push({
            name: cells[0].trim(),
            group: normalizeGroupName(cells[1]),
            type: cells[3].trim().toLowerCase()
          });
        } else if (cells.length >= 2) {
          localCsvData.push({ name: cells[0].trim(), group: normalizeGroupName(cells[1]), type: 'dev' });
        }
      });
    }
    
    // Aggregation and QA / VA filtering
    const devMap = new Map();
    inMemoryMatches.forEach(m => {
      try {
        const logTimeMs = m.timestamp ? new Date(m.timestamp).getTime() : 0;
        if (logTimeMs > 0 && logTimeMs < scanThresholdMs) return; // Ignore old records outside the lookback window

        const gn = typeof m.groupName === 'string' ? m.groupName.trim() : '';
        const empLookup = localCsvData.find(e => e.group.toLowerCase() === gn.toLowerCase());
        const eType = empLookup ? empLookup.type : 'unknown';
        
        if (eType !== 'dev') return; // Strict Type Filter: skip QA, VA, Tester, Trainee

        const isTagged = Array.isArray(m.matchedRules) && m.matchedRules.includes('checkout_detection');
        const matchesRegex = typeof m.messageBody === 'string' && checkoutRegex.test(m.messageBody);
        
        if (isTagged || matchesRegex) {
          const devId = m.sender;
          if (!devMap.has(devId)) {
            devMap.set(devId, {
              sender: m.sender,
              groupName: m.groupName,
              messages: [m.messageBody.trim()]
            });
          } else {
            const existing = devMap.get(devId);
            if (!existing.messages.includes(m.messageBody.trim())) {
              existing.messages.push(m.messageBody.trim());
            }
          }
        }
      } catch(err) {
        console.warn(`[WARN] Skipped malformed log entry.`);
      }
    });

    const checkoutMessages = Array.from(devMap.values()).map(d => ({
      sender: d.sender,
      groupName: d.groupName,
      messageBody: d.messages.join('\n\n--- ADDITIONAL CHECKOUT ---\n\n')
    }));

    // Keep all devs visible in output even when they have no checkout summary.
    const devRoster = localCsvData.filter(r => (r.type || '').toLowerCase() === 'dev');

    // Deduplicate by group/developer or just process all (we process recent ones, or all inside the active log)
    // To prevent token limits, we'll slice the array if it's too huge, but usually it's fine.
    
    // Batch processing prompt
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
        const gModelRaw = modelId.replace(/^groq:/i, '').trim();
        const groqModelAliases = {
          'llama-4-scout-17b': 'meta-llama/llama-4-scout-17b-16e-instruct',
          'kimi-k2-instruct': 'llama-3.3-70b-versatile'
        };
        const gModel = groqModelAliases[gModelRaw] || gModelRaw;
        const gPayload = { model: gModel, messages: [{ role: "user", content: prompt }] };
        const gRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${groqKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(gPayload)
        });
        if (!gRes.ok) throw new Error("Groq API error: " + await gRes.text());
        const gData = await gRes.json();
        textBlob = gData.choices[0].message.content;
      } else if (modelIdLower.startsWith("cerebras:")) {
        const cerebrasKey = runtimeApiKey || apiKeys.cerebras || process.env.CEREBRAS_API_KEY;
        if (!cerebrasKey) throw new Error("Missing Cerebras API Key. Please add it in ⚙ Settings.");
        const groqKey = apiKeys.groq || process.env.GROQ_API_KEY;
        const geminiKey = apiKeys.gemini || process.env.GEMINI_API_KEY;

        const cModel = modelId.replace(/^cerebras:/i, '');
        const cPayload = { model: cModel, messages: [{ role: "user", content: prompt }] };
        let useGroqFallback = false;
        let cerebrasDetails = '';

        try {
          const cRes = await fetch("https://api.cerebras.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${cerebrasKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(cPayload)
          });

          if (!cRes.ok) {
            cerebrasDetails = await cRes.text();
            useGroqFallback = true;
          } else {
            const cData = await cRes.json();
            const maybeContent = cData?.choices?.[0]?.message?.content;
            if (typeof maybeContent === 'string' && maybeContent.trim()) {
              textBlob = maybeContent;
            } else {
              cerebrasDetails = JSON.stringify(cData).slice(0, 800);
              useGroqFallback = true;
            }
          }
        } catch (err) {
          cerebrasDetails = normalizeError(err);
          useGroqFallback = true;
        }

        if (useGroqFallback) {
          if (groqKey && groqKey.trim()) {
            console.warn(`[AI_FALLBACK] Cerebras failed or returned invalid format. Falling back to Groq llama-3.3-70b-versatile. Details: ${cerebrasDetails}`);
            const fallbackPayload = {
              model: 'llama-3.3-70b-versatile',
              messages: [{ role: 'user', content: prompt }]
            };
            const fallbackRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${groqKey}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(fallbackPayload)
            });

            if (!fallbackRes.ok) {
              throw new Error('Cerebras failed and Groq fallback failed: ' + await fallbackRes.text());
            }

            const fallbackData = await fallbackRes.json();
            textBlob = fallbackData.choices[0].message.content;
          } else if (geminiKey && geminiKey.trim()) {
            console.warn(`[AI_FALLBACK] Cerebras failed or returned invalid format. Falling back to Gemini 2.5 Flash. Details: ${cerebrasDetails}`);
            const { GoogleGenerativeAI } = require('@google/generative-ai');
            const genAI = new GoogleGenerativeAI(geminiKey);
            const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
            const aiResp = await model.generateContent(prompt);
            textBlob = aiResp.response.text();
          } else {
            throw new Error(`Cerebras failed and no fallback provider key is available. Details: ${cerebrasDetails}`);
          }
        }
      } else {
        throw new Error(`Unsupported AI model: ${modelId}. Supported providers are Gemini, Groq, and Cerebras.`);
      }

      textBlob = textBlob.replace(/```json/gi, '').replace(/```/g, '').trim();
      // Sometimes LLMs wrap json arrays loosely, extract exact bracket block dynamically safely
      const jsonMatch = textBlob.match(/\{[\s\S]*\}$/m);
      if (jsonMatch) textBlob = jsonMatch[0];
      
      mappedDict = JSON.parse(textBlob);
    }

    const results = [];
    let compiledCsv = 'Developer,Group Name,Projects\n';



    const parsedByGroup = new Map();
    checkoutMessages.forEach((msg, i) => {
      const extractedProjects = mappedDict[i] || [];
      const lookupGroup = (msg.groupName || '').toLowerCase().trim();
      const matchedDev = localCsvData.find(r => (r.group || '').toLowerCase().trim() === lookupGroup);
      const properDevName = matchedDev ? matchedDev.name : msg.sender;

      const parsedRow = {
        developer: properDevName,
        groupName: msg.groupName,
        projects: extractedProjects,
        originalText: msg.messageBody
      };

      results.push(parsedRow);
      parsedByGroup.set(toGroupKey(msg.groupName), parsedRow);
    });

    // Ensure every dev appears even when they did not post any checkout summary.
    devRoster.forEach((dev) => {
      const key = toGroupKey(dev.group);
      if (parsedByGroup.has(key)) return;

      const emptyRow = {
        developer: dev.name,
        groupName: dev.group,
        projects: [],
        originalText: ''
      };
      results.push(emptyRow);
    });

    results.forEach((row) => {
      const pString = Array.isArray(row.projects) 
        ? row.projects.map(p => typeof p === 'object' ? `${p.name}::${p.status}` : p).join(', ') 
        : (row.projects || '');
      const safeProjects = `"${pString.replace(/"/g, '""')}"`;
      compiledCsv += `${row.developer},"${row.groupName}",${safeProjects}\n`;
    });

    fs.writeFileSync(path.resolve(__dirname, 'checkout_projects.csv'), compiledCsv, 'utf8');

    res.json({ results });
  } catch (err) {
    console.error("AI parse error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/save-checkouts', (req, res) => {
  try {
    const list = req.body.results || [];
    let compiledCsv = 'Developer,Group Name,Projects\n';
    
    for (const item of list) {
       let pString = "";
       if (typeof item.projects === 'string') {
         pString = item.projects;
       } else if (Array.isArray(item.projects)) {
         pString = item.projects.map(p => typeof p === 'object' && p !== null ? `${p.name}::${p.status}` : p).join(', ');
       }
       const safeProjects = `"${pString.replace(/"/g, '""')}"`;
       compiledCsv += `${item.developer},"${item.groupName}",${safeProjects}\n`;
    }
    
    fs.writeFileSync(path.resolve(__dirname, 'checkout_projects.csv'), compiledCsv, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    console.error("Save error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Gitea Repo Update Checking (ported from repoupdate rust) ──────────

const GITEA_BASE = 'https://gitea.personalsoftware.space';

function parseRepoLink(link) {
  const clean = link.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const isGitea = clean.includes('personalsoftware.space');
  try {
    const u = new URL(clean);
    const parts = u.pathname.replace(/^\/+/, '').split('/');
    return { link, owner: parts[0] || '', repo: parts[1] || '', isGitea };
  } catch {
    return { link, owner: '', repo: '', isGitea };
  }
}

function readRepoProjectsCsv() {
  const csvPath = path.resolve(__dirname, 'repo_projects.csv');
  if (!fs.existsSync(csvPath)) return new Map();

  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const map = new Map(); // project_name -> [RepoInfo]

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = (cells[0] || '').trim();
    const link = (cells[1] || '').trim();
    if (!name) continue;

    if (!map.has(name)) map.set(name, []);
    if (link && link.toLowerCase() !== 'no repo') {
      map.get(name).push(parseRepoLink(link));
    }
  }
  return map;
}

function readTeamCsv() {
  const csvPath = path.resolve(__dirname, 'repo_team.csv');
  if (!fs.existsSync(csvPath)) return [];
  const lines = fs.readFileSync(csvPath, 'utf8').split(/\r?\n/).filter(Boolean);
  const devs = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = (cells[0] || '').trim();
    if (!name) continue;
    const aliasesRaw = (cells[1] || '').split(';').map(a => a.trim().toLowerCase()).filter(Boolean);
    const aliases = [...new Set([name.toLowerCase(), ...aliasesRaw])];
    devs.push({ name, aliases });
  }
  return devs;
}

async function giteaApiFetch(endpoint, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `token ${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${GITEA_BASE}${endpoint}`, {
      headers,
      signal: controller.signal
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGiteaBranches(owner, repo, apiKey) {
  const data = await giteaApiFetch(`/api/v1/repos/${owner}/${repo}/branches?limit=100`, apiKey);
  return Array.isArray(data) ? data : [];
}

async function fetchGiteaCommits(owner, repo, since, branch, apiKey) {
  let endpoint = `/api/v1/repos/${owner}/${repo}/commits?limit=100&since=${encodeURIComponent(since)}`;
  if (branch) endpoint += `&sha=${encodeURIComponent(branch)}`;
  const data = await giteaApiFetch(endpoint, apiKey);
  return Array.isArray(data) ? data : [];
}

async function fetchAllBranchCommits(owner, repo, since, apiKey) {
  const branches = await fetchGiteaBranches(owner, repo, apiKey);
  const allCommits = [];
  const seen = new Set();

  for (const br of branches) {
    const branchName = br.name;
    if (!branchName) continue;
    const commits = await fetchGiteaCommits(owner, repo, since, branchName, apiKey);
    for (const c of commits) {
      const sha = c.sha || '';
      if (sha && seen.has(sha)) continue;
      if (sha) seen.add(sha);
      allCommits.push(c);
    }
  }
  return allCommits;
}

function extractCommitPerson(c) {
  return c?.author?.login
    || c?.committer?.login
    || c?.commit?.author?.name
    || 'unknown';
}

function extractCommitDate(c) {
  return c?.commit?.author?.date
    || c?.commit?.committer?.date
    || '';
}

function formatAgo(isoStr) {
  try {
    const dt = new Date(isoStr);
    if (isNaN(dt.getTime())) return isoStr;
    const secs = Math.max(0, (Date.now() - dt.getTime()) / 1000);
    const hours = secs / 3600;
    if (hours < 1) return `${Math.floor(secs / 60)} min ago`;
    if (hours < 48) return `${Math.floor(hours)} hours ago`;
    return `${Math.floor(hours / 24)} days ago`;
  } catch {
    return isoStr;
  }
}

async function fetchLatestAnyBranch(owner, repo, apiKey) {
  const branches = await fetchGiteaBranches(owner, repo, apiKey);
  let best = null;

  for (const br of branches) {
    const commit = br.commit;
    if (!commit) continue;
    const date = commit.author?.date || commit.committer?.date || commit.timestamp || '';
    if (!date) continue;

    if (!best || date > best.date) {
      best = {
        date,
        committer: commit.author?.name || commit.committer?.name || '',
        message: (commit.message || '').split('\n')[0].trim()
      };
    }
  }
  return best;
}

app.get('/api/repo-projects', (req, res) => {
  try {
    const map = readRepoProjectsCsv();
    const projects = {};
    for (const [name, repos] of map) {
      projects[name] = repos.map(r => ({ link: r.link, isGitea: r.isGitea }));
    }
    res.json({ ok: true, projects });
  } catch (err) {
    res.status(500).json({ ok: false, error: normalizeError(err) });
  }
});

app.post('/api/check-repo-updates', async (req, res) => {
  try {
    const lookbackHours = req.body.hours || 48;
    const devsInput = req.body.devs || [];

    if (!Array.isArray(devsInput) || devsInput.length === 0) {
      return res.status(400).json({ ok: false, error: 'No developers provided.' });
    }

    const repoMap = readRepoProjectsCsv();
    const teamDb = readTeamCsv();
    const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const since = cutoff.toISOString();

    const apiKey = typeof req.body.giteaKey === 'string' ? req.body.giteaKey.trim() : '';

    const allProjectNames = new Set();
    for (const d of devsInput) {
      for (const p of d.projects || []) {
        if (p) allProjectNames.add(p.trim());
      }
    }
    const uniqueProjects = [...allProjectNames];
    const repoMapKeys = [...repoMap.keys()];

    // Map each project to its raw repo rows
    const projectRepoResults = new Map();

    for (const projectName of uniqueProjects) {
      let matchedKey = repoMapKeys.find(k => k.toLowerCase() === projectName.toLowerCase());
      if (!matchedKey) {
        const stripped = projectName.replace(/\(.*?\)/g, '').trim().toLowerCase();
        matchedKey = repoMapKeys.find(k => k.toLowerCase().includes(stripped) || stripped.includes(k.toLowerCase()));
      }

      const repos = matchedKey ? repoMap.get(matchedKey) : [];
      const repoResults = [];

      if (!repos || repos.length === 0) {
        repoResults.push({ skippedReason: 'no_link' });
      } else {
        for (const ri of repos) {
          if (!ri.isGitea) {
            repoResults.push({ skippedReason: 'not_gitea', repoLink: ri.link });
            continue;
          }
          if (!ri.owner || !ri.repo) {
            repoResults.push({ skippedReason: 'bad_url', repoLink: ri.link });
            continue;
          }
          console.log(`[REPO_CHECK] Checking ${ri.owner}/${ri.repo}...`);
          const commits = await fetchAllBranchCommits(ri.owner, ri.repo, since, apiKey);
          if (commits.length === 0) {
            const latest = await fetchLatestAnyBranch(ri.owner, ri.repo, apiKey);
            repoResults.push({
              skippedReason: '',
              committer: latest ? latest.committer : '',
              lastUpdateRaw: latest ? latest.date : '',
            });
          } else {
            for (const c of commits) {
               repoResults.push({
                 skippedReason: '',
                 committer: extractCommitPerson(c),
                 lastUpdateRaw: extractCommitDate(c),
               });
            }
          }
        }
      }
      projectRepoResults.set(projectName, repoResults);
    }

    // Now match devs using aliases
    const devStatuses = [];
    const textSummaryLines = [];

    for (const dInput of devsInput) {
      const devName = dInput.name;
      const projectNames = dInput.projects || [];
      const teamDev = teamDb.find(t => t.name.toLowerCase() === devName.toLowerCase());
      const aliases = teamDev ? teamDev.aliases : [devName.toLowerCase()];

      let hasAny48h = false;
      const projectStatuses = [];
      const devSummaryParts = []; // For text summary (only staleproj)

      for (const pn of projectNames) {
        const pRows = projectRepoResults.get(pn) || [];
        
        // Find matching rows by alias
        const matchingRows = pRows.filter(r => !r.skippedReason && r.committer && aliases.includes(r.committer.toLowerCase()));

        if (matchingRows.length === 0) {
          // No commit from this dev on this project
          const githubSkippedRows = pRows.filter(r => r.skippedReason === 'not_gitea');
          const isGh = githubSkippedRows.length > 0;

          let githubLinks = [];
          if (isGh) {
            githubLinks = [...new Set(githubSkippedRows.map(r => r.repoLink).filter(Boolean))];
          }
          
          const label = isGh ? "GITHUB SKIPPED" : "NO";
          const dispLabel = isGh ? "GITHUB SKIPPED" : "no commit found";
          
          projectStatuses.push({
            project: pn,
            updateTime: dispLabel,
            updated48h: false,
            isGithubSkipped: isGh,
            githubLinks
          });
          devSummaryParts.push(`${pn} (${label})`);
        } else {
          // Dev has commit
          const bestRaw = matchingRows.map(r => r.lastUpdateRaw).filter(Boolean).sort().pop();
          const bestTime = bestRaw ? formatAgo(bestRaw) : 'no commit found';
          const isMatchedTime = bestRaw && bestRaw >= since;
          
          if (isMatchedTime) {
            hasAny48h = true;
          }
          
          projectStatuses.push({
            project: pn,
            updateTime: bestTime,
            updated48h: isMatchedTime,
            isGithubSkipped: false,
            githubLinks: []
          });
          
          if (!isMatchedTime) {
            const timeLabel = bestTime === 'no commit found' ? 'NO' : bestTime;
            devSummaryParts.push(`${pn} (${timeLabel})`);
          }
        }
      }

      devStatuses.push({
        name: devName,
        hasUpdated: hasAny48h,
        projectStatuses
      });
      
      if (devSummaryParts.length > 0) {
        textSummaryLines.push(`${devName} -> ${devSummaryParts.join(', ')}`);
      }
    }

    res.json({ 
      ok: true, 
      devStatuses, 
      textSummary: textSummaryLines.join('\n') 
    });
  } catch (err) {
    console.error('[REPO_CHECK_ERROR]', err);
    res.status(500).json({ ok: false, error: normalizeError(err) });
  }
});


async function run() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (Number.isFinite(nodeMajor) && nodeMajor >= 22) {
    console.warn("[WARN] Detected Node.js 22+. whatsapp-web.js is generally more stable on Node.js 20 LTS.");
  }

  const config = loadConfig();
  clearSessionLocks(config.sessionPath);

  // Start Express UI Server
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[UI] Launching the interactive Web Dashboard!`);
    console.log(`[UI] => Please open http://localhost:${PORT} in your browser.`);
  });

  const chromePaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/opt/google/chrome/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium'
  ];
  let resolvedChromePath = chromePaths.find(p => p && fs.existsSync(p));
  if (!resolvedChromePath && process.platform !== 'win32') {
    console.warn("[WARN] Could not find Chrome/Chromium installation. whatsapp-web.js may fail to start!");
  }

  const client = new Client({
    authStrategy: new NoAuth(),
    puppeteer: {
      headless: true,
      executablePath: resolvedChromePath || undefined,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
      ],
    },
  });

  _triggerPerformReadySync = async (lookbackHours, force = false) => {
    if (!readyAnnounced || readySyncInProgress || (!force && startupScanCompleted)) return [];
    readySyncInProgress = true;
    const collectedMatches = [];

    try {
      updateState('scanning', 'Scanning past history...');
      const scanThresholdMs = Date.now() - lookbackHours * 60 * 60 * 1000;

      const chats = await client.getChats();
      allGroupChats = chats.filter((chat) => chat.isGroup);

      loadCsv();
      for (const row of csvData) {
        row.checkin = 0;
      }

      let i = 0;
      let totalToScan = targetGroupIds.size || 1;
      
      for (const chat of allGroupChats) {
        if (!targetGroupIds.has(chat.id._serialized)) continue;

        i++;
        const percentage = Math.round((i / totalToScan) * 100);
        broadcastEvent('progress', { percentage, groupName: chat.name });

        try {
          const messages = await chat.fetchMessages({ limit: HISTORY_FETCH_LIMIT });
          for (const msg of messages) {
            const msgTimestampMs = Number(msg.timestamp) * 1000;
            if (!Number.isFinite(msgTimestampMs) || msgTimestampMs < scanThresholdMs) continue;

            const messageBody = typeof msg.body === "string" ? msg.body : "";
            const matchedRules = matchRules(messageBody, config.rules);

            if (matchedRules.length === 0) continue;

            for (const row of csvData) {
              if (row.groupId === chat.id._serialized) {
                row.checkin = 1;
              }
            }

            const messageId = msg.id?._serialized;
            if (messageId && loggedMessageIds.has(messageId)) continue;

            const matchPayload = {
              timestamp: new Date(msgTimestampMs).toISOString(),
              groupName: chat.name,
              sender: getSenderLabel(msg),
              messageBody,
              matchedRules,
            };

            collectedMatches.push(matchPayload);
            if (messageId) loggedMessageIds.add(messageId);
          }
        } catch (error) {
          const details = normalizeError(error);
          if (isTransientExecutionContextError(error)) {
            console.warn(`[STARTUP_SCAN_RETRYABLE] Group '${chat.name}': ${details}`);
          } else {
            console.error(`[STARTUP_SCAN_ERROR] Group '${chat.name}': ${details}`);
          }
        }
      }

      saveCsv();
      startupScanCompleted = true;
      updateState('monitoring', 'Live monitoring is active.');
      console.log("[STARTUP] Historical scan complete. Fetched " + collectedMatches.length + " matches.");
      
      return collectedMatches;
    } catch (error) {
      console.error(`[READY_ERROR] ${normalizeError(error)}`);
      return collectedMatches;
    } finally {
      readySyncInProgress = false;
    }
  };

  client.on("qr", (qr) => {
    console.log("Scan this QR code with WhatsApp (also available on Web UI):");
    qrcode.generate(qr, { small: true });
    updateState('qr', 'Authentication Required. Please scan QR.');
    qrString = qr;
    broadcastEvent('qr', qr);
  });

  client.on("ready", () => {
    if (!readyAnnounced) {
      console.log("Client is ready");
      readyAnnounced = true;
      updateState('ready', 'Whatsapp is connected.');
    }
  });

  client.on("message", async (message) => {
    // Live file logging removed for stateless execution!
  });

  client.on("auth_failure", (message) => console.error(`[AUTH_FAILURE] ${message}`));

  client.on("disconnected", (reason) => {
    console.error(`[DISCONNECTED] ${reason}`);
    readyAnnounced = false;
    startupScanCompleted = false;
    updateState('init', 'Bot Disconnected. Waiting...');
  });

  client.on("change_state", (state) => {
    console.log(`[STATE] ${state}`);
  });

  process.on("unhandledRejection", (reason) => {
    if (isTransientExecutionContextError(reason)) return;
    console.error(`[UNHANDLED_REJECTION] ${normalizeError(reason)}`);
  });

  process.on("uncaughtException", (error) => {
    if (isTransientExecutionContextError(error)) return;
    console.error(`[UNCAUGHT_EXCEPTION] ${normalizeError(error)}`);
  });

  const maxInitAttempts = 5;
  for (let attempt = 1; attempt <= maxInitAttempts; attempt += 1) {
    try {
      await client.initialize();
      return;
    } catch (error) {
      const details = normalizeError(error);
      if (!isTransientExecutionContextError(error)) throw error;
      if (attempt === maxInitAttempts) throw new Error(`Init failed.`);
      await delay(2000 * attempt);
    }
  }
}

run().catch((error) => {
  console.error(`[FATAL_STARTUP] ${normalizeError(error)}`);
  process.exit(1);
});