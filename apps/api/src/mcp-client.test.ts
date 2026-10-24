import { afterEach, describe, expect, it } from 'vitest'
import { createMcpClientAdapter } from './mcp-client'

const adapters: ReturnType<typeof createMcpClientAdapter>[] = []
afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.close())) })

describe('MCP client adapter failures and limits', () => {
  it('reports a missing child server clearly', async () => {
    const adapter = createMcpClientAdapter({ command: '/path/that/does/not/exist/agentops-mcp', args: [], timeoutMs: 500 })
    adapters.push(adapter)
    await expect(adapter.connect()).rejects.toMatchObject({ code: 'MCP_UNAVAILABLE' })
  })

  it('times out a server that never completes MCP initialization', async () => {
    const adapter = createMcpClientAdapter({ command: process.execPath, args: ['--input-type=module', '-e', 'setInterval(() => {}, 1000)'], timeoutMs: 600 })
    adapters.push(adapter)
    await expect(adapter.connect()).rejects.toMatchObject({ code: 'MCP_TIMEOUT' })
    expect(adapter.status().connected).toBe(false)
  })

  it('times out tool calls, closes the stale connection, and can reconnect', async () => {
    const serverProgram = `
      import { McpServer } from '@modelcontextprotocol/server';
      import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
      import { z } from 'zod';
      const server = new McpServer({ name: 'slow-test-server', version: '1.0.0' });
      server.registerTool('slow_echo', { inputSchema: z.object({ text: z.string() }).strict() }, async ({ text }) => {
        await new Promise(resolve => setTimeout(resolve, 1600));
        return { content: [{ type: 'text', text }] };
      });
      await server.connect(new StdioServerTransport());
    `
    const adapter = createMcpClientAdapter({ command: process.execPath, args: ['--input-type=module', '-e', serverProgram], timeoutMs: 1000 })
    adapters.push(adapter)
    await adapter.connect()
    await expect(adapter.callTool('slow_echo', { text: 'fictional' })).rejects.toMatchObject({ code: 'MCP_TIMEOUT' })
    expect(adapter.status().connected).toBe(false)
    await adapter.connect()
    expect(adapter.status().tools).toContain('slow_echo')
  })
})
