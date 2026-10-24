import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export interface DiscoveredMcpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export interface McpCallResult {
  structuredContent?: unknown
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

export interface McpAdapter {
  connect(): Promise<void>
  close(): Promise<void>
  listTools(): Promise<DiscoveredMcpTool[]>
  callTool(name: string, args: unknown): Promise<McpCallResult>
  status(): { connected: boolean; tools: string[] }
}

export class McpClientError extends Error {
  constructor(message: string, readonly code: 'MCP_UNAVAILABLE' | 'MCP_TOOL_ERROR' | 'MCP_TIMEOUT' | 'MCP_INVALID_TOOL' | 'MCP_INVALID_ARGUMENTS') {
    super(message)
    this.name = 'McpClientError'
  }
}

export interface McpAdapterOptions {
  command?: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
}

const SERVER_ENTRY = fileURLToPath(new URL('../../mcp-server/src/server.ts', import.meta.url))

/** One long-lived SDK client and one child server process per local API process. */
export function createMcpClientAdapter(options: McpAdapterOptions = {}): McpAdapter {
  const command = options.command ?? process.execPath
  const args = options.args ?? ['--import', 'tsx', SERVER_ENTRY]
  const cwd = options.cwd ?? process.cwd()
  const timeoutMs = options.timeoutMs ?? positiveInt(process.env.MCP_TOOL_TIMEOUT_MS, 8_000)
  let client: Client | undefined
  let connected = false
  let tools: DiscoveredMcpTool[] = []
  let connecting: Promise<void> | undefined

  const ensureConnected = async () => {
    if (connected && client) return
    if (connecting) return connecting
    connecting = (async () => {
      const nextClient = new Client({ name: 'agentops-playground-api', version: '1.0.0' })
      const nextTransport = new StdioClientTransport({
        command,
        args,
        cwd,
        stderr: 'pipe',
      })
      nextTransport.onclose = () => { connected = false }
      nextTransport.onerror = (error) => process.stderr.write(`[agentops-mcp-client] ${error.message}\n`)
      const diagnostic = nextTransport.stderr
      diagnostic?.on('data', (chunk: Buffer) => process.stderr.write(`[mcp-server] ${chunk.toString().slice(0, 500)}`))
      try {
        await withTimeout(nextClient.connect(nextTransport), timeoutMs, 'MCP server connection timed out.')
        client = nextClient
        const response = await withTimeout(nextClient.listTools(), timeoutMs, 'MCP tool discovery timed out.')
        tools = response.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          annotations: tool.annotations as Record<string, unknown> | undefined,
        }))
        connected = true
      } catch (error) {
        await nextClient.close().catch(() => undefined)
        client = undefined
        throw error instanceof McpClientError ? error : new McpClientError(`Could not start or connect to the local MCP server (${errorText(error)}). Check that the workspace dependencies are installed.`, 'MCP_UNAVAILABLE')
      } finally {
        connecting = undefined
      }
    })()
    return connecting
  }

  return {
    connect: ensureConnected,
    async close() {
      connected = false
      tools = []
      const current = client
      client = undefined
      if (current) await current.close()
    },
    async listTools() {
      await ensureConnected()
      return tools.map((tool) => structuredClone(tool))
    },
    async callTool(name, args) {
      await ensureConnected()
      const tool = tools.find((candidate) => candidate.name === name)
      if (!tool) throw new McpClientError(`MCP tool "${name}" is not available from the connected server.`, 'MCP_INVALID_TOOL')
      validateJsonSchema(tool.inputSchema, args)
      try {
        const result = await withTimeout(client!.callTool({ name, arguments: args as Record<string, unknown> }), timeoutMs, `MCP tool "${name}" timed out after ${timeoutMs} ms.`)
        if (result.isError) {
          const detail = result.content.filter((item) => item.type === 'text').map((item) => item.text).join(' ').slice(0, 300)
          throw new McpClientError(detail || `MCP tool "${name}" returned an error.`, 'MCP_TOOL_ERROR')
        }
        return { structuredContent: result.structuredContent, content: result.content, isError: result.isError }
      } catch (error) {
        if (error instanceof McpClientError) {
          if (error.code === 'MCP_TIMEOUT') {
            const stale = client
            connected = false
            tools = []
            client = undefined
            await stale?.close().catch(() => undefined)
          }
          throw error
        }
        const stale = client
        connected = false
        tools = []
        client = undefined
        await stale?.close().catch(() => undefined)
        throw new McpClientError(`MCP call to "${name}" failed: ${errorText(error)}`, 'MCP_TOOL_ERROR')
      }
    },
    status: () => ({ connected, tools: tools.map((tool) => tool.name) }),
  }
}

export function validateJsonSchema(schema: Record<string, unknown>, value: unknown): void {
  if (!isRecord(value)) throw new McpClientError('MCP arguments must be a JSON object.', 'MCP_INVALID_ARGUMENTS')
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []
  const additional = schema.additionalProperties !== false
  if (required.some((key) => !(key in value))) throw new McpClientError(`MCP arguments are missing required field "${required.find((key) => !(key in value))}".`, 'MCP_INVALID_ARGUMENTS')
  if (!additional && Object.keys(value).some((key) => !(key in properties))) {
    const unexpected = Object.keys(value).find((key) => !(key in properties))
    throw new McpClientError(`MCP arguments contain unknown field "${unexpected}".`, 'MCP_INVALID_ARGUMENTS')
  }
  for (const [key, item] of Object.entries(value)) {
    const property = properties[key]
    if (!isRecord(property)) continue
    const expectedType = property.type
    if (expectedType === 'string' && typeof item !== 'string') throw new McpClientError(`MCP argument "${key}" must be a string.`, 'MCP_INVALID_ARGUMENTS')
    if (expectedType === 'number' && (typeof item !== 'number' || !Number.isFinite(item))) throw new McpClientError(`MCP argument "${key}" must be a number.`, 'MCP_INVALID_ARGUMENTS')
    if (Array.isArray(property.enum) && !property.enum.includes(item)) throw new McpClientError(`MCP argument "${key}" is not an allowed value.`, 'MCP_INVALID_ARGUMENTS')
    if (typeof item === 'string' && typeof property.pattern === 'string' && !new RegExp(property.pattern).test(item)) throw new McpClientError(`MCP argument "${key}" has an invalid format.`, 'MCP_INVALID_ARGUMENTS')
    if (typeof item === 'string' && typeof property.minLength === 'number' && item.length < property.minLength) throw new McpClientError(`MCP argument "${key}" is too short.`, 'MCP_INVALID_ARGUMENTS')
    if (typeof item === 'string' && typeof property.maxLength === 'number' && item.length > property.maxLength) throw new McpClientError(`MCP argument "${key}" is too long.`, 'MCP_INVALID_ARGUMENTS')
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new McpClientError(message, 'MCP_TIMEOUT')), ms) }),
  ]).finally(() => clearTimeout(timer!))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function positiveInt(value: string | undefined, fallback: number): number { const result = Number(value); return Number.isInteger(result) && result > 0 ? result : fallback }
