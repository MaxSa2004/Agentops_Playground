import { createApp } from './app'
import { createMcpClientAdapter } from './mcp-client'

const port = Number(process.env.API_PORT ?? 3001)
const host = process.env.API_HOST ?? '127.0.0.1'

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be an integer from 1 to 65535.')
}

const mcp = createMcpClientAdapter()
try {
  await mcp.connect()
} catch (error) {
  process.stderr.write(`Unable to start the local MCP server: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

const api = createApp({ mcpAdapter: mcp })
const httpServer = api.listen(port, host, () => {
  console.log(`AgentOps local API listening at http://${host}:${port}`)
})

let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    httpServer.close(() => {
      void mcp.close().finally(() => process.exit(0))
    })
  })
}
