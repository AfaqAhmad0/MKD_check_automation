# Application Context Document

This document serves as a comprehensive overview of the `checkin-tracking` application's architecture, its purpose, and the recent structural changes made to support cloud deployments (like Render.com) without risking secret leaks or running into Docker file-permission issues.

## Primary Purpose
The application is a centralized web dashboard that connects to WhatsApp groups, extracts daily check-ins and check-outs from an engineering team, relies on LLMs (Groq, Gemini, or Cerebras) to parse these messages, and simultaneously queries local/Gitea repositories to measure code commits against the reported project updates.

## Tech Stack
- **Backend:** Node.js, Express
- **WhatsApp Integration:** `whatsapp-web.js` (uses Puppeteer / headless Chromium)
- **Frontend:** Vanilla JavaScript, HTML5, CSS3
- **AI Integration:** `@google/generative-ai` and standard REST endpoints for Groq/Cerebras
- **Storage:** Ephemeral in-memory structures and basic local CSV files (`repo_projects.csv`, `employee_groups.csv`).

---

## The Stateless Architecture Refactor

To allow pushing this application to GitHub safely and deploying it in a containerized cloud environment, the application was recently aggressively refactored to be **100% Stateless regarding API Keys and Session Logs**.

### 1. Zero-Disk API Key Management
Previously, the `Settings` modal on the dashboard queried the backend and forced it to execute filesystem writes to `.env`. This was fundamentally broken for cloud deployments, where the file system is reset, and exposes secrets in `logs` or `.env` files.  
**How it works now:**
- **`settings-modal.js`**: Re-written to serialize your AI Keys (Gemini, Groq, Cerebras) and Gitea tokens entirely into the browser's `localStorage` cache.
- **`checkout.js`**: Whenever the user clicks "Run AI Extraction" or "Check Repo Updates," the script fetches the keys from `localStorage` and injects them dynamically into the request payload (`req.body.apiKeys`, `req.body.giteaKey`).
- **`index.js`**: Stripped of the `POST /api/keys` filesystem actions completely. The server functions purely as a dumb pipe, using the keys sent in the payload for a single operation, immediately dropping them afterwards.
  *Note: To allow server administrators seamless function without forcing users to type keys in their UI, `process.env` fallback variables are silently checked via `GET /api/ai-key-status` if the UI doesn't have a configured local key.*

### 2. Ephemeral WhatsApp Execution
- Because Node.js containers cannot persist data between restarts gracefully (unless an explicit volume mount is configured), `whatsapp-web.js` was downgraded from `LocalAuth` to `NoAuth`.
- This ensures the application never generates a `session/` folder on disk. Instead, the application will provide a fresh QR code snippet for the container logs or dashboard.

### 3. In-Memory Extraction Model
- Background 24/7 logging (`.on('message')`) that continuously appended to `logs/matches.json` was purged form the infrastructure.
- The pipeline now fires **On-Demand**. When `/api/process-checkouts` is pinged by the frontend, the server rapidly scans recent live message history and returns an object array directly into system memory, piping it straight to the LLMs instead of touching a local HDD.

---

## Docker & Server Deployment Constraints

You **cannot** deploy this repository to serverless platforms mapping endpoints to AWS Lambda functions (such as Netlify/Vercel). 
`whatsapp-web.js` fundamentally spawns a background executable (`Chromium/Puppeteer`) which stays alive indefinitely holding WebSocket connections. 

**Recommended Host:** Render.com Web Services (or Railway/Fly.io) using the `Dockerfile`.

### The Docker Pipeline
A lot of engineering went into the `Dockerfile` to adapt the official Puppeteer Linux image for Render constraints:
1. **User Ownership (`--chown=pptruser:pptruser`)**: We execute `COPY` directly to the non-root `pptruser` user. If docker builds them as `root`, `npm install` throws fatal `EACCES` file-permission blocks. 
2. **Explicit Puppeteer Install**: The latest iterations of Puppeteer containers set `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` globally. We explicitly pass `RUN npx puppeteer browsers install chrome` during the build layer to ensure the Chromium cache drops physically into `~/.cache/puppeteer` without environment variable routing errors.
3. **Array Fallback**: Over-engineered path fallback routing exists in `index.js`. If the docker variables disappear (frequent on unoptimized cloud instances), it natively scans `/opt/google/...` and `/usr/bin/` to rescue the `executablePath` before completely throwing `[FATAL STARTUP]`.
4. **0.0.0.0 Port Binding**: Express routing `app.listen()` explicitly defines `0.0.0.0`. Defaulting to standard `localhost` binds caused Render to assume the container was dead ("No open ports detected").
