(function () {
  const modal = document.getElementById('groups-modal');
  const openBtn = document.getElementById('open-groups-modal-btn');
  const closeBtn = document.getElementById('close-groups-modal-btn');
  const addRowBtn = document.getElementById('groups-add-row-btn');
  const saveBtn = document.getElementById('groups-save-btn');
  const tableBody = document.getElementById('groups-table-body');
  const newNameInput = document.getElementById('groups-new-name');
  const newGroupInput = document.getElementById('groups-new-group');
  const newTypeSelect = document.getElementById('groups-new-type');

  if (!modal || !openBtn || !closeBtn || !addRowBtn || !saveBtn || !tableBody || !newNameInput || !newGroupInput || !newTypeSelect) {
    return;
  }

  const defaultTypes = ['dev', 'qa', 'tester', 'va', 'trainee'];
  let rows = [];

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sortRows(list) {
    return [...list].sort((a, b) => {
      const nameCmp = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
      if (nameCmp !== 0) return nameCmp;
      return String(a.group || '').localeCompare(String(b.group || ''), undefined, { sensitivity: 'base' });
    });
  }

  function setModalOpen(isOpen) {
    modal.classList.toggle('hidden', !isOpen);
    document.body.classList.toggle('modal-locked', isOpen);
  }

  async function parseApiResponse(res) {
    const raw = await res.text();
    let data = null;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      const sample = raw.slice(0, 120).replace(/\s+/g, ' ');
      throw new Error('Server returned non-JSON response (' + res.status + '). ' + sample);
    }

    return data;
  }

  function buildTypeOptions(currentType) {
    const normalized = String(currentType || 'dev').trim().toLowerCase() || 'dev';
    const options = [...defaultTypes];
    if (!options.includes(normalized)) options.push(normalized);

    return options
      .map((type) => {
        const selected = type === normalized ? ' selected' : '';
        return '<option value="' + escapeHtml(type) + '"' + selected + '>' + escapeHtml(type) + '</option>';
      })
      .join('');
  }

  function renderRows() {
    rows = sortRows(rows);

    if (rows.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="4" class="groups-empty">No rows yet. Use the fields above and click Add New.</td></tr>';
      return;
    }

    tableBody.innerHTML = rows
      .map((row, index) => (
        '<tr data-index="' + index + '">' +
          '<td><input class="modern-input groups-input groups-name" data-field="name" value="' + escapeHtml(row.name) + '" placeholder="Employee name"></td>' +
          '<td><input class="modern-input groups-input groups-group" data-field="group" value="' + escapeHtml(row.group) + '" placeholder="WhatsApp group name"></td>' +
          '<td><select class="modern-input groups-select groups-type" data-field="type">' + buildTypeOptions(row.type) + '</select></td>' +
          '<td><button type="button" class="primary-btn groups-remove-btn" data-remove-index="' + index + '" aria-label="Delete row" title="Delete row">' +
            '<span aria-hidden="true" class="groups-remove-glyph">&#128465;</span>' +
          '</button></td>' +
        '</tr>'
      ))
      .join('');

    tableBody.querySelectorAll('input[data-field], select[data-field]').forEach((el) => {
      el.addEventListener('input', (e) => {
        const tr = e.currentTarget.closest('tr');
        if (!tr) return;
        const idx = Number(tr.getAttribute('data-index'));
        const field = e.currentTarget.getAttribute('data-field');
        if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length || !field) return;

        rows[idx][field] = String(e.currentTarget.value || '');
      });
    });

    tableBody.querySelectorAll('.groups-remove-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = Number(e.currentTarget.getAttribute('data-remove-index'));
        if (!Number.isInteger(idx) || idx < 0 || idx >= rows.length) return;
        rows.splice(idx, 1);
        renderRows();
      });
    });
  }

  async function loadRows() {
    try {
      const res = await fetch('/api/groups', { headers: { 'Accept': 'application/json' } });
      const data = await parseApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to load group chats');

      rows = Array.isArray(data.rows)
        ? data.rows.map((row) => ({
          name: String(row.name || ''),
          group: String(row.group || ''),
          type: String(row.type || 'dev')
        }))
        : [];

      renderRows();
    } catch (err) {
      tableBody.innerHTML = '<tr><td colspan="4" class="groups-empty">Could not load rows.</td></tr>';
      alert(err.message || 'Failed to load groups');
    }
  }

  function collectRowsFromState() {
    return rows
      .map((row) => ({
        name: String(row.name || '').trim(),
        group: String(row.group || '').trim(),
        type: String(row.type || 'dev').trim().toLowerCase() || 'dev'
      }))
      .filter((row) => row.name && row.group);
  }

  async function saveRows() {
    const payloadRows = collectRowsFromState();

    try {
      saveBtn.disabled = true;
      const res = await fetch('/api/groups/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ rows: payloadRows })
      });

      const data = await parseApiResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to save groups');

      rows = Array.isArray(data.rows) ? data.rows : payloadRows;
      renderRows();
      window.dispatchEvent(new CustomEvent('groups:updated', { detail: { rows } }));
      alert('Group chats saved. Checkins were reset to 0 in CSV as requested.');
    } catch (err) {
      alert(err.message || 'Failed to save groups');
    } finally {
      saveBtn.disabled = false;
    }
  }

  openBtn.addEventListener('click', async () => {
    setModalOpen(true);
    await loadRows();
  });

  closeBtn.addEventListener('click', () => setModalOpen(false));

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      setModalOpen(false);
    }
  });

  function addRowFromInputs() {
    const name = String(newNameInput.value || '').trim();
    const group = String(newGroupInput.value || '').trim();
    const type = String(newTypeSelect.value || 'dev').trim().toLowerCase() || 'dev';

    if (!name || !group) {
      alert('Name and Group Name are required to add a new row.');
      return;
    }

    rows.push({ name, group, type });
    renderRows();
    newNameInput.value = '';
    newGroupInput.value = '';
    newTypeSelect.value = 'dev';
    newNameInput.focus();
  }

  addRowBtn.addEventListener('click', addRowFromInputs);

  [newNameInput, newGroupInput, newTypeSelect].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addRowFromInputs();
      }
    });
  });

  saveBtn.addEventListener('click', saveRows);
})();
