(function () {
  const modal = document.getElementById('projects-modal');
  const openBtn = document.getElementById('open-projects-modal-btn');
  const closeBtn = document.getElementById('close-projects-modal-btn');
  const addBtn = document.getElementById('projects-add-btn');
  const cancelBtn = document.getElementById('projects-cancel-btn');
  const newInput = document.getElementById('projects-new-input');
  const reposInput = document.getElementById('projects-repos-input');
  const tagsGrid = document.getElementById('projects-tags-grid');

  if (!modal || !openBtn || !closeBtn || !addBtn || !newInput || !tagsGrid) {
    return;
  }

  let projects = [];
  let loading = false;
  let editingOldName = null; // store name when editing existing project

  function sortedProjects(list) {
    return [...list].sort((a, b) => {
      const nA = typeof a === 'object' ? a.name : String(a);
      const nB = typeof b === 'object' ? b.name : String(b);
      return nA.localeCompare(nB, undefined, { sensitivity: 'base' });
    });
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  
  function resetForm() {
    editingOldName = null;
    newInput.value = '';
    if (reposInput) reposInput.value = '';
    addBtn.textContent = 'Add Project';
    if (cancelBtn) cancelBtn.classList.add('hidden');
  }

  function setModalOpen(isOpen) {
    modal.classList.toggle('hidden', !isOpen);
    document.body.classList.toggle('modal-locked', isOpen);
    if (isOpen) {
      resetForm();
      newInput.focus();
    }
  }

  function renderProjects() {
    const ordered = sortedProjects(projects);

    if (ordered.length === 0) {
      tagsGrid.innerHTML = '<div class="projects-empty">No projects yet. Add one above.</div>';
      return;
    }

    tagsGrid.innerHTML = ordered
      .map((proj) => {
        const name = typeof proj === 'object' ? proj.name : String(proj);
        const repos = (typeof proj === 'object' && Array.isArray(proj.repos)) ? proj.repos : [];
        const safeName = escapeHtml(name);
        const titleText = repos.length > 0 ? "Repos: " + repos.join(', ') + "\n(Click to edit)" : "No repos (Click to edit)";

        return (
          '<div class="project-admin-tag" data-name="' + safeName + '" title="' + escapeHtml(titleText) + '">' +
            '<span class="project-admin-tag-name">' + safeName + '</span>' +
            '<button type="button" class="project-admin-tag-remove" data-name="' + safeName + '" aria-label="Remove project">x</button>' +
          '</div>'
        );
      })
      .join('');

    tagsGrid.querySelectorAll('.project-admin-tag-remove').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = e.currentTarget.getAttribute('data-name') || '';
        if (!name) return;
        
        // Cannot delete while editing it
        if (editingOldName && editingOldName.toLowerCase() === name.toLowerCase()) {
          resetForm();
        }
        await removeProject(name);
      });
    });

    tagsGrid.querySelectorAll('.project-admin-tag').forEach((tag) => {
      tag.addEventListener('click', (e) => {
        if (e.target.classList.contains('project-admin-tag-remove')) return;
        const oldName = e.currentTarget.getAttribute('data-name') || '';
        if (!oldName) return;

        const p = projects.find(x => {
          const xn = typeof x === 'object' ? x.name : String(x);
          return xn.toLowerCase() === oldName.toLowerCase();
        });
        
        if (p) {
          editingOldName = typeof p === 'object' ? p.name : String(p);
          newInput.value = editingOldName;
          if (reposInput) {
             reposInput.value = (p.repos || []).join(', ');
          }
          addBtn.textContent = 'Save Changes';
          if (cancelBtn) cancelBtn.classList.remove('hidden');
        }
      });
    });
  }

  async function parseApiResponse(res) {
    const raw = await res.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      throw new Error('Server returned non-JSON response (' + res.status + ')');
    }
    return data;
  }

  async function fetchProjects() {
    loading = true;
    try {
      const res = await fetch('/api/projects', {
        headers: { 'Accept': 'application/json' }
      });
      const data = await parseApiResponse(res);
      if (!res.ok) throw new Error(data.error || 'Failed to load projects');
      projects = Array.isArray(data.projects) ? data.projects : [];
      renderProjects();
      window.dispatchEvent(new CustomEvent('projects:updated', { detail: { projects } }));
    } catch (err) {
      tagsGrid.innerHTML = '<div class="projects-empty">Could not load projects.</div>';
    } finally {
      loading = false;
    }
  }

  async function saveProjectSubmit() {
    const name = String(newInput.value || '').trim();
    if (!name) return;
    
    let repos = [];
    if (reposInput) {
      repos = reposInput.value.split(',').map(r => r.trim()).filter(Boolean);
    }

    try {
      addBtn.disabled = true;
      let res, data;
      
      if (editingOldName) {
        // Update existing
        res = await fetch('/api/projects', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ oldName: editingOldName, newName: name, repos })
        });
      } else {
        // Add new
        res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ name, repos })
        });
      }
      
      data = await parseApiResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to save project');

      projects = Array.isArray(data.projects) ? data.projects : projects;
      resetForm();
      renderProjects();
      window.dispatchEvent(new CustomEvent('projects:updated', { detail: { projects } }));
    } catch (err) {
      alert(err.message || 'Failed to save project');
    } finally {
      addBtn.disabled = false;
    }
  }

  async function removeProject(nameRaw) {
    const name = String(nameRaw || '').trim();
    if (!name) return;

    const confirmDelete = confirm('Remove project "' + name + '"?');
    if (!confirmDelete) return;

    try {
      const res = await fetch('/api/projects', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await parseApiResponse(res);
      if (!res.ok || !data.ok) throw new Error(data.error || 'Failed to remove project');

      projects = Array.isArray(data.projects) ? data.projects : projects;
      renderProjects();
      window.dispatchEvent(new CustomEvent('projects:updated', { detail: { projects } }));
    } catch (err) {
      alert(err.message || 'Failed to remove project');
    }
  }

  openBtn.addEventListener('click', async () => {
    setModalOpen(true);
    await fetchProjects();
  });

  closeBtn.addEventListener('click', () => setModalOpen(false));

  modal.addEventListener('click', (e) => {
    if (e.target === modal) setModalOpen(false);
  });

  addBtn.addEventListener('click', saveProjectSubmit);
  
  if (cancelBtn) {
    cancelBtn.addEventListener('click', resetForm);
  }

  newInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
       e.preventDefault();
       saveProjectSubmit();
    }
  });

  if (reposInput) {
    reposInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
         e.preventDefault();
         saveProjectSubmit();
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      setModalOpen(false);
    }
  });

  if (!loading) fetchProjects();
})();
