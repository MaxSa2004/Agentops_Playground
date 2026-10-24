# AgentOps Playground

**Understand. Decide. Act. Safely.**

A small, observable customer-support triage playground built to show how generative AI, bounded typed decisions, MCP tools, deterministic policy, and human approval can work together.

## Current status: Phase 2

The React + TypeScript + Vite dashboard is a browser-only demonstration with a deterministic support triage workflow and a Jev-inspired **simulator**. The simulator is original project code: it does not call Jev, use a Jev SDK, produce confidence scores, or represent Jev's actual API. Ticket data and tool events are fictional and simulated. No live AI, API, MCP server, or customer data is connected yet.

## Run the frontend

Requirements: Node.js 20+ and npm 10+.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. To verify a production build:

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
  api/          reserved for the local Express backend (later phase)
  mcp-server/   reserved for the TypeScript MCP server (later phase)
packages/
  core/         shared typed-decision simulator, triage workflow, and tests
```

Vite is configured with the GitHub Pages repository base path `/Agentops_Playground/`.

## Planned work

Phase 3 adds the deterministic policy engine and backend-enforced approvals. Later phases add local Ollama inference, a genuine MCP client and server, expanded integration tests, GitHub Pages deployment automation, and setup documentation.

All components will remain usable with free local tooling; the public Pages demo will not depend on a hosted backend or paid inference.
