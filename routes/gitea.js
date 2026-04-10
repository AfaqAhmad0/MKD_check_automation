/**
 * gitea.js — Express routes for Gitea repository commit checking.
 *
 * Endpoints:
 *   GET  /api/repo-projects     — List all projects with their repo links
 *   POST /api/check-repo-updates — Cross-reference developer work with actual Git commits
 *
 * This module fetches commit history from the Gitea instance and matches
 * commits to developers using the alias system from repo_team.csv.
 * GitHub-hosted repos are flagged but skipped (Gitea API only).
 */

const express = require("express");
const { readRepoProjectsCsv, readTeamCsv } = require("../utils/csv");

const router = express.Router();

/** Base URL for the self-hosted Gitea instance. */
const GITEA_BASE = "https://gitea.personalsoftware.space";

// ─── Gitea API Helpers ───────────────────────────────────────────────────────

/**
 * Fetch data from the Gitea REST API with timeout protection.
 *
 * @param {string} endpoint - API endpoint path (e.g., /api/v1/repos/owner/repo/branches)
 * @param {string} apiKey - Gitea API token for authentication
 * @returns {Promise<object|null>} Parsed JSON response, or null on error
 */
async function giteaApiFetch(endpoint, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `token ${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const res = await fetch(`${GITEA_BASE}${endpoint}`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch all branches for a repository.
 * @returns {Promise<Array>} List of branch objects
 */
async function fetchGiteaBranches(owner, repo, apiKey) {
  const data = await giteaApiFetch(`/api/v1/repos/${owner}/${repo}/branches?limit=100`, apiKey);
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch commits since a given ISO date, optionally filtered by branch.
 * @returns {Promise<Array>} List of commit objects
 */
async function fetchGiteaCommits(owner, repo, since, branch, apiKey) {
  let endpoint = `/api/v1/repos/${owner}/${repo}/commits?limit=100&since=${encodeURIComponent(since)}`;
  if (branch) endpoint += `&sha=${encodeURIComponent(branch)}`;
  const data = await giteaApiFetch(endpoint, apiKey);
  return Array.isArray(data) ? data : [];
}

/**
 * Fetch commits from ALL branches since a given date, deduplicating by SHA.
 * This ensures we don't miss commits on feature branches.
 *
 * @returns {Promise<Array>} Deduplicated list of commit objects
 */
async function fetchAllBranchCommits(owner, repo, since, apiKey) {
  const branches = await fetchGiteaBranches(owner, repo, apiKey);
  const allCommits = [];
  const seen = new Set();

  for (const br of branches) {
    const branchName = br.name;
    if (!branchName) continue;
    const commits = await fetchGiteaCommits(owner, repo, since, branchName, apiKey);
    for (const c of commits) {
      const sha = c.sha || "";
      if (sha && seen.has(sha)) continue;
      if (sha) seen.add(sha);
      allCommits.push(c);
    }
  }

  return allCommits;
}

/**
 * Extract the committer's identifier from a Gitea commit object.
 * Tries API login first, then falls back to commit author name.
 */
function extractCommitPerson(c) {
  return c?.author?.login || c?.committer?.login || c?.commit?.author?.name || "unknown";
}

/** Extract the commit date from a Gitea commit object. */
function extractCommitDate(c) {
  return c?.commit?.author?.date || c?.commit?.committer?.date || "";
}

/**
 * Format an ISO date string as a human-readable "X ago" label.
 * @param {string} isoStr - ISO date string
 * @returns {string} Human-readable time ago
 */
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

/**
 * Find the latest commit across all branches of a repo.
 * Used as a fallback when no commits are found in the lookback window.
 */
async function fetchLatestAnyBranch(owner, repo, apiKey) {
  const branches = await fetchGiteaBranches(owner, repo, apiKey);
  let best = null;

  for (const br of branches) {
    const commit = br.commit;
    if (!commit) continue;
    const date = commit.author?.date || commit.committer?.date || commit.timestamp || "";
    if (!date) continue;

    if (!best || date > best.date) {
      best = {
        date,
        committer: commit.author?.name || commit.committer?.name || "",
        message: (commit.message || "").split("\n")[0].trim(),
      };
    }
  }

  return best;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /api/repo-projects
 * Returns all projects with their repo links and Gitea/GitHub status.
 */
router.get("/repo-projects", (req, res) => {
  try {
    const map = readRepoProjectsCsv();
    const projects = {};
    for (const [name, repos] of map) {
      projects[name] = repos.map((r) => ({ link: r.link, isGitea: r.isGitea }));
    }
    res.json({ ok: true, projects });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/check-repo-updates
 * Cross-reference developer work logs with actual Git commits.
 *
 * Body: {
 *   hours: number,          — Lookback window in hours (default 48)
 *   devs: [{ name, projects: [string] }],  — Developers and their claimed projects
 *   giteaKey: string        — Gitea API token for authentication
 * }
 *
 * Returns per-developer commit status for each project.
 */
router.post("/check-repo-updates", async (req, res) => {
  try {
    const lookbackHours = req.body.hours || 48;
    const devsInput = req.body.devs || [];

    if (!Array.isArray(devsInput) || devsInput.length === 0) {
      return res.status(400).json({ ok: false, error: "No developers provided." });
    }

    const repoMap = readRepoProjectsCsv();
    const teamDb = readTeamCsv();
    const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const since = cutoff.toISOString();
    const apiKey = typeof req.body.giteaKey === "string" ? req.body.giteaKey.trim() : "";

    // Collect unique project names across all devs
    const allProjectNames = new Set();
    for (const d of devsInput) {
      for (const p of d.projects || []) {
        if (p) allProjectNames.add(p.trim());
      }
    }

    const uniqueProjects = [...allProjectNames];
    const repoMapKeys = [...repoMap.keys()];

    // ── Phase 1: Fetch commits for each unique project ──────────────
    const projectRepoResults = new Map();

    for (const projectName of uniqueProjects) {
      // Try exact match first, then fuzzy match
      let matchedKey = repoMapKeys.find((k) => k.toLowerCase() === projectName.toLowerCase());
      if (!matchedKey) {
        const stripped = projectName.replace(/\(.*?\)/g, "").trim().toLowerCase();
        matchedKey = repoMapKeys.find(
          (k) => k.toLowerCase().includes(stripped) || stripped.includes(k.toLowerCase())
        );
      }

      const repos = matchedKey ? repoMap.get(matchedKey) : [];
      const repoResults = [];

      if (!repos || repos.length === 0) {
        repoResults.push({ skippedReason: "no_link" });
      } else {
        for (const ri of repos) {
          if (!ri.isGitea) {
            repoResults.push({ skippedReason: "not_gitea", repoLink: ri.link });
            continue;
          }
          if (!ri.owner || !ri.repo) {
            repoResults.push({ skippedReason: "bad_url", repoLink: ri.link });
            continue;
          }

          console.log(`[REPO_CHECK] Checking ${ri.owner}/${ri.repo}...`);
          const commits = await fetchAllBranchCommits(ri.owner, ri.repo, since, apiKey);

          if (commits.length === 0) {
            // No recent commits — fetch the latest commit as a reference
            const latest = await fetchLatestAnyBranch(ri.owner, ri.repo, apiKey);
            repoResults.push({
              skippedReason: "",
              committer: latest ? latest.committer : "",
              lastUpdateRaw: latest ? latest.date : "",
            });
          } else {
            for (const c of commits) {
              repoResults.push({
                skippedReason: "",
                committer: extractCommitPerson(c),
                lastUpdateRaw: extractCommitDate(c),
              });
            }
          }
        }
      }

      projectRepoResults.set(projectName, repoResults);
    }

    // ── Phase 2: Match developers using aliases ─────────────────────
    const devStatuses = [];
    const textSummaryLines = [];

    for (const dInput of devsInput) {
      const devName = dInput.name;
      const projectNames = dInput.projects || [];
      const teamDev = teamDb.find((t) => t.name.toLowerCase() === devName.toLowerCase());
      const aliases = teamDev ? teamDev.aliases : [devName.toLowerCase()];

      let hasAny48h = false;
      const projectStatuses = [];
      const devSummaryParts = [];

      for (const pn of projectNames) {
        const pRows = projectRepoResults.get(pn) || [];

        // Find commits by this developer using alias matching
        const matchingRows = pRows.filter(
          (r) => !r.skippedReason && r.committer && aliases.includes(r.committer.toLowerCase())
        );

        if (matchingRows.length === 0) {
          // No commits from this dev on this project
          const githubSkippedRows = pRows.filter((r) => r.skippedReason === "not_gitea");
          const isGh = githubSkippedRows.length > 0;
          const githubLinks = isGh
            ? [...new Set(githubSkippedRows.map((r) => r.repoLink).filter(Boolean))]
            : [];

          const label = isGh ? "GITHUB SKIPPED" : "NO";
          const dispLabel = isGh ? "GITHUB SKIPPED" : "no commit found";

          projectStatuses.push({
            project: pn,
            updateTime: dispLabel,
            updated48h: false,
            isGithubSkipped: isGh,
            githubLinks,
          });
          devSummaryParts.push(`${pn} (${label})`);
        } else {
          // Developer has commits — find the most recent one
          const bestRaw = matchingRows.map((r) => r.lastUpdateRaw).filter(Boolean).sort().pop();
          const bestTime = bestRaw ? formatAgo(bestRaw) : "no commit found";
          const isMatchedTime = bestRaw && bestRaw >= since;

          if (isMatchedTime) hasAny48h = true;

          projectStatuses.push({
            project: pn,
            updateTime: bestTime,
            updated48h: isMatchedTime,
            isGithubSkipped: false,
            githubLinks: [],
          });

          if (!isMatchedTime) {
            const timeLabel = bestTime === "no commit found" ? "NO" : bestTime;
            devSummaryParts.push(`${pn} (${timeLabel})`);
          }
        }
      }

      devStatuses.push({
        name: devName,
        hasUpdated: hasAny48h,
        projectStatuses,
      });

      if (devSummaryParts.length > 0) {
        textSummaryLines.push(`${devName} -> ${devSummaryParts.join(", ")}`);
      }
    }

    res.json({
      ok: true,
      devStatuses,
      textSummary: textSummaryLines.join("\n"),
    });
  } catch (err) {
    console.error("[REPO_CHECK_ERROR]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
