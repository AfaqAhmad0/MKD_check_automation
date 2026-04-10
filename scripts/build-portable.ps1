# Creates dist/checkin-tracking-portable/ with app sources + npm install (production).
# Requires Node.js on the machine that runs the app (double-click Start Check-In Tracker.bat).

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root "dist\checkin-tracking-portable"

if (Test-Path $dest) {
  Remove-Item $dest -Recurse -Force
}
New-Item -ItemType Directory -Path $dest -Force | Out-Null

$files = @(
  "index.js", "matcher.js", "logger.js",
  "package.json", "package-lock.json",
  "config.json", "repo_projects.csv", "repo_team.csv", ".env.example"
)
foreach ($f in $files) {
  $src = Join-Path $root $f
  if (Test-Path $src) {
    Copy-Item $src $dest
  }
}

Copy-Item (Join-Path $root "public") (Join-Path $dest "public") -Recurse

Push-Location $dest
try {
  npm ci --omit=dev
} finally {
  Pop-Location
}

$bat = @"
@echo off
cd /d "%~dp0"
echo Check-In Tracker — opening browser...
start http://localhost:3000
node index.js
pause
"@
$batPath = Join-Path $dest "Start Check-In Tracker.bat"
Set-Content -Path $batPath -Value $bat -Encoding ASCII

Write-Host "Portable build ready: $dest"
Write-Host "Run: Start Check-In Tracker.bat (Node.js must be installed)."
