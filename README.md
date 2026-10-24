# AgentOps Playground

**Understand. Decide. Act. Safely.**

A small, observable customer-support triage playground built to show how generative AI, bounded typed decisions, MCP tools, deterministic policy, and human approval can work together.

## Phase 1 status

The React + TypeScript + Vite dashboard is currently a browser-only demonstration. It uses fictional data and deterministic interactions. No live AI, API, MCP server, Jev service, or customer data is connected yet.

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

## Monorepo layout

```text
apps/
  web/          React, TypeScript, Vite dashboard
  api/          reserved for the local Express backend (later phase)
  mcp-server/   reserved for the TypeScript MCP server (later phase)
packages/
  core/         shared workflow contracts
```

Vite is configured with the GitHub Pages repository base path `/Agentops_Playground/`.

## Planned work

The next phase adds the deterministic workflow and the explicitly simulated, Jev-inspired typed-decision engine. Later phases add policy and approvals, local Ollama inference, a genuine MCP client and server, tests, deployment automation, and fuller setup documentation.

All components will remain usable with free local tooling; the public Pages demo will not depend on a hosted backend or paid inference.
