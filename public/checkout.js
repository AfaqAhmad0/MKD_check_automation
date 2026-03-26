const progressUI = {
  wrap: document.getElementById('checkout-progress-wrap'),
  phase: document.getElementById('checkout-phase'),
  percent: document.getElementById('checkout-percent'),
  fill: document.getElementById('checkout-progress-fill'),
  sub: document.getElementById('checkout-progress-sub')
};

const checkoutBotUI = {
  badge: document.getElementById('checkout-bot-status-badge'),
  text: document.getElementById('checkout-bot-status-text'),
  loadingWrap: document.getElementById('checkout-wa-loading'),
  loadingText: document.getElementById('checkout-wa-loading-text'),
  openMainLink: document.getElementById('checkout-open-main-link'),
  runBtn: document.getElementById('run-ai-btn'),
  authModal: document.getElementById('wa-auth-modal'),
  authSubtext: document.getElementById('wa-auth-subtext'),
  authQrCanvas: document.getElementById('wa-auth-qr-canvas')
};

let checkoutRunInFlight = false;
let checkoutProgressValue = 0;
let checkoutPhase = 'idle';
let lastScanEventAt = 0;
let aiTickTimer = null;
let currentCheckoutData = [];
let availableProjects = [];
let checkoutBotState = 'init';
let latestQrValue = '';

function normalizeQrPayload(payload) {
  if (typeof payload !== 'string') return '';
  const raw = payload.trim();
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
  } catch (_) {
    // Not JSON; treat as plain QR text.
  }

  return raw;
}

function renderQrToCanvas(canvas, qrValue) {
  if (!canvas || typeof QRCode === 'undefined') return;
  if (!qrValue) return;

  QRCode.toCanvas(canvas, qrValue, {
    width: 250,
    margin: 1,
    color: { dark: '#0f172a', light: '#ffffff' }
  }, (err) => {
    if (err) {
      console.error('Failed to render QR canvas:', err);
    }
  });
}

function setAuthModalVisibility(shouldShow) {
  if (!checkoutBotUI.authModal) return;
  checkoutBotUI.authModal.classList.toggle('hidden', !shouldShow);
  document.body.classList.toggle('modal-locked', shouldShow);
}

async function fetchAndRenderLatestQr() {
  try {
    const res = await fetch('/api/qr');
    if (!res.ok) return;
    const data = await res.json();
    const nextQr = normalizeQrPayload(data?.qr || '');
    if (!nextQr) return;
    latestQrValue = nextQr;
    renderQrToCanvas(checkoutBotUI.authQrCanvas, latestQrValue);
  } catch (_) {
    // Ignore QR fetch errors and wait for SSE event.
  }
}

function canRunCheckoutForState(state) {
  return state === 'ready' || state === 'monitoring';
}

function updateCheckoutBotStatus(state, text) {
  checkoutBotState = state;
  const shouldShowAuthModal = state === 'qr';

  setAuthModalVisibility(shouldShowAuthModal);
  if (checkoutBotUI.authSubtext && shouldShowAuthModal) {
    checkoutBotUI.authSubtext.textContent = 'Scan this QR code with your WhatsApp app to continue.';
  }
  if (shouldShowAuthModal && !latestQrValue) {
    fetchAndRenderLatestQr();
  }

  if (checkoutBotUI.text) {
    checkoutBotUI.text.textContent = text || 'Connecting to WhatsApp...';
  }

  const pulseDot = checkoutBotUI.badge?.querySelector('.pulse-dot');
  if (pulseDot) {
    if (state === 'ready' || state === 'monitoring') {
      pulseDot.classList.add('active');
    } else {
      pulseDot.classList.remove('active');
    }
  }

  const isReady = canRunCheckoutForState(state);
  if (checkoutBotUI.runBtn) {
    checkoutBotUI.runBtn.disabled = !isReady || checkoutRunInFlight;
  }

  if (checkoutBotUI.loadingWrap) {
    checkoutBotUI.loadingWrap.classList.toggle('hidden', isReady);
  }

  if (checkoutBotUI.openMainLink) {
    checkoutBotUI.openMainLink.classList.toggle('hidden', state !== 'qr');
  }

  if (checkoutBotUI.loadingText && !isReady) {
    if (state === 'qr') {
      checkoutBotUI.loadingText.textContent = 'WhatsApp authentication required. Scan QR on the main dashboard, then return here.';
    } else if (state === 'scanning') {
      checkoutBotUI.loadingText.textContent = 'WhatsApp is currently scanning history. Compile action unlocks after scan completes.';
    } else {
      checkoutBotUI.loadingText.textContent = 'Connecting to WhatsApp client. Compile action will unlock once ready.';
    }
  }
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeProjects(value) {
  let list = [];
  if (Array.isArray(value)) {
    list = value.map((v) => {
      if (typeof v === 'object' && v !== null) {
        return { name: String(v.name || v.project || '').trim(), status: String(v.status || 'not mentioned').trim() };
      }
      const str = String(v || '').trim();
      let name = str, status = 'not mentioned';
      if (str.includes('::')) [name, status] = str.split('::');
      return { name: name.trim(), status: status.trim() };
    }).filter(p => p.name);
  } else if (typeof value === 'string') {
    const parts = value.split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);
    list = parts.map(p => {
      let name = p, status = 'not mentioned';
      if (p.includes('::')) [name, status] = p.split('::');
      return { name: name.trim(), status: status.trim() };
    });
  }

  // deduplicate by name
  const seen = new Set();
  const result = [];
  for (const p of list) {
    if (!seen.has(p.name)) {
      seen.add(p.name);
      result.push(p);
    }
  }
  return result;
}

async function loadProjectCatalog() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load projects');
    availableProjects = Array.isArray(data.projects)
      ? Array.from(new Set(data.projects.map((p) => String(typeof p === 'object' ? p.name : p || '').trim()).filter(Boolean)))
      : [];
  } catch (err) {
    console.error('Failed to load project catalog:', err);
    availableProjects = [];
  }
}

async function ensureApiKeyForModel(aiModel) {
  try {
    const res = await fetch(`/api/ai-key-status?aiModel=${encodeURIComponent(aiModel)}`);
    const data = await res.json();

    if (res.ok && data.ok) return { ok: true };

    const missingVar = data?.envVar || 'API_KEY';
    const provider = (data?.provider || 'selected provider').toUpperCase();

    // -- Check localStorage first BEFORE prompting --
    if (missingVar && localStorage.getItem(missingVar)) {
        return { ok: true, runtimeApiKey: localStorage.getItem(missingVar) };
    }

    const overviewRes = await fetch('/api/ai-key-overview');
    const overview = await overviewRes.json();
    const providers = overview?.providers || {};
    // Add localstorage simulated providers mapping
    const lsProviders = {
      gemini: !!localStorage.getItem('GEMINI_API_KEY'),
      groq: !!localStorage.getItem('GROQ_API_KEY'),
      cerebras: !!localStorage.getItem('CEREBRAS_API_KEY')
    };

    const modelSelect = document.getElementById('model-select');
    const fallbackCandidates = [];

    if (modelSelect) {
      const options = Array.from(modelSelect.options || []);
      for (const opt of options) {
        const value = String(opt.value || '').trim();
        if (!value || value === aiModel) continue;

        let optProvider = '';
        const lower = value.toLowerCase();
        if (lower === 'gemini-2.5-flash') optProvider = 'gemini';
        else if (lower.startsWith('groq:')) optProvider = 'groq';
        else if (lower.startsWith('cerebras:')) optProvider = 'cerebras';

        if (!optProvider) continue;
        if (!providers[optProvider] && !lsProviders[optProvider]) continue; // skip if no key anywhere
        fallbackCandidates.push({ value, label: opt.textContent || value, provider: optProvider });
      }
    }

    if (fallbackCandidates.length > 0) {
      const fallback = fallbackCandidates[0];
      const shouldFallback = confirm(
        `${provider} key not found (${missingVar}).\n\n` +
        `Switch to available ${fallback.provider.toUpperCase()} model now?\n` +
        `${fallback.label}`
      );

      if (shouldFallback) {
        if (modelSelect) modelSelect.value = fallback.value;
        return { ok: true, switched: true, model: fallback.value };
      }
    }

    const enteredKey = prompt(
      `${provider} key not found (${missingVar}) and no automatic fallback selected.\n\n` +
      `Paste ${provider} API key to use for this run only (or check ⚙ Settings):`
    );

    if (typeof enteredKey === 'string' && enteredKey.trim()) {
      return { ok: true, runtimeApiKey: enteredKey.trim() };
    }

    return { ok: false };
  } catch (err) {
    alert(`Unable to verify API key status before scraping. ${err.message || ''}`.trim());
    return { ok: false };
  }
}

function setCheckoutProgress(percentage) {
  const p = Math.max(0, Math.min(100, Math.round(percentage)));
  checkoutProgressValue = p;
  progressUI.percent.textContent = `${p}%`;
  progressUI.fill.style.width = `${p}%`;
}

function setCheckoutPhase(phase, subtext) {
  checkoutPhase = phase;
  if (phase === 'scrape') {
    progressUI.phase.textContent = 'Scraping WhatsApp Groups';
  } else if (phase === 'ai') {
    progressUI.phase.textContent = 'Running AI Extraction';
  } else if (phase === 'complete') {
    progressUI.phase.textContent = 'Completed';
  } else {
    progressUI.phase.textContent = 'Preparing...';
  }

  if (typeof subtext === 'string') {
    progressUI.sub.textContent = subtext;
  }
}

function beginCheckoutProgress() {
  checkoutRunInFlight = true;
  lastScanEventAt = Date.now();
  progressUI.wrap.classList.remove('hidden');
  setCheckoutPhase('scrape', 'Preparing scan and syncing logs...');
  setCheckoutProgress(3);

  if (aiTickTimer) clearInterval(aiTickTimer);
  aiTickTimer = setInterval(() => {
    if (!checkoutRunInFlight) return;

    // If scan events stop arriving during request, move to AI phase.
    if (checkoutPhase === 'scrape' && Date.now() - lastScanEventAt > 1800 && checkoutProgressValue >= 65) {
      setCheckoutPhase('ai', 'Scan finished, parsing summaries with selected model...');
      if (checkoutProgressValue < 86) setCheckoutProgress(86);
    }

    // AI phase progress creep for better perceived responsiveness.
    if (checkoutPhase === 'ai' && checkoutProgressValue < 97) {
      setCheckoutProgress(checkoutProgressValue + 1);
    }

    if (checkoutPhase === 'scrape' && checkoutProgressValue < 12) {
      setCheckoutProgress(checkoutProgressValue + 1);
    }
  }, 350);
}

function completeCheckoutProgress(finalText) {
  checkoutRunInFlight = false;
  if (aiTickTimer) {
    clearInterval(aiTickTimer);
    aiTickTimer = null;
  }
  setCheckoutPhase('complete', finalText || 'Done. Results rendered and saved.');
  setCheckoutProgress(100);
}

const checkoutEvents = new EventSource('/api/events');
checkoutEvents.addEventListener('state', (e) => {
  try {
    const data = JSON.parse(e.data);
    updateCheckoutBotStatus(data.state, data.text);
  } catch (_) {
    // Ignore malformed SSE payloads.
  }
});

checkoutEvents.addEventListener('qr', (e) => {
  try {
    latestQrValue = normalizeQrPayload(e.data);
    renderQrToCanvas(checkoutBotUI.authQrCanvas, latestQrValue);
  } catch (_) {
    // Ignore malformed QR payload.
  }
});

checkoutEvents.addEventListener('progress', (e) => {
  if (!checkoutRunInFlight) return;
  try {
    const data = JSON.parse(e.data);
    const rawPct = Number(data.percentage) || 0;
    const mapped = Math.min(84, Math.max(8, Math.round(rawPct * 0.84)));
    lastScanEventAt = Date.now();
    if (checkoutPhase !== 'scrape') setCheckoutPhase('scrape');
    setCheckoutProgress(Math.max(checkoutProgressValue, mapped));
    if (data.groupName) {
      progressUI.sub.textContent = `Scanning group: ${data.groupName}`;
    }
  } catch (_) {
    // Ignore malformed SSE payloads.
  }
});

checkoutEvents.onerror = () => {
  if (!checkoutRunInFlight) {
    updateCheckoutBotStatus('init', 'Reconnecting to WhatsApp status stream...');
  }
};

function renderProjectTags(projects, index) {
  if (!projects.length) {
    return '<span class="project-empty">No mapped project yet</span>';
  }

  return projects.map((p) => {
    const project = p.name;
    const status = (p.status || 'not mentioned').toLowerCase();
    let statusClass = 'tag-yellow';
    let displayStatus = 'Not mentioned';

    if (status === 'yes' || status === 'updated') {
      statusClass = 'tag-green';
      displayStatus = 'Updated';
    } else if (status === 'no' || status === 'not updated') {
      statusClass = 'tag-red';
      displayStatus = 'Not updated';
    }
    
    return `<span class="project-tag ${statusClass}" title="${escapeHtml(project)} (Status: ${escapeHtml(status)})">` +
      `<span class="project-tag-text">${escapeHtml(project)} - ${displayStatus}</span>` +
      `<button class="project-tag-remove" data-idx="${index}" data-project="${escapeHtml(project)}" title="Remove project">x</button>` +
    `</span>`;
  }).join('');
}

function getFilteredProjects(index, query) {
  const selected = new Set(normalizeProjects(currentCheckoutData[index]?.projects).map(p => p.name));
  const q = String(query || '').trim().toLowerCase();

  return availableProjects
    .filter((p) => !selected.has(p))
    .filter((p) => !q || p.toLowerCase().includes(q))
    .slice(0, 12);
}

function renderDropdown(index, query) {
  const dropdown = document.querySelector(`.project-dropdown[data-idx="${index}"]`);
  if (!dropdown) return;

  const items = getFilteredProjects(index, query);
  if (!items.length) {
    dropdown.innerHTML = '<div class="project-option-empty">No matching project</div>';
    dropdown.classList.remove('hidden');
    return;
  }

  dropdown.innerHTML = items
    .map((p) => `<button class="project-option" data-idx="${index}" data-project="${escapeHtml(p)}" type="button">${escapeHtml(p)}</button>`)
    .join('');
  
  // Re-attach click events to the fresh dynamically generated options
  dropdown.querySelectorAll('.project-option').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => {
      // Use mousedown instead of click so it fires BEFORE the input blur handler hides the dropdown
      e.preventDefault();
      const idx = Number(e.currentTarget.getAttribute('data-idx'));
      const project = e.currentTarget.getAttribute('data-project') || '';
      
      // Delay DOM destruction by 150ms so the native click/mouseup doesn't fall through
      setTimeout(() => {
        addProjectToRow(idx, project);
      }, 150);
    });
  });

  dropdown.classList.remove('hidden');
}

function addProjectToRow(index, projectName) {
  const project = String(projectName || '').trim();
  if (!project) return;

  const row = currentCheckoutData[index];
  if (!row) return;

  const list = normalizeProjects(row.projects);
  if (list.some(p => p.name === project)) return;

  list.push({ name: project, status: 'not mentioned' });
  row.projects = list;
  renderCheckoutTable();
  autoSave();
}

function removeProjectFromRow(index, projectName) {
  const row = currentCheckoutData[index];
  if (!row) return;

  row.projects = normalizeProjects(row.projects).filter((p) => p.name !== projectName);
  renderCheckoutTable();
  autoSave();
}

function attachProjectEditorEvents() {
  document.querySelectorAll('.project-search').forEach((input) => {
    input.addEventListener('focus', (e) => {
      const idx = Number(e.currentTarget.getAttribute('data-idx'));
      renderDropdown(idx, e.currentTarget.value);
    });

    input.addEventListener('input', (e) => {
      const idx = Number(e.currentTarget.getAttribute('data-idx'));
      renderDropdown(idx, e.currentTarget.value);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();

      const idx = Number(e.currentTarget.getAttribute('data-idx'));
      const currentValue = e.currentTarget.value;
      const filtered = getFilteredProjects(idx, currentValue);
      if (filtered.length > 0) {
        addProjectToRow(idx, filtered[0]);
      }
    });

    input.addEventListener('blur', (e) => {
      const idx = Number(e.currentTarget.getAttribute('data-idx'));
      const dropdown = document.querySelector(`.project-dropdown[data-idx="${idx}"]`);
      setTimeout(() => {
        if (dropdown) dropdown.classList.add('hidden');
      }, 150);
    });
  });

  document.querySelectorAll('.project-option').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = Number(e.currentTarget.getAttribute('data-idx'));
      const project = e.currentTarget.getAttribute('data-project') || '';
      addProjectToRow(idx, project);
    });
  });

  document.querySelectorAll('.project-tag-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const idx = Number(e.currentTarget.getAttribute('data-idx'));
      const project = e.currentTarget.getAttribute('data-project') || '';
      removeProjectFromRow(idx, project);
    });
  });
}

document.getElementById('run-ai-btn').addEventListener('click', async () => {
  const btn = document.getElementById('run-ai-btn');
  const tbody = document.getElementById('checkout-body');
  const statParsed = document.getElementById('stat-parsed');
  const hours = parseInt(document.getElementById('hours-input').value, 10) || 24;
  let aiModel = document.getElementById('model-select').value;
  const hardRescan = Boolean(document.getElementById('checkout-hard-rescan')?.checked);

  if (!canRunCheckoutForState(checkoutBotState)) {
    alert('WhatsApp client is not ready yet. Wait for connection to finish, then try again.');
    return;
  }

  const keyCheck = await ensureApiKeyForModel(aiModel);
  if (!keyCheck.ok) return;
  if (keyCheck.switched && keyCheck.model) {
    aiModel = keyCheck.model;
  }
  const runtimeApiKey = keyCheck.runtimeApiKey || '';

  btn.disabled = true;
  beginCheckoutProgress();
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">Extracting parameters from message payload...</td></tr>';

  try {
      const apiKeys = {
        gemini: localStorage.getItem('GEMINI_API_KEY') || '',
        groq: localStorage.getItem('GROQ_API_KEY') || '',
        cerebras: localStorage.getItem('CEREBRAS_API_KEY') || ''
      };

      const res = await fetch('/api/process-checkouts', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours, aiModel, hardRescan, runtimeApiKey, apiKeys })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to process checkouts");
      
      currentCheckoutData = (data.results || []).map((item) => ({
        ...item,
        projects: normalizeProjects(item.projects)
      }));
      renderCheckoutTable();

      statParsed.textContent = currentCheckoutData.length;
      await autoSave();
        completeCheckoutProgress(`Complete. ${currentCheckoutData.length} records compiled.`);
      alert(`AI execution completed! Exported ${currentCheckoutData.length} records instantly.`);
  } catch (error) {
      console.error(error);
        completeCheckoutProgress('Run failed. Please review the error message and retry.');
      alert(error.message || "An error occurred during AI processing.");
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--danger);">${error.message || "Error executing AI."}</td></tr>`;
  } finally {
      btn.disabled = false;
  }
});

function renderCheckoutTable() {
  const tbody = document.getElementById('checkout-body');
  const statParsed = document.getElementById('stat-parsed');
  tbody.innerHTML = '';

  if (currentCheckoutData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">No checkout messages found in the logs!</td></tr>';
    statParsed.textContent = 0;
    return;
  }

  currentCheckoutData.forEach((item, index) => {
      item.projects = normalizeProjects(item.projects);
      const tr = document.createElement('tr');
      tr.className = 'fade-in';
      tr.innerHTML = `
          <td style="font-weight: 500;">${item.developer}</td>
          <td class="col-group"><span class="group-name">${item.groupName}</span></td>
          <td class="col-projects">
            <div class="project-editor" data-idx="${index}">
              <div class="project-tags-wrap">${renderProjectTags(item.projects, index)}</div>
              <div class="project-picker-wrap">
                <input type="text" class="modern-input project-search" data-idx="${index}" placeholder="Search and add project...">
                <div class="project-dropdown hidden" data-idx="${index}"></div>
              </div>
            </div>
          </td>
          <td class="checkout-msg-col">
            <div style="background:rgba(0,0,0,0.2); border-radius:6px; padding:0.4rem; text-align:left;">
              <pre style="white-space: pre-wrap; word-break: break-word; font-size:10px; color:var(--text-muted); margin:0; font-family:inherit; max-height:90px; overflow-y:auto;">${item.originalText}</pre>
            </div>
          </td>
          <td class="text-right" style="white-space:nowrap;">
            <button class="primary-btn delete-btn" data-idx="${index}" style="background: var(--danger); padding:0.3rem 0.6rem; font-size:0.75rem;">Delete</button>
          </td>
      `;
      tbody.appendChild(tr);
  });

  statParsed.textContent = currentCheckoutData.length;

  attachProjectEditorEvents();

  document.querySelectorAll('#checkout-body .delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
      currentCheckoutData.splice(idx, 1);
      renderCheckoutTable();
      autoSave();
    });
  });
}

async function autoSave() {
  try {
    await fetch('/api/save-checkouts', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: currentCheckoutData })
    });
  } catch (err) {
    console.error("Auto-save failed: ", err);
  }
}

loadProjectCatalog();

window.addEventListener('projects:updated', (e) => {
  const incoming = Array.isArray(e.detail?.projects) ? e.detail.projects : [];
  availableProjects = Array.from(new Set(incoming.map((p) => String(typeof p === 'object' ? p.name : p || '').trim()).filter(Boolean)));
});

fetch('/api/status')
  .then((res) => res.json())
  .then((data) => {
    updateCheckoutBotStatus(data.state, data.text);
  })
  .catch(() => {
    updateCheckoutBotStatus('init', 'Connecting to WhatsApp status...');
  });

// ── Repo Update Checking ──────────────────────────────────────────────

const repoCheckUI = {
  btn: document.getElementById('check-repo-btn'),
  hint: document.getElementById('repo-check-hint'),
  progress: document.getElementById('repo-check-progress'),
  phase: document.getElementById('repo-check-phase'),
  percent: document.getElementById('repo-check-percent'),
  fill: document.getElementById('repo-check-fill'),
  sub: document.getElementById('repo-check-sub'),
  summary: document.getElementById('repo-results-summary')
};

let repoCheckInFlight = false;

function updateRepoCheckButton() {
  const hasData = currentCheckoutData.length > 0;
  if (repoCheckUI.btn) {
    repoCheckUI.btn.disabled = !hasData || repoCheckInFlight;
  }
  if (repoCheckUI.hint) {
    repoCheckUI.hint.textContent = hasData
      ? `${collectDevMappings().length} developer(s) ready to check`
      : 'Run AI extraction first to enable repo checking';
    repoCheckUI.hint.style.color = hasData ? 'var(--success)' : 'var(--text-muted)';
  }
}

function collectDevMappings() {
  const devs = [];
  for (const item of currentCheckoutData) {
    if (!item.developer) continue;
    const projects = normalizeProjects(item.projects).map(p => p.name).filter(Boolean);
    if (projects.length > 0) {
      devs.push({ name: item.developer, projects });
    }
  }
  return devs;
}

function setRepoCheckProgress(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  if (repoCheckUI.percent) repoCheckUI.percent.textContent = `${p}%`;
  if (repoCheckUI.fill) repoCheckUI.fill.style.width = `${p}%`;
}

let lastRepoDevStatuses = [];

window.applyManualRepoTime = function(devNameStr, projectNameStr) {
  const inputEl = document.getElementById(`manual-time-${devNameStr}-${projectNameStr}`);
  if (!inputEl) return;
  const val = inputEl.value.trim();
  if (!val) return;
  
  const hours = parseTimeStr(val);
  const limitInput = document.getElementById('repo-lookback-input');
  const limitHours = limitInput ? parseTimeStr(limitInput.value) : 48;
  
  let anythingChanged = false;
  
  for (const ds of lastRepoDevStatuses) {
    if (ds.name === devNameStr) {
      for (const ps of ds.projectStatuses) {
        if (ps.project === projectNameStr) {
           ps.updated48h = (hours <= limitHours);
           ps.isGithubSkipped = false; 
           ps.updateTime = val + " ago"; 
           anythingChanged = true;
        }
      }
      ds.hasUpdated = ds.projectStatuses.some(p => p.updated48h);
    }
  }
  
  if (!anythingChanged) return;
  
  const textSummaryLines = [];
  for (const ds of lastRepoDevStatuses) {
    const parts = [];
    for (const ps of ds.projectStatuses) {
      if (!ps.updated48h) {
         let timeLabel = ps.updateTime === 'no commit found' ? 'NO' : ps.updateTime;
         if (ps.isGithubSkipped) timeLabel = 'GITHUB SKIPPED';
         parts.push(`${ps.project} (${timeLabel})`);
      }
    }
    if (parts.length > 0) {
      textSummaryLines.push(`${ds.name} -> ${parts.join(', ')}`);
    }
  }
  
  const newSummary = textSummaryLines.join('\n');
  renderRepoResultsSummary(lastRepoDevStatuses, newSummary);
  applyRepoStatusToTags(lastRepoDevStatuses);
};

function renderRepoResultsSummary(devStatuses, textSummary) {
  lastRepoDevStatuses = devStatuses || [];
  if (!repoCheckUI.summary) return;

  if (!devStatuses || devStatuses.length === 0) {
    repoCheckUI.summary.innerHTML = '<p style="color:var(--text-muted);">No results to display.</p>';
    repoCheckUI.summary.classList.remove('hidden');
    return;
  }

  let html = `<div class="repo-summary-header">
    <h3>Developer Repo Updates</h3>
  </div>`;

  html += `<div class="repo-dev-list" style="margin-bottom: 1.5rem;">`;
  
  for (const ds of devStatuses) {
    const devIcon = ds.hasUpdated ? '<span style="color:var(--success);">✓</span>' : '<span style="color:var(--danger);">✗</span>';
    const projNames = ds.projectStatuses.map(p => escapeHtml(p.project)).join(', ');
    
    html += `<div style="margin-bottom: 0.8rem;">
      <div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 0.3rem;">
        ${devIcon} ${escapeHtml(ds.name)} <span style="color:var(--text-muted); font-size:0.8rem; font-weight:normal;">[${projNames}]</span>
      </div>
      <div style="padding-left: 1.5rem; display: flex; flex-direction: column; gap: 0.2rem;">
    `;
    
    for (const ps of ds.projectStatuses) {
      let color = 'var(--text-muted)';
      let icon = '☐';
      if (ps.updated48h) {
        color = 'var(--success)';
        icon = '☑';
      } else if (!ps.isGithubSkipped) {
        color = 'var(--danger)'; 
        icon = '☒';
      } else {
        color = 'var(--danger)';
        icon = '☒';
      }
      
      const safeName = escapeHtml(ds.name);
      const safeProj = escapeHtml(ps.project);

      if (ps.isGithubSkipped) {
        let label = 'GITHUB SKIPPED';
        if (ps.githubLinks && ps.githubLinks.length > 0) {
          label += ' -> ' + ps.githubLinks.map(l => `<a href="${escapeHtml(l)}" target="_blank" style="color:#3b82f6;text-decoration:none;">link</a>`).join(', ');
        }
        
        html += `<div style="color: ${color}; font-size: 0.85rem; display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; margin-top:0.15rem;">
          <div>${icon} ${safeProj}: <span style="font-size:0.8rem; font-weight:500;">${label}</span></div>
          <input type="text" id="manual-time-${safeName}-${safeProj}" class="modern-input" style="width:70px; padding:0.1rem 0.3rem; font-size:0.75rem;" placeholder="e.g. 2h">
          <button class="primary-btn" onclick="applyManualRepoTime('${safeName.replace(/'/g,"\\'")}','${safeProj.replace(/'/g,"\\'")}')" style="padding:0.1rem 0.4rem; font-size:0.7rem;">Apply</button>
        </div>`;
      } else {
        html += `<div style="color: ${color}; font-size: 0.85rem;">
          ${icon} ${safeProj}: ${escapeHtml(ps.updateTime)}
        </div>`;
      }
    }
    
    html += `</div></div>`;
  }
  html += `</div>`;

  if (textSummary) {
    html += `
      <div style="margin-top: 1rem; position: relative;">
        <h4 style="margin-bottom: 0.5rem; color: #94a3b8; display:flex; justify-content:space-between; align-items:center;">
          Text Summary
          <button type="button" class="primary-btn" onclick="navigator.clipboard.writeText(document.getElementById('repo-text-summary-val').value); this.innerText='Copied!'; setTimeout(() => this.innerText='Copy', 2000);" style="padding: 0.2rem 0.5rem; font-size: 0.75rem;">Copy</button>
        </h4>
        <textarea id="repo-text-summary-val" readonly style="width: 100%; height: 150px; background: rgba(0,0,0,0.2); border: 1px solid var(--card-border); color: #e2e8f0; padding: 0.5rem; font-family: monospace; border-radius: 0.4rem;">${escapeHtml(textSummary)}</textarea>
      </div>
    `;
  }

  repoCheckUI.summary.innerHTML = html;
  repoCheckUI.summary.classList.remove('hidden');
}

function applyRepoStatusToTags(devStatuses) {
  for (const item of currentCheckoutData) {
    if (!item.developer) continue;
    const ds = devStatuses.find(d => String(d.name).toLowerCase() === String(item.developer).toLowerCase());
    if (!ds) continue;
    
    const projects = normalizeProjects(item.projects);
    const updated = projects.map(p => {
      const ps = ds.projectStatuses.find(x => String(x.project).toLowerCase() === String(p.name).toLowerCase());
      if (!ps) return p;
      
      let newStatus = p.status;
      if (ps.updated48h) newStatus = 'yes';
      else if (ps.isGithubSkipped) newStatus = 'not mentioned';
      else newStatus = 'no';
      
      return { name: p.name, status: newStatus };
    });
    item.projects = updated;
  }
  renderCheckoutTable();
  autoSave();
}

function parseTimeStr(val) {
  let s = String(val || '').trim().toLowerCase();
  if (!s) return 48;
  if (s.endsWith('m')) {
    s = s.slice(0, -1);
    if (!isNaN(s)) return parseFloat(s) / 60.0;
  } else if (s.endsWith('d')) {
    s = s.slice(0, -1);
    if (!isNaN(s)) return parseFloat(s) * 24.0;
  } else {
    if (s.endsWith('h')) s = s.slice(0, -1);
    if (!isNaN(s)) return parseFloat(s);
  }
  return 48;
}

if (repoCheckUI.btn) {
  repoCheckUI.btn.addEventListener('click', async () => {
    if (repoCheckInFlight) return;

    const devMappings = collectDevMappings();
    if (devMappings.length === 0) {
      alert('No projects or developers found. Run AI extraction first.');
      return;
    }

    const rawTime = document.getElementById('repo-lookback-input').value;
    const hours = parseTimeStr(rawTime);

    repoCheckInFlight = true;
    repoCheckUI.btn.disabled = true;
    repoCheckUI.progress.classList.remove('hidden');
    repoCheckUI.summary.classList.add('hidden');
    repoCheckUI.phase.textContent = 'Checking Gitea repos...';
    repoCheckUI.sub.textContent = `Querying for ${devMappings.length} dev(s) against Gitea API...`;
    setRepoCheckProgress(10);

    // Fake progress ticker
    let fakePct = 10;
    const ticker = setInterval(() => {
      if (fakePct < 90) {
        fakePct += Math.random() * 3;
        setRepoCheckProgress(fakePct);
      }
    }, 500);

    try {
      const giteaKey = localStorage.getItem('GITEA_API_KEY') || '';
      if (!giteaKey) {
        throw new Error('Gitea API Key is missing. Please add it via the ⚙ Settings menu in the top right.');
      }

      const res = await fetch('/api/check-repo-updates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours, devs: devMappings, giteaKey })
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to check repo updates');

      clearInterval(ticker);
      setRepoCheckProgress(100);
      repoCheckUI.phase.textContent = 'Repo check complete';
      repoCheckUI.sub.textContent = `Checked ${devMappings.length} dev(s). Results below.`;

      // Apply real statuses to project tags
      if (data.devStatuses) {
        applyRepoStatusToTags(data.devStatuses);
        renderRepoResultsSummary(data.devStatuses, data.textSummary);
      }

      // Keep progress visible briefly then auto-hide
      setTimeout(() => {
        repoCheckUI.progress.classList.add('hidden');
      }, 3000);

    } catch (err) {
      clearInterval(ticker);
      setRepoCheckProgress(0);
      repoCheckUI.phase.textContent = 'Error checking repos';
      repoCheckUI.sub.textContent = err.message;
      alert(`Repo check failed: ${err.message}`);
    } finally {
      repoCheckInFlight = false;
      repoCheckUI.btn.disabled = false;
    }
  });
}

// Keep the button state in sync with checkout data
const origRenderCheckoutTable = renderCheckoutTable;
renderCheckoutTable = function () {
  origRenderCheckoutTable();
  updateRepoCheckButton();
};
updateRepoCheckButton();

