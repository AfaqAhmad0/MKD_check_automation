/**
 * pkg resolves static/config paths against dist/ (next to bundle.cjs).
 * Copy everything the bundled app reads via __dirname into dist/ before pkg.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const srcPublic = path.join(root, "public");

fs.mkdirSync(dist, { recursive: true });
fs.cpSync(srcPublic, path.join(dist, "public"), { recursive: true });

for (const name of ["config.json", "repo_projects.csv", "repo_team.csv"]) {
  const from = path.join(root, name);
  const to = path.join(dist, name);
  if (fs.existsSync(from)) {
    fs.copyFileSync(from, to);
  }
}
console.log("[prepare-pkg-assets] Staged dist/public, config.json, repo_*.csv for pkg.");
