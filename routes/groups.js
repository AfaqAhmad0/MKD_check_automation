/**
 * groups.js — Express routes for managing the employee groups roster.
 *
 * Endpoints:
 *   GET  /api/groups       — List all employee-group rows from CSV
 *   POST /api/groups/save  — Overwrite the employee groups CSV with new data
 *
 * The employee_groups.csv file is the roster of developers/QA/testers
 * that the dashboard monitors. Each row maps a person to their WhatsApp
 * group chat name and their role type (dev, qa, tester, trainee, va).
 */

const express = require("express");
const {
  readEmployeeGroupsCatalog,
  writeEmployeeGroupsCatalog,
} = require("../utils/csv");

const router = express.Router();

/**
 * GET /api/groups
 * Returns the full employee roster for the "Edit Group Chats" modal.
 */
router.get("/", (req, res) => {
  try {
    const rows = readEmployeeGroupsCatalog();
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/groups/save
 * Accepts { rows: [...] } and overwrites employee_groups.csv.
 * Used by the "Edit Group Chats" modal save button.
 *
 * Note: This resets all checkin statuses to 0 because it's a roster
 * management operation, not a runtime state update.
 */
router.post("/save", (req, res) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) {
      return res.status(400).json({ ok: false, error: "rows must be an array." });
    }

    const savedRows = writeEmployeeGroupsCatalog(rows);

    // Signal the main app to reload CSV and refresh UI
    if (typeof req.app.locals.onGroupsSaved === "function") {
      req.app.locals.onGroupsSaved();
    }

    res.json({ ok: true, rows: savedRows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
