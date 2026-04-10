# Building a local Windows distribution

The UI is unchanged. Two ways to ship the app:

## 1. Single executable (recommended)

Requires a one-time dev install (`npm install`). Produces a self-contained `.exe` (no Node.js on the target PC).

```bash
npm run build:win
```

This runs **esbuild** (bundles the app and dependencies into one CommonJS file so `pkg` is compatible with Baileys’ ESM), stages `public/` and config/CSV into `dist/`, then runs **`@yao-pkg/pkg`** with **Node 20** (Baileys 6.x expects Node ≥ 20; the older `pkg` only shipped Node 18 and could trigger crypto errors such as **`Zero-length key is not supported`** during WhatsApp pairing). Output: **`dist/checkin-tracking.exe`**.

The build **also** leaves **`dist/public/`** on disk (same folder as the exe). **Ship or run the app with that folder present** — the UI is loaded from `public/` next to the executable (the pkg snapshot path alone is unreliable on Windows). You can delete **`dist/bundle.cjs`** after a successful build; **keep** `checkin-tracking.exe` **and** the **`public`** folder together.

**First run on any PC**

1. Copy **`checkin-tracking.exe` and the `public` folder** (same directory) to a folder the user can write to (e.g. Desktop or `Documents`).
2. Optionally copy `.env` next to the exe (rename from `.env.example` and fill keys), or use only browser Settings for API keys.
3. Double-click the exe. The console shows the URL; open `http://localhost:3000`.

**Data next to the exe**

All writable files are created **in the same folder as the executable**:

- `.env` (optional)
- `baileys_auth/` (WhatsApp session)
- `baileys_store.json`
- `repo_projects.csv`, `repo_team.csv` (seeded from the build on first run if missing)
- `employee_groups.csv`, `checkout_projects.csv` (created when you use the app)

To customize projects/team defaults, edit the CSV files next to the exe, or drop in your own copies before first run.

## 2. Portable folder (needs Node.js on the PC)

Use this if `pkg` fails or you prefer a normal `node` run:

```powershell
npm run build:portable
```

Output: `dist/checkin-tracking-portable/`

The user must have **Node.js 18+** installed, then run `Start Check-In Tracker.bat`.

## Troubleshooting

- **Build downloads Node binaries** the first time (`pkg`); allow network access.
- **`SyntaxError: Cannot use import statement outside a module`** — fixed by the esbuild bundle; rebuild with `npm run build:win` (do not run `pkg` on `index.js` alone).
- **`crypto.subtle` / Baileys crypto errors in the exe** — the app polyfills `globalThis.crypto` from Node’s `webcrypto`. The packaged exe must use **Node 20** (`@yao-pkg/pkg` + `node20-win-x64`); do not switch back to unmaintained `pkg` + Node 18 for this project.
- **`[UNHANDLED_REJECTION] Zero-length key is not supported`** — usually fixed by rebuilding with Node 20 as above. If it persists, delete the **`baileys_auth`** folder next to the exe (and `baileys_store.json` if present), then run again and scan the QR code fresh.
- **Dynamic require warnings** from `pkg` during build are often harmless if the app starts.
- **`Cannot GET /` in the browser** — keep **`public/` in the same folder as `checkin-tracking.exe`** (the build runs `prepare-pkg-assets` twice so `dist/public/` exists after packaging). If you moved only the exe, copy the whole **`dist`** directory or at least **`public`** next to the exe. Rebuild with `npm run build:win` if needed.
- **`EPERM: operation not permitted, unlink ... checkin-tracking.exe`** — Windows locks the file while the app is running (or sometimes while Explorer has it selected). Close **`checkin-tracking.exe`**, end it in Task Manager if needed, then run **`npm run build:win` again** (the build tries to stop a running instance automatically on Windows). If it still fails, pause antivirus for the `dist` folder or reboot.
