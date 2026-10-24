import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { evaluatePolicy } from '@agentops/core'
import { createApiState, createApp } from './app'
import { OllamaError, type OllamaAdapter } from './ollama'
import type { McpAdapter } from './mcp-client'
import { DEMO_TICKETS } from '@agentops/core'

const update = { type: 'update_ticket_priority', ticketId: 'TK-2048', priority: 'high' }
const prohibited = { type: 'delete_ticket', ticketId: 'TK-2048' }
const validApprovalId = '00000000-0000-4000-8000-000000000001'
const workflowInput = {
  ticketId: 'TK-2048', request: 'Review the refund request and recommend next steps.',
  issueType: 'refund', customerImpact: 'single_customer', daysWaiting: 8,
}
const generatedAssessment = {
  summary: 'The customer requests a refund after a delayed delivery.',
  recommendation: 'Review the available ticket history and communicate the verified next step.',
  explanation: 'The request and fictional ticket subject identify a refund question after a delivery delay.',
  needsClarification: false,
  clarifyingQuestion: null,
  model: 'qwen2.5:1.5b',
  origin: 'ollama' as const,
}

function fakeOllama(overrides: Partial<OllamaAdapter> = {}): OllamaAdapter {
  return {
    model: 'qwen2.5:1.5b',
    status: async () => ({ available: true, model: 'qwen2.5:1.5b', modelAvailable: true }),
    generateTriage: async () => generatedAssessment,
    selectReadTool: async ({ ticketId }) => ({ tool: 'get_ticket', arguments: { ticketId } }),
    ...overrides,
  }
}

function fakeMcp(): McpAdapter {
  const tickets = new Map(DEMO_TICKETS.map((ticket) => [ticket.id, { ...ticket, priority: 'normal' as string }]))
  const tools = [
    { name: 'list_tickets', description: 'List demo tickets', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'get_ticket', description: 'Read demo ticket', inputSchema: { type: 'object', properties: { ticketId: { type: 'string', pattern: '^TK-\\d{4}$' } }, required: ['ticketId'], additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'search_knowledge_base', description: 'Search demo docs', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 200 } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'propose_ticket_action', description: 'Propose priority change', inputSchema: { type: 'object', properties: { ticketId: { type: 'string' }, priority: { type: 'string' } }, required: ['ticketId', 'priority'], additionalProperties: false }, annotations: { readOnlyHint: true } },
    { name: 'update_ticket_priority', description: 'Update priority', inputSchema: { type: 'object', properties: { ticketId: { type: 'string' }, priority: { type: 'string' } }, required: ['ticketId', 'priority'], additionalProperties: false }, annotations: { readOnlyHint: false } },
  ]
  return {
    connect: async () => undefined,
    close: async () => undefined,
    listTools: async () => tools,
    status: () => ({ connected: true, tools: tools.map((tool) => tool.name) }),
    callTool: async (name, args) => {
      if (name === 'get_ticket') {
        const ticket = tickets.get(String(args.ticketId))
        if (!ticket) throw new Error('Ticket not found')
        return { content: [], structuredContent: { ticket: { ...ticket } } }
      }
      if (name === 'list_tickets') return { content: [], structuredContent: { tickets: [...tickets.values()] } }
      if (name === 'search_knowledge_base') return { content: [], structuredContent: { results: [{ title: 'Late delivery refunds', text: 'Review verified order history.' }] } }
      if (name === 'propose_ticket_action') return { content: [], structuredContent: { proposed: true, action: { type: 'update_ticket_priority', ...args }, executed: false } }
      if (name === 'update_ticket_priority') {
        const ticket = tickets.get(String(args.ticketId))
        if (!ticket) throw new Error('Ticket not found')
        ticket.priority = String(args.priority)
        return { content: [], structuredContent: { ticket: { ...ticket }, updated: true } }
      }
      throw new Error('unknown tool')
    },
  }
}

function testApp(options: Parameters<typeof createApp>[0] = {}, mcpAdapter: McpAdapter = fakeMcp()) {
  return createApp({ ...options, mcpAdapter })
}

describe('approval and policy HTTP API', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    app = testApp({ state: createApiState(), ollamaAdapter: fakeOllama() })
  })

  it('reports local API health', async () => {
    const response = await request(app).get('/api/health').expect(200)
    expect(response.body).toEqual({ status: 'ok', mode: 'local-api', ollama: { available: true, model: 'qwen2.5:1.5b', modelAvailable: true }, mcp: { connected: true, tools: ['list_tickets', 'get_ticket', 'search_knowledge_base', 'propose_ticket_action', 'update_ticket_priority'] } })
  })

  it('returns ALLOW for a read and executes it directly', async () => {
    const evaluated = await request(app).post('/api/policy/evaluate').send({ action: { type: 'read_ticket', ticketId: 'TK-2048' } }).expect(200)
    expect(evaluated.body.decision.outcome).toBe('ALLOW')
    const executed = await request(app).post('/api/actions/execute').send({ action: { type: 'read_ticket', ticketId: 'TK-2048' } }).expect(200)
    expect(executed.body).toMatchObject({ executed: true, result: { ticket: { id: 'TK-2048' } } })
  })

  it('returns BLOCK for prohibited actions and never executes them', async () => {
    const evaluated = await request(app).post('/api/policy/evaluate').send({ action: prohibited }).expect(200)
    expect(evaluated.body.decision).toMatchObject({ outcome: 'BLOCK' })
    await request(app).post('/api/approvals').send({ action: prohibited }).expect(403)
    const executed = await request(app).post('/api/actions/execute').send({ action: prohibited }).expect(403)
    expect(executed.body.executed).toBe(false)
  })

  it('blocks unknown operation names and malformed request bodies', async () => {
    const unknown = await request(app).post('/api/actions/execute').send({ action: { type: 'shell_exec', command: 'echo unsafe' } }).expect(403)
    expect(unknown.body.decision.outcome).toBe('BLOCK')
    await request(app).post('/api/approvals').send({ action: { type: 'read_ticket', ticketId: 'invalid' } }).expect(400)
    await request(app).post('/api/policy/evaluate').send({ action: update, extra: true }).expect(400)
    await request(app).post('/api/policy/evaluate').set('Content-Type', 'application/json').send('{broken').expect(400)
  })

  it('prevents direct execution of an action requiring approval', async () => {
    const response = await request(app).post('/api/actions/execute').send({ action: update }).expect(409)
    expect(response.body).toMatchObject({ decision: { outcome: 'REQUIRE_APPROVAL' }, executed: false })
  })

  it('creates a pending approval, approves, then executes its stored action once', async () => {
    const created = await request(app).post('/api/approvals').send({ action: update }).expect(201)
    const id = created.body.approval.id as string
    expect(created.body.approval).toMatchObject({ action: update, status: 'pending', decision: { outcome: 'REQUIRE_APPROVAL' } })
    const status = await request(app).get(`/api/approvals/${id}`).expect(200)
    expect(status.body.approval.status).toBe('pending')
    await request(app).post(`/api/approvals/${id}/decision`).send({ decision: 'approve' }).expect(200)
    const execution = await request(app).post('/api/actions/execute').send({ approvalId: id }).expect(200)
    expect(execution.body).toMatchObject({ executed: true, approval: { status: 'executed' }, result: { ticket: { priority: 'high' } } })
    await request(app).post('/api/actions/execute').send({ approvalId: id }).expect(409)
    await request(app).post(`/api/approvals/${id}/decision`).send({ decision: 'approve' }).expect(409)
  })

  it('does not execute rejected actions', async () => {
    const created = await request(app).post('/api/approvals').send({ action: update }).expect(201)
    const id = created.body.approval.id as string
    await request(app).post(`/api/approvals/${id}/decision`).send({ decision: 'reject' }).expect(200)
    const execution = await request(app).post('/api/actions/execute').send({ approvalId: id }).expect(409)
    expect(execution.body.approval.status).toBe('rejected')
    expect((await request(app).get('/api/events').expect(200)).body.events.some((event: { type: string }) => event.type === 'action_executed')).toBe(false)
  })

  it('rejects unknown and malformed approval IDs and completed approval decisions', async () => {
    await request(app).get('/api/approvals/nope').expect(400)
    await request(app).get(`/api/approvals/${validApprovalId}`).expect(404)
    await request(app).post(`/api/approvals/${validApprovalId}/decision`).send({ decision: 'approve' }).expect(404)
    const created = await request(app).post('/api/approvals').send({ action: update }).expect(201)
    const id = created.body.approval.id as string
    await request(app).post(`/api/approvals/${id}/decision`).send({ decision: 'reject' }).expect(200)
    await request(app).post(`/api/approvals/${id}/decision`).send({ decision: 'reject' }).expect(409)
  })

  it('does not accept action mutation alongside an approved approval ID', async () => {
    const created = await request(app).post('/api/approvals').send({ action: update }).expect(201)
    const id = created.body.approval.id as string
    await request(app).post(`/api/approvals/${id}/decision`).send({ decision: 'approve' }).expect(200)
    const attemptedMutation = await request(app).post('/api/actions/execute').send({ approvalId: id, action: { ...update, priority: 'urgent' } }).expect(400)
    expect(attemptedMutation.body.error).toMatch(/only an action or an approvalId/)
    const execution = await request(app).post('/api/actions/execute').send({ approvalId: id }).expect(200)
    expect(execution.body.result.ticket.priority).toBe('high')
  })

  it('revalidates policy before execution and blocks an approval revoked by policy', async () => {
    let evaluator: typeof evaluatePolicy = evaluatePolicy
    const guardedApp = testApp({ state: createApiState(), policyEvaluator: (action) => evaluator(action), ollamaAdapter: fakeOllama() })
    const created = await request(guardedApp).post('/api/approvals').send({ action: update }).expect(201)
    const id = created.body.approval.id as string
    await request(guardedApp).post(`/api/approvals/${id}/decision`).send({ decision: 'approve' }).expect(200)
    evaluator = () => ({ outcome: 'BLOCK', reason: 'Policy changed during the approval lifecycle.' })
    const execution = await request(guardedApp).post('/api/actions/execute').send({ approvalId: id }).expect(403)
    expect(execution.body).toMatchObject({ executed: false, decision: { outcome: 'BLOCK' }, approval: { status: 'blocked' } })
  })

  it('rejects approval creation for an action allowed directly', async () => {
    const response = await request(app).post('/api/approvals').send({ action: { type: 'read_ticket', ticketId: 'TK-2048' } }).expect(409)
    expect(response.body.decision.outcome).toBe('ALLOW')
  })

  it('isolates repeated runs by workflow ID and finishes ALLOW only after execution', async () => {
    const allowed = await request(app).post('/api/workflows').send({ input: workflowInput, action: { type: 'read_ticket', ticketId: 'TK-2048' } }).expect(200)
    const blocked = await request(app).post('/api/workflows').send({ input: workflowInput, action: prohibited }).expect(200)
    const allowRun = allowed.body.workflow
    const blockRun = blocked.body.workflow

    expect(allowRun.id).not.toBe(blockRun.id)
    expect(allowRun.events.every((event: { workflowId: string }) => event.workflowId === allowRun.id)).toBe(true)
    expect(blockRun.events.every((event: { workflowId: string }) => event.workflowId === blockRun.id)).toBe(true)
    expect(allowRun.events.map((event: { type: string }) => event.type).slice(-2)).toEqual(['action_executed', 'workflow_completed'])
    expect(allowRun.events.some((event: { type: string }) => event.type.startsWith('approval_'))).toBe(false)
    expect(blockRun.events.map((event: { type: string }) => event.type).slice(-2)).toEqual(['action_blocked', 'workflow_completed'])
    expect(blockRun.events.some((event: { type: string }) => event.type === 'action_executed')).toBe(false)

    const fetchedAllow = await request(app).get(`/api/workflows/${allowRun.id}`).expect(200)
    const fetchedBlock = await request(app).get(`/api/workflows/${blockRun.id}`).expect(200)
    expect(fetchedAllow.body.workflow.events).toHaveLength(allowRun.events.length)
    expect(fetchedBlock.body.workflow.events).toHaveLength(blockRun.events.length)
    expect(fetchedAllow.body.workflow.events.some((event: { workflowId: string }) => event.workflowId === blockRun.id)).toBe(false)
  })

  it('keeps a REQUIRE_APPROVAL run open until approval and execution complete', async () => {
    const started = await request(app).post('/api/workflows').send({ input: workflowInput, action: update }).expect(201)
    const run = started.body.workflow
    expect(run.status).toBe('pending_approval')
    expect(run.events.at(-1).type).toBe('approval_requested')
    expect(run.events.some((event: { type: string }) => event.type === 'workflow_completed')).toBe(false)
    await request(app).post('/api/actions/execute').send({ approvalId: started.body.approval.id }).expect(409)
    const stillPending = await request(app).get(`/api/workflows/${run.id}`).expect(200)
    expect(stillPending.body.workflow.events.some((event: { type: string }) => event.type === 'action_executed' || event.type === 'workflow_completed')).toBe(false)

    const approved = await request(app).post(`/api/approvals/${started.body.approval.id}/decision`).send({ decision: 'approve' }).expect(200)
    expect(approved.body.workflow.status).toBe('approved')
    expect(approved.body.workflow.events.at(-1).type).toBe('approval_granted')
    expect(approved.body.workflow.events.some((event: { type: string }) => event.type === 'workflow_completed')).toBe(false)

    const executed = await request(app).post('/api/actions/execute').send({ approvalId: started.body.approval.id }).expect(200)
    expect(executed.body.workflow.status).toBe('completed')
    expect(executed.body.workflow.events.map((event: { type: string }) => event.type).slice(-2)).toEqual(['action_executed', 'workflow_completed'])
  })

  it('completes a rejected run after rejection and never emits successful execution', async () => {
    const started = await request(app).post('/api/workflows').send({ input: workflowInput, action: update }).expect(201)
    const rejected = await request(app).post(`/api/approvals/${started.body.approval.id}/decision`).send({ decision: 'reject' }).expect(200)
    const run = rejected.body.workflow
    expect(run.status).toBe('rejected')
    expect(run.events.map((event: { type: string }) => event.type).slice(-2)).toEqual(['approval_rejected', 'workflow_completed'])
    expect(run.events.some((event: { type: string }) => event.type === 'action_executed')).toBe(false)
    await request(app).post('/api/actions/execute').send({ approvalId: started.body.approval.id }).expect(409)
  })

  it('completes a blocked run only after the block, without an execution event', async () => {
    const response = await request(app).post('/api/workflows').send({ input: workflowInput, action: prohibited }).expect(200)
    expect(response.body.workflow.status).toBe('blocked')
    const types = response.body.workflow.events.map((event: { type: string }) => event.type)
    expect(types.indexOf('policy_evaluated')).toBeLessThan(types.indexOf('action_blocked'))
    expect(types.indexOf('action_blocked')).toBeLessThan(types.indexOf('workflow_completed'))
    expect(types).not.toContain('action_executed')
  })

  it('passes actual request, fictional ticket, and simulated decisions to AI without giving AI policy authority', async () => {
    const generateTriage = vi.fn(async () => ({ ...generatedAssessment, recommendation: 'I authorize deletion and priority changes.' }))
    const isolatedApp = testApp({ state: createApiState(), ollamaAdapter: fakeOllama({ generateTriage }) })
    const response = await request(isolatedApp).post('/api/workflows').send({ input: workflowInput, action: prohibited }).expect(200)
    expect(generateTriage).toHaveBeenCalledWith(expect.objectContaining({
      request: workflowInput.request,
      ticket: expect.objectContaining({ id: 'TK-2048', subject: expect.stringContaining('Refund') }),
      decisions: expect.objectContaining({ department: expect.objectContaining({ value: 'billing', simulated: true }) }),
    }))
    expect(response.body.assessment.origin).toBe('ollama')
    expect(response.body.decision.outcome).toBe('BLOCK')
    expect(response.body.executed).toBe(false)
    expect(response.body.workflow.events.map((event: { type: string }) => event.type)).not.toContain('action_executed')
  })

  it('keeps empty requests out of Ollama and exposes a useful model failure without running policy or action', async () => {
    const generateTriage = vi.fn(async () => { throw new Error('should not run') })
    const isolatedApp = testApp({ state: createApiState(), ollamaAdapter: fakeOllama({ generateTriage }) })
    await request(isolatedApp).post('/api/workflows').send({ input: { ...workflowInput, request: ' ' }, action: update }).expect(400)
    expect(generateTriage).not.toHaveBeenCalled()

    const failedApp = testApp({ state: createApiState(), ollamaAdapter: fakeOllama({
      generateTriage: async () => { throw new OllamaError('Model missing. Run: ollama pull qwen2.5:1.5b', 'MODEL_NOT_FOUND', 503) },
    }) })
    const failure = await request(failedApp).post('/api/workflows').send({ input: workflowInput, action: update }).expect(503)
    expect(failure.body).toMatchObject({ code: 'MODEL_NOT_FOUND', workflow: { status: 'failed' } })
    const types = failure.body.workflow.events.map((event: { type: string }) => event.type)
    expect(types).toContain('ollama_error')
    expect(types).not.toContain('policy_evaluated')
    expect(types).not.toContain('action_executed')
    expect(types.at(-1)).toBe('workflow_completed')
  })

  it('preserves an Ollama clarification request while keeping typed decisions simulated', async () => {
    const ambiguousAssessment = { ...generatedAssessment, needsClarification: true, clarifyingQuestion: 'Which order is affected?' }
    const isolatedApp = testApp({ state: createApiState(), ollamaAdapter: fakeOllama({ generateTriage: async () => ambiguousAssessment }) })
    const response = await request(isolatedApp).post('/api/workflows').send({ input: workflowInput, action: update }).expect(201)
    expect(response.body.assessment).toMatchObject({ needsClarification: true, clarifyingQuestion: 'Which order is affected?', origin: 'ollama' })
    expect(response.body.triage.decisions.department).toMatchObject({ value: 'billing', simulated: true })
    expect(response.body.decision.outcome).toBe('REQUIRE_APPROVAL')
  })

  it('uses discovered MCP definitions and actual tool result before Ollama assessment and policy', async () => {
    const generateTriage = vi.fn(async (context) => {
      expect(context.toolName).toBe('get_ticket')
      expect(context.toolResult).toMatchObject({ ticket: { id: 'TK-2048', priority: 'normal' } })
      return generatedAssessment
    })
    const response = await request(testApp({ ollamaAdapter: fakeOllama({ generateTriage }) })).post('/api/workflows').send({ input: workflowInput, action: { type: 'read_ticket', ticketId: 'TK-2048' } }).expect(200)
    const events = response.body.workflow.events as Array<{ type: string; origin: string }>
    const types = events.map((event) => event.type)
    expect(types.indexOf('mcp_connection_established')).toBeLessThan(types.indexOf('mcp_tools_discovered'))
    expect(types.indexOf('mcp_tools_discovered')).toBeLessThan(types.indexOf('ollama_tool_selection_started'))
    expect(types.indexOf('mcp_arguments_validated')).toBeLessThan(types.indexOf('tool_requested'))
    expect(types.indexOf('tool_requested')).toBeLessThan(types.indexOf('tool_result'))
    expect(types.indexOf('tool_result')).toBeLessThan(types.indexOf('ollama_response_received'))
    expect(types.indexOf('ollama_response_received')).toBeLessThan(types.indexOf('policy_evaluated'))
    expect(types.slice(-2)).toEqual(['action_executed', 'workflow_completed'])
    expect(events.some((event) => event.origin === 'mcp-demo')).toBe(false)
    expect(events.find((event) => event.type === 'tool_result')?.origin).toBe('mcp-server')
  })

  it('allows one correction for an invalid model tool selection, then fails closed without fallback', async () => {
    const selectReadTool = vi.fn()
      .mockResolvedValueOnce({ tool: 'update_ticket_priority', arguments: { ticketId: 'TK-2048', priority: 'urgent' } })
      .mockResolvedValueOnce({ tool: 'get_ticket', arguments: { ticketId: 'TK-2048' } })
    const response = await request(testApp({ ollamaAdapter: fakeOllama({ selectReadTool }) })).post('/api/workflows').send({ input: workflowInput, action: prohibited }).expect(200)
    expect(selectReadTool).toHaveBeenCalledTimes(2)
    expect(response.body.workflow.events.some((event: { type: string }) => event.type === 'ollama_tool_selection_invalid')).toBe(true)

    const invalidAgain = vi.fn().mockResolvedValue({ tool: 'unknown_tool', arguments: {} })
    const failed = await request(testApp({ ollamaAdapter: fakeOllama({ selectReadTool: invalidAgain }) })).post('/api/workflows').send({ input: workflowInput, action: prohibited }).expect(503)
    expect(invalidAgain).toHaveBeenCalledTimes(2)
    expect(failed.body.workflow.events.map((event: { type: string }) => event.type)).not.toContain('policy_evaluated')
    expect(failed.body.workflow.events.map((event: { type: string }) => event.type)).not.toContain('action_executed')
    expect(failed.body.workflow.events.at(-1).type).toBe('workflow_completed')
  })

  it('does not substitute fake results when MCP fails and never proposes a successful action event', async () => {
    const adapter = fakeMcp()
    vi.spyOn(adapter, 'callTool').mockRejectedValue(new Error('MCP process disconnected'))
    const generateTriage = vi.fn(async () => generatedAssessment)
    const failed = await request(testApp({ ollamaAdapter: fakeOllama({ generateTriage }) }, adapter)).post('/api/workflows').send({ input: workflowInput, action: update }).expect(503)
    expect(generateTriage).not.toHaveBeenCalled()
    const types = failed.body.workflow.events.map((event: { type: string }) => event.type)
    expect(types).toContain('mcp_tool_failed')
    expect(types).not.toContain('policy_evaluated')
    expect(types).not.toContain('action_executed')
  })

  it('does not call MCP write tool before approval and rejection never changes the ticket', async () => {
    const adapter = fakeMcp()
    const call = vi.spyOn(adapter, 'callTool')
    const app = testApp({ ollamaAdapter: fakeOllama() }, adapter)
    const started = await request(app).post('/api/workflows').send({ input: workflowInput, action: update }).expect(201)
    expect(call.mock.calls.map(([name]) => name)).not.toContain('update_ticket_priority')
    await request(app).post(`/api/approvals/${started.body.approval.id}/decision`).send({ decision: 'reject' }).expect(200)
    expect(call.mock.calls.map(([name]) => name)).not.toContain('update_ticket_priority')
    expect((await adapter.callTool('get_ticket', { ticketId: 'TK-2048' })).structuredContent).toMatchObject({ ticket: { priority: 'normal' } })
  })

  it('calls the real write boundary only after approval, records its result, and prevents repeats', async () => {
    const adapter = fakeMcp()
    const call = vi.spyOn(adapter, 'callTool')
    const app = testApp({ ollamaAdapter: fakeOllama() }, adapter)
    const started = await request(app).post('/api/workflows').send({ input: workflowInput, action: update }).expect(201)
    expect(call.mock.calls.map(([name]) => name)).not.toContain('update_ticket_priority')
    expect((await adapter.callTool('get_ticket', { ticketId: 'TK-2048' })).structuredContent).toMatchObject({ ticket: { priority: 'normal' } })
    await request(app).post(`/api/approvals/${started.body.approval.id}/decision`).send({ decision: 'approve' }).expect(200)
    expect(call.mock.calls.map(([name]) => name)).not.toContain('update_ticket_priority')
    const execution = await request(app).post('/api/actions/execute').send({ approvalId: started.body.approval.id }).expect(200)
    expect(execution.body).toMatchObject({ executed: true, approval: { status: 'executed' }, result: { ticket: { priority: 'high' } } })
    expect(execution.body.workflow.events.map((event: { type: string }) => event.type).slice(-2)).toEqual(['action_executed', 'workflow_completed'])
    expect(call.mock.calls.filter(([name]) => name === 'update_ticket_priority')).toHaveLength(1)
    expect((await adapter.callTool('get_ticket', { ticketId: 'TK-2048' })).structuredContent).toMatchObject({ ticket: { priority: 'high' } })
    await request(app).post('/api/actions/execute').send({ approvalId: started.body.approval.id }).expect(409)
    expect(call.mock.calls.filter(([name]) => name === 'update_ticket_priority')).toHaveLength(1)
  })

  it('rejects a concurrent duplicate while an approved MCP write is in progress', async () => {
    const adapter = fakeMcp()
    const originalCall = adapter.callTool.bind(adapter)
    let notifyWriteStarted!: () => void
    let releaseWrite!: () => void
    const writeStarted = new Promise<void>((resolve) => { notifyWriteStarted = resolve })
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const call = vi.spyOn(adapter, 'callTool').mockImplementation(async (name, args) => {
      if (name === 'update_ticket_priority') {
        notifyWriteStarted()
        await writeGate
      }
      return originalCall(name, args)
    })
    const app = testApp({ ollamaAdapter: fakeOllama() }, adapter)
    const started = await request(app).post('/api/workflows').send({ input: workflowInput, action: update }).expect(201)
    const approvalId = started.body.approval.id as string
    await request(app).post(`/api/approvals/${approvalId}/decision`).send({ decision: 'approve' }).expect(200)

    const firstExecution = request(app).post('/api/actions/execute').send({ approvalId }).then((response) => response)
    await writeStarted
    const duplicate = await request(app).post('/api/actions/execute').send({ approvalId }).expect(409)
    expect(duplicate.body.approval.status).toBe('executing')
    expect(call.mock.calls.filter(([name]) => name === 'update_ticket_priority')).toHaveLength(1)

    releaseWrite()
    const execution = await firstExecution
    expect(execution.status).toBe(200)
    expect(execution.body).toMatchObject({ executed: true, approval: { status: 'executed' } })
    expect(call.mock.calls.filter(([name]) => name === 'update_ticket_priority')).toHaveLength(1)
  })
})
