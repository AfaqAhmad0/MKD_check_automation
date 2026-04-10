/**
 * projects.js — Express routes for managing the project catalog.
 *
 * Endpoints:
 *   GET    /api/projects         — List all projects with their repo links
 *   POST   /api/projects         — Add a new project
 *   PATCH  /api/projects         — Rename a project (or update its repos)
 *   DELETE /api/projects         — Delete a project
 *   POST   /api/projects/rename  — Alias for PATCH (for proxy compatibility)
 *   POST   /api/projects/delete  — Alias for DELETE (for proxy compatibility)
 *
 * The repo_projects.csv maps human-readable project names (as returned
 * by the AI) to actual Git repository URLs for commit cross-referencing.
 */

const express = require("express");
const { readProjectsCatalog, writeProjectsCatalog } = require("../utils/csv");

const router = express.Router();

/**
 * GET /api/projects
 * Returns the full project catalog for the "Edit Projects" modal.
 */
router.get("/", (req, res) => {
  try {
    const projects = readProjectsCatalog();
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects
 * Add a new project. Body: { name: string, repos?: string[] }
 */
router.post("/", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Project name is required." });

    const existing = readProjectsCatalog();
    const exists = existing.some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (exists) return res.status(409).json({ ok: false, error: "Project already exists." });

    const repos = Array.isArray(req.body?.repos) ? req.body.repos : [];
    const projects = writeProjectsCatalog([...existing, { name, repos }]);
    res.json({ ok: true, projects });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * PATCH /api/projects
 * Rename a project or update its repos. Body: { oldName, newName, repos? }
 */
router.patch("/", (req, res) => {
  try {
    const { oldName: rawOld, newName: rawNew } = req.body || {};
    const oldName = String(rawOld || "").trim();
    const newName = String(rawNew || "").trim();

    if (!oldName || !newName) {
      return res.status(400).json({ ok: false, error: "Both oldName and newName are required." });
    }

    const projects = readProjectsCatalog();
    const targetIndex = projects.findIndex((p) => p.name.toLowerCase() === oldName.toLowerCase());
    if (targetIndex < 0) {
      return res.status(404).json({ ok: false, error: "Project to update was not found." });
    }

    const duplicate = projects.some(
      (p, idx) => idx !== targetIndex && p.name.toLowerCase() === newName.toLowerCase()
    );
    if (duplicate) {
      return res.status(409).json({ ok: false, error: "A project with that name already exists." });
    }

    projects[targetIndex].name = newName;
    if (req.body.repos !== undefined) {
      projects[targetIndex].repos = Array.isArray(req.body.repos) ? req.body.repos : [];
    }

    const updated = writeProjectsCatalog(projects);
    res.json({ ok: true, projects: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /api/projects
 * Remove a project by name. Body: { name: string }
 */
router.delete("/", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Project name is required." });

    const projects = readProjectsCatalog();
    const next = projects.filter((p) => p.name.toLowerCase() !== name.toLowerCase());

    if (next.length === projects.length) {
      return res.status(404).json({ ok: false, error: "Project not found." });
    }

    const updated = writeProjectsCatalog(next);
    res.json({ ok: true, projects: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Compatibility aliases ───────────────────────────────────────────────────
// Some cloud proxies or environments block PATCH/DELETE HTTP methods.
// These POST aliases provide the same functionality.

router.post("/rename", (req, res) => {
  try {
    const oldName = String(req.body?.oldName || "").trim();
    const newName = String(req.body?.newName || "").trim();

    if (!oldName || !newName) {
      return res.status(400).json({ ok: false, error: "Both oldName and newName are required." });
    }

    const projects = readProjectsCatalog();
    const targetIndex = projects.findIndex((p) => p.name.toLowerCase() === oldName.toLowerCase());
    if (targetIndex < 0) {
      return res.status(404).json({ ok: false, error: "Project to rename was not found." });
    }

    const duplicate = projects.some(
      (p, idx) => idx !== targetIndex && p.name.toLowerCase() === newName.toLowerCase()
    );
    if (duplicate) {
      return res.status(409).json({ ok: false, error: "A project with that name already exists." });
    }

    projects[targetIndex].name = newName;
    if (req.body.repos !== undefined) {
      projects[targetIndex].repos = Array.isArray(req.body.repos) ? req.body.repos : [];
    }
    const updated = writeProjectsCatalog(projects);
    res.json({ ok: true, projects: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post("/delete", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ ok: false, error: "Project name is required." });

    const projects = readProjectsCatalog();
    const next = projects.filter((p) => p.name.toLowerCase() !== name.toLowerCase());

    if (next.length === projects.length) {
      return res.status(404).json({ ok: false, error: "Project not found." });
    }

    const updated = writeProjectsCatalog(next);
    res.json({ ok: true, projects: updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
