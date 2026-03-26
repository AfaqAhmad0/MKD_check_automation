(function () {
  // ─── Settings Modal (API Key Management) ─────────────────────

  const MANAGED_KEYS = {
    GROQ_API_KEY:     { label: 'Groq',      envVar: 'GROQ_API_KEY' },
    GEMINI_API_KEY:   { label: 'Google Gemini', envVar: 'GEMINI_API_KEY' },
    CEREBRAS_API_KEY: { label: 'Cerebras',   envVar: 'CEREBRAS_API_KEY' },
    GITEA_API_KEY:    { label: 'Gitea',      envVar: 'GITEA_API_KEY' }
  };

  function maskKey(raw) {
    if (!raw || raw.length < 8) return raw ? '••••' : '';
    return raw.slice(0, 4) + '••••••••' + raw.slice(-4);
  }

  // Inject modal HTML into body if not already present
  if (!document.getElementById('settings-modal')) {
    const modalHtml = `
    <div class="settings-modal hidden" id="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
      <div class="settings-modal-card">
        <div class="settings-modal-header">
          <h2 id="settings-modal-title">⚙ Settings</h2>
          <button type="button" class="settings-modal-close" id="close-settings-modal-btn" aria-label="Close settings">✕</button>
        </div>
        <p class="settings-modal-sub">Manage your API keys. Keys are saved to your browser <code>localStorage</code> so they never leave your device until an extraction is run.</p>
        <div id="settings-keys-container" class="settings-keys-container">
          <div style="color: var(--text-muted); padding: 1rem; text-align: center;">Loading keys...</div>
        </div>
      </div>
    </div>`;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
  }

  // Inject nav button if not already present 
  const navs = document.querySelectorAll('.main-nav');
  navs.forEach(nav => {
    if (!nav.querySelector('#open-settings-btn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nav-link nav-link-btn settings-nav-btn';
      btn.id = 'open-settings-btn';
      btn.innerHTML = '⚙';
      btn.title = 'API Key Settings';
      btn.style.cssText = 'font-size: 1.15rem; padding: 0.3rem 0.5rem; min-width: auto;';
      nav.appendChild(btn);
    }
  });

  const modal = document.getElementById('settings-modal');
  const container = document.getElementById('settings-keys-container');
  let keysData = {};

  function setOpen(open) {
    if (!modal) return;
    modal.classList.toggle('hidden', !open);
    document.body.classList.toggle('modal-locked', open);
    if (open) fetchKeys();
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fetchKeys() {
    const keys = {};
    for (const [id, info] of Object.entries(MANAGED_KEYS)) {
      const raw = localStorage.getItem(info.envVar) || '';
      keys[id] = {
        label: info.label,
        envVar: info.envVar,
        hasKey: raw.trim().length > 0,
        maskedValue: maskKey(raw.trim())
      };
    }
    keysData = keys;
    renderKeys();
  }

  function renderKeys() {
    if (!container) return;
    let html = '';

    for (const [id, info] of Object.entries(keysData)) {
      const statusDot = info.hasKey
        ? '<span style="color:#22c55e; font-size:0.7rem;">●</span>'
        : '<span style="color:#ef4444; font-size:0.7rem;">●</span>';
      const statusText = info.hasKey ? info.maskedValue : 'Not set';

      html += `
      <div class="settings-key-row" id="key-row-${id}">
        <div class="settings-key-info">
          <div class="settings-key-label">${statusDot} ${escapeHtml(info.label)}</div>
          <div class="settings-key-status">${escapeHtml(statusText)}</div>
        </div>
        <div class="settings-key-actions">
          <input type="password" class="modern-input settings-key-input" id="key-input-${id}" 
                 placeholder="Paste new key..." autocomplete="off" spellcheck="false">
          <button type="button" class="primary-btn settings-key-save" data-key-id="${id}" 
                  style="padding: 0.25rem 0.6rem; font-size: 0.8rem;">Save</button>
        </div>
      </div>`;
    }

    container.innerHTML = html;

    // Attach save handlers
    container.querySelectorAll('.settings-key-save').forEach(btn => {
      btn.addEventListener('click', () => {
        const keyId = btn.getAttribute('data-key-id');
        const input = document.getElementById('key-input-' + keyId);
        if (!input) return;
        
        const value = input.value.trim();
        if (!value) {
          input.focus();
          return;
        }

        const info = MANAGED_KEYS[keyId];
        if (info) {
          localStorage.setItem(info.envVar, value);
        }
        
        fetchKeys();
      });
    });

    // Enter key submits
    container.querySelectorAll('.settings-key-input').forEach(input => {
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const row = input.closest('.settings-key-row');
          if (row) row.querySelector('.settings-key-save')?.click();
        }
      });
    });
  }

  // Open/close event bindings
  document.addEventListener('click', e => {
    if (e.target.id === 'open-settings-btn' || e.target.closest('#open-settings-btn')) {
      setOpen(true);
    }
    if (e.target.id === 'close-settings-modal-btn') {
      setOpen(false);
    }
    if (e.target === modal) {
      setOpen(false);
    }
  });

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      setOpen(false);
    }
  });
})();
