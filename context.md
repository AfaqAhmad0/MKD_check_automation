# Check-in Tracking Dashboard: Business Requirements & Architecture Document (BRD)

## 1. Executive Summary
The Check-in Tracking Dashboard is a specialized, centralized automation application designed to monitor developer activity within engineering teams. Its primary purpose is to asynchronously monitor WhatsApp team groups, extract daily "Check-In" and "Check-Out" messages, utilize Large Language Models (LLMs) to intelligently parse work logs into actionable components, and automatically cross-reference these work logs against actual code commits in a Gitea repository. The application provides project managers with an at-a-glance view of exactly who is working on what, what code was written, and whether developers have checked in for the day.

## 2. Core Functional Requirements

### 2.1 WhatsApp Data Ingestion
- **Automated Scanning**: The application must be able to securely connect to a WhatsApp account via standard QR-code authentication and pull historical message data from specifically defined Group Chats.
- **Regex Filtering**: The system must filter the raw message firehose down to only relevant messages containing keywords like `checkin`, `checkout`, `work summary`, `video summary`, etc.
- **On-Demand Extractions**: To respect container limits and privacy, extractions are ephemeral and on-demand. History is pulled when the user requests it and kept strictly in memory.

### 2.2 AI-Powered Parsing
- **LLM Integration**: The extracted checkout messages contain unstructured natural language (e.g., "I finished the CSS pipeline for Repo A and wrote some tests"). The system must send these messages to an LLM (supporting Google Gemini, Groq, or Cerebras) to strictly format them into a structured JSON array.
- **Model Fallbacks**: The system actively checks for valid API keys. If the preferred AI model's key is missing, it dynamically alerts the user and seamlessly falls back to alternatives.

### 2.3 Gitea Repository Cross-Referencing
- **Repository Mapping**: The dashboard maps string project names returned by the LLM to actual Git repository URLs.
- **Commit History Fetching**: The system leverages Gitea API tokens to pull branch and commit data for the past 48 hours for the matched projects.
- **Developer Name Aliasing**: Recognizing that a developer's WhatsApp name might differ from their Git username, the system uses a `repo_team.csv` aliasing system to match the commit author precisely.

### 2.4 User Interface & Interaction
- **Real-Time Display**: A clean, dynamic interface showing a table of all developers. Check-ins trigger a green indicator; missing check-ins remain grey empty states.
- **Manual Overrides**: Project Managers can click individual elements (e.g., Project names or "Checked In" flags) to manually adjust their statuses without needing to edit raw CSV files.
- **Stateless Configuration**: All API keys, tokens, and model configurations must be managed dynamically by the client via a floating Settings modal using local browser storage.

---

## 3. Technical Architecture & Tech Stack

### 3.1 Stack Breakdown
- **Backend Infrastructure**: Node.js, Express.js (REST API logic)
- **WhatsApp Bridge**: `@whiskeysockets/baileys` entirely replacing older Puppeteer/Chrome architectures with a lightweight native WebSocket connection.
- **Frontend Interface**: Pure Vanilla JavaScript, HTML5, CSS3 built on CSS Grid/Flexbox
- **Persistence Layer**: Local CSV file management (`employee_groups.csv`, `repo_projects.csv`, `repo_team.csv`, `checkout_projects.csv`) 

### 3.2 Stateless Cloud Environment Constraints
To allow pushing this application to GitHub safely and deploying it in a containerized cloud environment with minimal RAM (e.g., Koyeb/Render free tiers), the application was aggressively refactored.

#### Ephemeral API Key Management
- **`settings-modal.js`**: Serializes your AI Keys (Gemini, Groq, Cerebras) and Gitea tokens entirely into the browser's `localStorage` cache.
- **`checkout.js`**: Whenever the user clicks "Run AI Extraction", the script fetches the keys from `localStorage` and injects them dynamically into the request payload.
- **`index.js`**: Functions purely as a dumb pipe, using the keys sent in the payload for a single transaction, immediately dropping them afterwards. Keys are never saved to `.env`.

#### Session Persistence & Auth State
- `@whiskeysockets/baileys` uses `useMultiFileAuthState` to save WebSocket session credentials to a local `baileys_auth/` directory.
- This folder is added to `.gitignore` and `.dockerignore` to prevent leaking session tokens to version control.
- In production, it is highly recommended to mount a persistent volume to `baileys_auth/` so the container does not require a fresh QR scan upon every deployment reboot.

#### In-Memory Extraction Pipeline
- **Custom Memory Store**: Because native Baileys plugins consume too much RAM, the app uses a custom `memoryStore` Map. It retains exactly the 500 most recent messages exactly per tracked group.
- **Live WebSocket Feed**: Background `messages.upsert` listeners continuously append live messages to the cache. Real-time check-ins trigger live spreadsheet UI updates instantly without manual polling.
- **Edited Message Support**: The pipeline deeply inspects WhatsApp payloads, extracting text not just from standard messages, but from media captions and deeply nested `protocolMessage.editedMessage` structures to prevent users escaping tracking by editing posts.

---

## 4. Container Deployment & Docker Nuances

The removal of `whatsapp-web.js` means this application no longer requires a 300MB+ Chromium browser sandbox. It now strictly uses pure Node Websockets.

**Recommended Host:** Koyeb or Render.com Web Services using the bundled `Dockerfile`.

### 4.1 The Docker Pipeline Checks
Because we removed Puppeteer, the `Dockerfile` is now drastically simpler and faster to build:
1. **Base Image**: Uses `node:20-slim`, reducing structural weight.
2. **0.0.0.0 Port Binding**: Express routing `app.listen()` explicitly defines `0.0.0.0`. Defaulting to `localhost` triggers cloud hosts to assume the container is dead and kill the instance.
3. **No Root Ownership Hacks**: The application no longer requires tricky `pptruser` user changes.

---

## 5. File & Data Dictionaries

The application actively reads/writes from four core CSV files as its "Database" engine:

1. **`employee_groups.csv`**
   - **Fields**: `name`, `group`, `email`, `type`
   - **Purpose**: Defines the roster. If an employee is listed here, they will appear on the dashboard. The `type` field maps specific logic (e.g. tracking "dev" vs "designer").

2. **`repo_projects.csv`**
   - **Fields**: `project_name`, `link`
   - **Purpose**: Maps the human-readable project string the AI returns (e.g., "Portal Interface") to the exact URL of the Gitea repository.

3. **`repo_team.csv`**
   - **Fields**: `name`, `aliases`
   - **Purpose**: Cross-references the WhatsApp display name with the user's Gitea branch username. (Format: Aliases separated by semicolons -> `John Doe, jdoe;johnd`).

4. **`checkout_projects.csv`** & **`projects.csv`**
   - **Fields**: `developer`, `group`, `project status array`
   - **Purpose**: Actively mutated by the Node backend to reflect the current known state of AI parses or manual overrides. 

## 6. End-User Workflow
1. User boots the Dashboard URL.
2. If WhatsApp is unauthenticated, they will be given a popup QR Code overlay directly mirroring the backend container console.
3. User adds their LLM API keys directly into the UI's gear icon (`settings-modal.js`).
4. **Click "Compile Summaries & Run AI"**: Extractor fetches WhatsApp logs, AI parses them, maps to local CSV developers.
5. **Click "Check Repo Updates"**: Reads AI parsed Project blocks, crawls Gitea's APIs mapping timeframes, and overwrites the active interface with physical commit times.
