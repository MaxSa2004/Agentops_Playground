import { afterAll, describe, expect, it } from 'vitest'
import { createMcpClientAdapter } from './mcp-client'

describe('real MCP stdio integration', () => {
  const mcp = createMcpClientAdapter({ timeoutMs: 12_000 })
  afterAll(async () => { await mcp.close() })

  it('discovers and invokes every demo tool over the official MCP client/server protocol', async () => {
    await mcp.connect()
    const tools = await mcp.listTools()
    expect(tools.map(({ name }) => name).sort()).toEqual([
      'get_ticket', 'list_tickets', 'propose_ticket_action', 'search_knowledge_base', 'update_ticket_priority',
    ])

    const listed = await mcp.callTool('list_tickets', {})
    expect(listed.structuredContent).toMatchObject({ tickets: expect.arrayContaining([expect.objectContaining({ id: 'TK-2048', priority: 'normal' })]) })
    const ticket = await mcp.callTool('get_ticket', { ticketId: 'TK-2048' })
    expect(ticket.structuredContent).toMatchObject({ ticket: { id: 'TK-2048', priority: 'normal' } })
    await expect(mcp.callTool('get_ticket', { ticketId: 'invalid' })).rejects.toMatchObject({ code: 'MCP_INVALID_ARGUMENTS' })
    await expect(mcp.callTool('unknown_tool', {})).rejects.toMatchObject({ code: 'MCP_INVALID_TOOL' })
    await expect(mcp.callTool('get_ticket', { ticketId: 'TK-0000' })).rejects.toMatchObject({ code: 'MCP_TOOL_ERROR' })

    const docs = await mcp.callTool('search_knowledge_base', { query: 'refund late delivery' })
    expect(docs.structuredContent).toMatchObject({ results: [expect.objectContaining({ title: 'Late delivery refunds' })] })
    const proposal = await mcp.callTool('propose_ticket_action', { ticketId: 'TK-2048', priority: 'urgent' })
    expect(proposal.structuredContent).toMatchObject({ proposed: true, executed: false, action: { type: 'update_ticket_priority', priority: 'urgent' } })
    expect((await mcp.callTool('get_ticket', { ticketId: 'TK-2048' })).structuredContent).toMatchObject({ ticket: { priority: 'normal' } })

    const updated = await mcp.callTool('update_ticket_priority', { ticketId: 'TK-2048', priority: 'high' })
    expect(updated.structuredContent).toMatchObject({ updated: true, ticket: { priority: 'high' } })
    expect((await mcp.callTool('get_ticket', { ticketId: 'TK-2048' })).structuredContent).toMatchObject({ ticket: { priority: 'high' } })

    await mcp.close()
    expect(mcp.status().connected).toBe(false)
    await mcp.connect()
    expect(mcp.status().connected).toBe(true)
    expect((await mcp.callTool('get_ticket', { ticketId: 'TK-2048' })).structuredContent).toMatchObject({ ticket: { priority: 'normal' } })
  })
})
