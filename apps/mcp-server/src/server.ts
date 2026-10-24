import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'
import { DEMO_TICKETS } from '@agentops/core'

type Ticket = (typeof DEMO_TICKETS)[number] & { priority: 'low' | 'normal' | 'high' | 'urgent' }

// This process owns the one authoritative session dataset. It intentionally
// survives individual tool calls and resets when this MCP process restarts.
const tickets = new Map<string, Ticket>(DEMO_TICKETS.map((ticket) => [ticket.id, { ...ticket, priority: 'normal' }]))
const knowledgeBase = [
  { id: 'kb-refund', title: 'Late delivery refunds', text: 'Review verified order history and explain only the refund options confirmed for that order.' },
  { id: 'kb-account', title: 'Account recovery', text: 'Use verified account recovery steps. Never request or record a password.' },
  { id: 'kb-damage', title: 'Damaged items', text: 'Record the reported damage and route replacement questions to the shipping team.' },
] as const

const server = new McpServer({ name: 'agentops-support-demo', version: '1.0.0' })

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> }
}

server.registerTool('list_tickets', {
  description: 'List all fictional support tickets currently held by this demonstration server.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async () => result({ tickets: [...tickets.values()] }))

server.registerTool('get_ticket', {
  description: 'Retrieve one fictional support ticket by its TK-0000 identifier.',
  inputSchema: z.object({ ticketId: z.string().regex(/^TK-\d{4}$/) }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ ticketId }) => {
  const ticket = tickets.get(ticketId)
  if (!ticket) return { isError: true, content: [{ type: 'text', text: `Ticket ${ticketId} was not found.` }] }
  return result({ ticket: { ...ticket } })
})

server.registerTool('search_knowledge_base', {
  description: 'Search fictional support documentation using a short query.',
  inputSchema: z.object({ query: z.string().trim().min(2).max(200) }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ query }) => {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 2)
  const matches = knowledgeBase.filter((item) => words.some((word) => `${item.title} ${item.text}`.toLowerCase().includes(word)))
  return result({ results: matches })
})

server.registerTool('propose_ticket_action', {
  description: 'Validate and return a proposed priority update without changing any ticket.',
  inputSchema: z.object({
    ticketId: z.string().regex(/^TK-\d{4}$/),
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
  }).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}, async ({ ticketId, priority }) => {
  if (!tickets.has(ticketId)) return { isError: true, content: [{ type: 'text', text: `Ticket ${ticketId} was not found.` }] }
  return result({ proposed: true, action: { type: 'update_ticket_priority', ticketId, priority }, executed: false })
})

server.registerTool('update_ticket_priority', {
  description: 'Change priority on a fictional ticket. The caller must enforce application policy and human approval before invoking this write tool.',
  inputSchema: z.object({
    ticketId: z.string().regex(/^TK-\d{4}$/),
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
  }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, async ({ ticketId, priority }) => {
  const ticket = tickets.get(ticketId)
  if (!ticket) return { isError: true, content: [{ type: 'text', text: `Ticket ${ticketId} was not found.` }] }
  ticket.priority = priority
  return result({ ticket: { ...ticket }, updated: true })
})

const transport = new StdioServerTransport()
transport.onerror = (error) => process.stderr.write(`[agentops-mcp] ${error.message}\n`)

try {
  await server.connect(transport)
  process.stderr.write('[agentops-mcp] stdio MCP server ready\n')
} catch (error) {
  process.stderr.write(`[agentops-mcp] startup failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void server.close().finally(() => process.exit(0)) })
}
