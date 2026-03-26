# Check-In & Checkout Tracking Dashboard

A real-time WhatsApp monitoring system that tracks employee check-ins, processes checkout summaries with AI, and verifies repository update statuses via Gitea API — all from a single web dashboard.

## Features

- **WhatsApp Integration** — Monitors group chats for check-in/checkout messages using `whatsapp-web.js`
- **AI-Powered Extraction** — Uses LLM providers (Groq, Gemini, Cerebras) to extract project names from unstructured developer summaries  
- **Repository Monitoring** — Cross-references developer commits against Gitea to verify repo update claims
- **Live Dashboard** — Real-time web UI with SSE-based status updates, project catalog management, and employee group editing
- **In-App API Key Management** — Configure all API keys from the ⚙ Settings panel in the navbar (persisted to `.env`)

## Quick Start

### Prerequisites

- **Node.js ≥ 20** (22+ recommended)
- A WhatsApp account to link via QR code
- At least one AI provider API key (Groq recommended for speed)

### Installation

```bash
git clone <your-repo-url>
cd checkin_tracking
npm install
```

### Configuration

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Add your API keys to `.env`:
   ```env
   GROQ_API_KEY=gsk_your_key_here
   GITEA_API_KEY=your_gitea_token
   ```
   
   > **Tip:** You can also configure API keys from the web UI via the ⚙ Settings button in the navbar.

3. Set up your data files:
   - `repo_projects.csv` — Project-to-repository mappings (CSV: `project_name,repo_link`)
   - `repo_team.csv` — Developer-to-alias mappings for commit filtering (CSV: `name,aliases`)
   - `employee_groups.csv` — Employee-to-WhatsApp group mappings (auto-editable from UI)

### Running

```bash
npm start
```

Open **http://localhost:3000** in your browser. On first run, scan the WhatsApp QR code to authenticate.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Web Dashboard                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Check-In │  │   Checkout   │  │   Settings    │  │
│  │  Tracker  │  │   Summaries  │  │  (API Keys)   │  │
│  └──────────┘  └──────────────┘  └───────────────┘  │
└─────────────────────┬───────────────────────────────┘
                      │ Express.js API
┌─────────────────────┴───────────────────────────────┐
│                  Node.js Backend                     │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ WhatsApp │  │  AI Engine   │  │  Gitea API    │  │
│  │ Listener │  │ (LLM Proxy)  │  │  (Repo Check) │  │
│  └──────────┘  └──────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────┘
```

## Data Files

| File | Purpose | Committed? |
|------|---------|------------|
| `repo_projects.csv` | Project ↔ repo URL mappings | ✅ Yes |
| `repo_team.csv` | Developer ↔ Gitea alias mappings | ✅ Yes |
| `config.json` | WhatsApp message matching rules | ✅ Yes |
| `.env` | API keys (secrets) | ❌ Gitignored |
| `employee_groups.csv` | Employee roster (generated via UI) | ❌ Gitignored |
| `checkout_projects.csv` | AI extraction results (runtime) | ❌ Gitignored |
| `session/` | WhatsApp auth session | ❌ Gitignored |
| `logs/` | Message match logs | ❌ Gitignored |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Bot connection status |
| `GET` | `/api/keys` | List all API keys (masked) |
| `POST` | `/api/keys` | Set/update API keys |
| `GET` | `/api/projects` | List projects with repo links |
| `POST` | `/api/projects` | Add a project |
| `PATCH` | `/api/projects` | Update project name/repos |
| `DELETE` | `/api/projects` | Remove a project |
| `POST` | `/api/process-checkouts` | Run AI extraction pipeline |
| `POST` | `/api/check-repo-updates` | Check Gitea for recent commits |
| `GET` | `/api/events` | SSE stream for live updates |

## Supported AI Providers

| Provider | Model | Speed |
|----------|-------|-------|
| **Groq** | `llama-3.3-70b-versatile` | ⚡ Fastest |
| **Google** | `gemini-2.5-flash` | 🔄 Reliable |
| **Cerebras** | `llama3.1-8b` | 🧪 Experimental |

## License

Private — Internal use only.
