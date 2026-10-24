# AgentOps Playground

**Understand. Decide. Act. Safely.**

A small, observable customer-support triage playground built to show how generative AI, bounded typed decisions, MCP tools, deterministic policy, and human approval can work together.

## Current status: Phase 5

The dashboard has a local Express policy API, real local Ollama inference, an official MCP TypeScript SDK client/server over stdio, and a Jev-inspired **simulator**. The simulator is original project code: it does not call Jev, use a Jev SDK, produce confidence scores, or represent Jev's actual API. MCP uses fictional demonstration tickets and support documentation.

## Run the frontend

Requirements: Node.js 20+ and npm 10+.

Install dependencies once:

```bash
npm install
```

If Ollama is not already running, start it in a terminal:

```bash
ollama serve
```

In another terminal start the API:

```bash
npm run dev:api
```

In a third terminal start the web app:

```bash
npm run dev
```

The API listens on `127.0.0.1:3001`; Vite proxies `/api` requests to it. The API starts one persistent MCP server child process over stdio and keeps a genuine MCP client connection for its lifetime. The dashboard checks the API, MCP server, and Ollama at startup and switches from browser demo to local mode. To demonstrate all policy outcomes, choose **Read existing ticket · ALLOW**, **Change ticket priority · REQUIRE APPROVAL**, or **Delete ticket · BLOCK**, then run the workflow. Approval-required operations wait for explicit approval before `update_ticket_priority` is invoked. The public static demo has no backend, MCP server, or model and does not enforce permissions. Stop the local API with Ctrl+C; it closes the MCP client and child process.

## Local Ollama model

The API uses the free local Ollama service at `http://127.0.0.1:11434` and defaults to `qwen2.5:1.5b`. No API key or cloud inference is used. Check the installation and model with:

```bash
ollama --version
ollama list
```

If the Ollama service is stopped, start it with `ollama serve` in another terminal (or launch the Ollama application). If `qwen2.5:1.5b` is missing, download it once with `ollama pull qwen2.5:1.5b`. Neither operation upgrades Ollama.

The backend sends a non-streaming `POST /api/chat` request with JSON-schema output. Configure optional overrides in the terminal that starts the API: `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, and `OLLAMA_TIMEOUT_MS` (default 90 seconds). `.env.example` lists the same defaults; the project does not load `.env` files automatically.

For each local workflow, deterministic code generates department, urgency, and severity outputs. Ollama then selects one read-only tool from the MCP definitions discovered over the protocol. The API validates its name and arguments against the discovery and the workflow ticket ID, then performs the call over MCP. The actual returned ticket or knowledge-base data and simulated decisions go to Ollama for a summary, recommendation, explanation, and optional clarification question. If discovery, tool selection, MCP retrieval, or model inference fails, the workflow stops; it never substitutes browser fixtures for a failed live call. Ollama cannot call write tools, choose permissions, or authorize actions. The Express policy engine evaluates the separate proposed action, and only its ALLOW or human-approved path can invoke an action tool.

The MCP process owns the authoritative in-memory tickets and knowledge-base data for a local session. Priority changes remain visible to later workflows until the MCP process restarts; data resets when it restarts. The API owns workflow IDs, event histories, and pending approval records. No real customer data is used.

The integration uses official [`@modelcontextprotocol/client` and `@modelcontextprotocol/server` TypeScript SDK v2.4.0](https://github.com/modelcontextprotocol/typescript-sdk), with the documented `Client`, `McpServer`, `StdioClientTransport`, and `StdioServerTransport` interfaces. MCP protocol messages use stdio; server diagnostics go to stderr. The API closes the MCP client and child process on SIGINT/SIGTERM. `.env.example` documents `MCP_TOOL_TIMEOUT_MS` (8 seconds by default).

The server can also be configured as a stdio server in a compatible coding agent. From the repository root, use `node` with arguments `--import`, `tsx`, and the absolute path to `apps/mcp-server/src/server.ts`. Keep stdout reserved for MCP protocol messages.

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
  mcp-server/   authoritative fictional ticket/knowledge data and MCP tools
packages/
  core/         shared typed-decision simulator, policy engine, triage workflow, and tests
```

Vite is configured with the GitHub Pages repository base path `/Agentops_Playground/`.

## Workflow API and checks

The policy API exposes `POST /api/workflows`, `GET /api/workflows/:id`, `POST /api/policy/evaluate`, `POST /api/approvals`, `POST /api/approvals/:id/decision`, `GET /api/approvals/:id`, `POST /api/actions/execute`, and `GET /api/events`. Each workflow has an ID and an isolated ordered event list; the dashboard shows the latest run, while a run can be retrieved by ID for inspection. Approval records bind an immutable server-side action snapshot; execution rechecks the current policy and approval status. The in-memory API has no authentication and is intended only for local demonstration.

The deterministic test suite includes a genuine stdio MCP integration test that starts the real server process, discovers and calls tools, reads and updates fictional data, and verifies that a restarted process resets in-memory data. Run only that check with `npm test -- apps/api/src/mcp.integration.test.ts`; run all tests with `npm test`; build the MCP server, API, and Pages frontend with `npm run build`.

The MCP server exposes `list_tickets`, `get_ticket`, `search_knowledge_base`, `propose_ticket_action`, and `update_ticket_priority`. The write tool is available over MCP, so the local API is the trusted application boundary: it invokes the write only after deterministic policy evaluation and required approval. Do not expose the unauthenticated local API to an untrusted network. In-memory records, no authentication, and a local stdio process are prototype limitations.

All components will remain usable with free local tooling; the public Pages demo will not depend on a hosted backend or paid inference.
