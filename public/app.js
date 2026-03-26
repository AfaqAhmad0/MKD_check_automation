const elements = {
  statusBadge: document.getElementById('bot-status-badge'),
  statusText: document.getElementById('bot-status-text'),
  pulseDot: document.querySelector('.pulse-dot'),
  qrSection: document.getElementById('qr-section'),
  qrCanvas: document.getElementById('qr-canvas'),
  controlPanel: document.getElementById('control-panel'),
  setupBar: document.getElementById('setup-bar'),
  hoursInput: document.getElementById('hours-input'),
  hardRescanInput: document.getElementById('hard-rescan-input'),
  startBtn: document.getElementById('start-btn'),
  progressContainer: document.getElementById('progress-container'),
  progressLabel: document.getElementById('progress-label'),
  progressPercentage: document.getElementById('progress-percentage'),
  progressFill: document.getElementById('progress-fill'),
  currentTarget: document.getElementById('current-target'),
  dataSection: document.getElementById('data-section'),
  tableBody: document.getElementById('table-body'),
  statTotal: document.getElementById('stat-total'),
  statYes: document.getElementById('stat-yes'),
  statNo: document.getElementById('stat-no'),
  statusFilter: document.getElementById('status-filter'),
  resetBtn: document.getElementById('reset-btn'),
  authModal: document.getElementById('wa-auth-modal'),
  authSubtext: document.getElementById('wa-auth-subtext'),
  authQrCanvas: document.getElementById('wa-auth-qr-canvas'),
};

let currentState = 'init';
let eventSource = null;
let currentData = [];
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
  if (!elements.authModal) return;
  elements.authModal.classList.toggle('hidden', !shouldShow);
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
    renderQrToCanvas(elements.authQrCanvas, latestQrValue);
  } catch (_) {
    // Ignore QR fetch errors and wait for SSE event.
  }
}

// Attach filter listener
elements.statusFilter.addEventListener('change', () => {
  renderTable(currentData);
});

function updateStatusUI(state, text) {
  elements.statusText.textContent = text;
  if (state === 'ready' || state === 'monitoring') {
    elements.pulseDot.classList.add('active');
  } else {
    elements.pulseDot.classList.remove('active');
  }
}

function handleState(state, text) {
  currentState = state;
  updateStatusUI(state, text);

  const shouldShowAuthModal = state === 'qr';
  setAuthModalVisibility(shouldShowAuthModal);
  if (elements.authSubtext && shouldShowAuthModal) {
    elements.authSubtext.textContent = 'Scan this QR code with your WhatsApp app to continue.';
  }
  if (shouldShowAuthModal && !latestQrValue) {
    fetchAndRenderLatestQr();
  }

  elements.qrSection.classList.add('hidden');
  elements.controlPanel.classList.add('hidden');
  elements.progressContainer.classList.add('hidden');
  elements.dataSection.classList.add('hidden');
  
  if (state === 'qr') {
    elements.qrSection.classList.remove('hidden', 'fade-in');
    void elements.qrSection.offsetWidth; // trigger reflow
    elements.qrSection.classList.add('fade-in');
  } else if (state === 'ready') {
    elements.controlPanel.classList.remove('hidden', 'fade-in');
    elements.setupBar.classList.remove('hidden');
    elements.startBtn.disabled = false;
    void elements.controlPanel.offsetWidth;
    elements.controlPanel.classList.add('fade-in');
    fetchData();
  } else if (state === 'scanning') {
    elements.controlPanel.classList.remove('hidden');
    elements.setupBar.classList.add('hidden');
    elements.progressContainer.classList.remove('hidden');
  } else if (state === 'monitoring') {
    elements.controlPanel.classList.add('hidden');
    elements.dataSection.classList.remove('hidden', 'fade-in');
    void elements.dataSection.offsetWidth;
    elements.dataSection.classList.add('fade-in');
    fetchData();
  }
}

async function fetchData() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) return;
    currentData = await res.json();
    renderTable(currentData);
  } catch (err) {
    console.error('Failed to fetch initial data:', err);
  }
}

function renderTable(data) {
  elements.dataSection.classList.remove('hidden');
  elements.tableBody.innerHTML = '';
  
  let yes = 0, no = 0;
  const filterVal = elements.statusFilter.value;

  data.forEach((row, idx) => {
    if (row.checkin === 1) yes++; else no++;

    if (filterVal === 'missing' && row.checkin === 1) return;
    if (filterVal === 'checked-in' && row.checkin === 0) return;

    const tr = document.createElement('tr');
    tr.style.animationDelay = `${idx * 0.02}s`;
    tr.className = 'fade-in';
    
    tr.innerHTML = `
      <td style="font-weight: 500;">${row.name}</td>
      <td><span class="group-name">${row.group}</span></td>
      <td class="text-right">
        <label class="toggle">
          <input type="checkbox" ${row.checkin === 1 ? 'checked' : ''} onchange="toggleStatus('${row.name}', '${row.group}', this.checked)">
          <span class="slider"></span>
        </label>
      </td>
    `;
    elements.tableBody.appendChild(tr);
  });

  elements.statTotal.textContent = data.length;
  elements.statYes.textContent = yes;
  elements.statNo.textContent = no;
}

window.toggleStatus = async (name, group, isChecked) => {
  try {
    await fetch('/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, group, checkin: isChecked ? 1 : 0 })
    });
    // Let the live_update SSE event or rapid re-fetch re-render stats
    fetchData();
  } catch (err) {
    console.error('Failed to update status', err);
    alert('Failed to save status!');
    fetchData(); // Reset toggle
  }
};

elements.startBtn.addEventListener('click', async () => {
  const hours = parseInt(elements.hoursInput.value, 10);
  const hardRescan = Boolean(elements.hardRescanInput?.checked);
  if (isNaN(hours) || hours < 0) return alert("Invalid hours value");

  elements.startBtn.disabled = true;
  try {
    const res = await fetch('/api/start-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours, hardRescan })
    });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || 'Failed to start scan');
    }
  } catch (err) {
    alert(err.message || 'Failed to start scan');
    elements.startBtn.disabled = false;
  }
});

elements.resetBtn.addEventListener('click', async () => {
  const ok = confirm("Are you sure you want to stop live monitoring and configure a new scan?");
  if (!ok) return;

  try {
    const res = await fetch('/api/reset', { method: 'POST' });
    const json = await res.json();
    if (!json.ok) alert("Cannot reset while a scan is currently running.");
  } catch (err) {
    console.error("Failed to reset:", err);
  }
});

function initSSE() {
  eventSource = new EventSource('/api/events');

  eventSource.onopen = () => {
    console.log("Connected to SSE stream");
  };

  eventSource.addEventListener('state', (e) => {
    const data = JSON.parse(e.data);
    handleState(data.state, data.text);
  });

  eventSource.addEventListener('qr', (e) => {
    latestQrValue = normalizeQrPayload(e.data);
    renderQrToCanvas(elements.qrCanvas, latestQrValue);
    renderQrToCanvas(elements.authQrCanvas, latestQrValue);
  });

  eventSource.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    elements.progressPercentage.textContent = `${data.percentage}%`;
    elements.progressFill.style.width = `${data.percentage}%`;
    elements.currentTarget.textContent = `Scanning group: ${data.groupName}`;
  });

  eventSource.addEventListener('live_update', (e) => {
    fetchData(); // A live check-in happen or a CSV sync
  });

  eventSource.onerror = () => {
    updateStatusUI('error', 'Reconnecting...');
  };
}

// Initial fetch to get state before SSE catches up
fetch('/api/status').then(res => res.json()).then(data => {
  handleState(data.state, data.text);
  initSSE();
});

window.addEventListener('groups:updated', () => {
  fetchData();
});
