# AgentOps Playground

**Understand. Decide. Act. Safely.**

A small, observable customer-support triage playground built to show how generative AI, bounded typed decisions, MCP tools, deterministic policy, and human approval can work together.

## Current status: Phase 4

The dashboard has a deterministic support workflow, a Jev-inspired **simulator**, a local Express policy API, and real local Ollama inference. The simulator is original project code: it does not call Jev, use a Jev SDK, produce confidence scores, or represent Jev's actual API. Ticket data is fictional and held in memory. A live MCP server is not connected yet.

## Run the frontend

Requirements: Node.js 20+ and npm 10+.

Install dependencies once, then start the API first in one terminal:

```bash
npm install
npm run dev:api
```

In a second terminal, start the web app:

```bash
npm run dev
```

The API listens on `127.0.0.1:3001`; Vite proxies `/api` requests to it. The dashboard checks for the API and Ollama at startup and switches from browser demo to local AI mode. Start Ollama and the API before opening or refreshing the app. To demonstrate all policy outcomes, choose **Read existing ticket · ALLOW**, **Change ticket priority · REQUIRE APPROVAL**, or **Delete ticket · BLOCK**, then run the workflow. Approval-required operations still wait for the explicit approval interface before execution. The public static demo has no backend or model and does not enforce permissions.

## Local Ollama model

The API uses the free local Ollama service at `http://127.0.0.1:11434` and defaults to `qwen2.5:1.5b`. No API key or cloud inference is used. Check the installation and model with:

```bash
ollama --version
ollama list
```

If the Ollama service is stopped, start it with `ollama serve` in another terminal (or launch the Ollama application). If `qwen2.5:1.5b` is missing, download it once with `ollama pull qwen2.5:1.5b`. Neither operation upgrades Ollama.

The backend sends a non-streaming `POST /api/chat` request with JSON-schema output. Configure optional overrides in the terminal that starts the API: `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, and `OLLAMA_TIMEOUT_MS` (default 90 seconds). `.env.example` lists the same defaults; the project does not load `.env` files automatically.

For each workflow, Ollama receives the user request, the fictional ticket fields supplied by the workflow, the current priority, and the existing simulated department, urgency, and severity decisions. It returns a summary, recommendation, explanation, and optional clarification question. Ollama output cannot choose or authorize actions. The backend evaluates the separately submitted action under the deterministic policy after inference; if Ollama fails, the workflow stops before policy evaluation or execution.

To verify a production build:

```bash
npm run build
npm run preview
```

Run the deterministic core tests with:

```bash
npm test
```

## Monorepo layout

```text
apps/
  web/          React, TypeScript, Vite dashboard
  api/          local Express policy API and approval lifecycle
  mcp-server/   reserved for the TypeScript MCP server (later phase)
packages/
  core/         shared typed-decision simulator, policy engine, triage workflow, and tests
```

Vite is configured with the GitHub Pages repository base path `/Agentops_Playground/`.

## Planned work

The policy API exposes `POST /api/workflows`, `GET /api/workflows/:id`, `POST /api/policy/evaluate`, `POST /api/approvals`, `POST /api/approvals/:id/decision`, `GET /api/approvals/:id`, `POST /api/actions/execute`, and `GET /api/events`. Each workflow has an ID and an isolated ordered event list; the dashboard shows the latest run, while a run can be retrieved by ID for inspection. Approval records bind an immutable server-side action snapshot; execution rechecks the current policy and approval status. The in-memory API has no authentication and is intended only for local demonstration.

Phase 5 adds the genuine MCP client and server. Later work expands integration tests, GitHub Pages deployment automation, and setup documentation.

All components will remain usable with free local tooling; the public Pages demo will not depend on a hosted backend or paid inference.
