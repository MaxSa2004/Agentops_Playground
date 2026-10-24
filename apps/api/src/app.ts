import { randomUUID } from 'node:crypto'
import express, { type ErrorRequestHandler, type Response } from 'express'
import { evaluatePolicy, parseProposedAction, runTriageWorkflow, type DemoTicket, type GeneratedTriageAssessment, type PolicyDecision, type ProposedAction, type WorkflowEvent, type WorkflowInput, type WorkflowResult } from '@agentops/core'
import { createOllamaAdapter, OllamaError, type OllamaAdapter } from './ollama'
import { createMcpClientAdapter, McpClientError, validateJsonSchema, type DiscoveredMcpTool, type McpAdapter } from './mcp-client'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'blocked' | 'executed'

export interface ApprovalRecord {
  id: string
  action: ProposedAction
  status: ApprovalStatus
  createdAt: string
  updatedAt: string
  decision: PolicyDecision
  result?: unknown
  workflowId?: string
}

export interface ApiEvent {
  id: string
  type: string
  timestamp: string
  message: string
  approvalId?: string
  workflowId?: string
  origin?: string
  data?: Record<string, unknown>
}

export type WorkflowRunStatus = 'running' | 'pending_approval' | 'approved' | 'completed' | 'blocked' | 'rejected' | 'failed'

export interface WorkflowRunRecord {
  id: string
  status: WorkflowRunStatus
  createdAt: string
  updatedAt: string
  input: WorkflowInput
  action: ProposedAction | { type: 'unknown'; operation: string }
  policyDecision?: PolicyDecision
  approvalId?: string
  result?: unknown
  assessment?: GeneratedTriageAssessment
  triage: WorkflowResult
  events: ApiEvent[]
}

export interface ApiState {
  approvals: Map<string, ApprovalRecord>
  workflows: Map<string, WorkflowRunRecord>
  events: ApiEvent[]
}

export interface AppOptions {
  policyEvaluator?: (action: unknown) => PolicyDecision
  state?: ApiState
  now?: () => Date
  ollamaAdapter?: OllamaAdapter
  mcpAdapter?: McpAdapter
}

export function createApiState(): ApiState {
  return {
    approvals: new Map(),
    workflows: new Map(),
    events: [],
  }
}

export function createApp(options: AppOptions = {}) {
  const app = express()
  const state = options.state ?? createApiState()
  const evaluator = options.policyEvaluator ?? evaluatePolicy
  const ollama = options.ollamaAdapter ?? createOllamaAdapter()
  const mcp = options.mcpAdapter ?? createMcpClientAdapter()
  const now = options.now ?? (() => new Date())
  const timestamp = () => now().toISOString()
  const recordEvent = (type: string, message: string, approvalId?: string, workflowId?: string, origin = 'api', data?: Record<string, unknown>) => {
    const event = { id: randomUUID(), type, timestamp: timestamp(), message, origin, ...(approvalId ? { approvalId } : {}), ...(workflowId ? { workflowId } : {}), ...(data ? { data } : {}) }
    state.events.push(event)
    return event
  }
  const appendWorkflowEvent = (run: WorkflowRunRecord, type: string, message: string, data?: Record<string, unknown>, approvalId?: string, origin = 'api') => {
    const event: ApiEvent = {
      id: randomUUID(), type, timestamp: timestamp(), message, workflowId: run.id, origin,
      ...(approvalId ? { approvalId } : {}), ...(data ? { data } : {}),
    }
    run.events.push(event)
    state.events.push(event)
    run.updatedAt = event.timestamp
    return event
  }
  const completeWorkflow = (run: WorkflowRunRecord, status: Exclude<WorkflowRunStatus, 'running' | 'pending_approval' | 'approved'>, message: string) => {
    run.status = status
    appendWorkflowEvent(run, 'workflow_completed', message, { status })
  }
  const failWorkflow = (run: WorkflowRunRecord, response: Response, error: unknown, completionMessage: string) => {
    const mcpError = error instanceof McpClientError ? error : undefined
    const ollamaError = error instanceof OllamaError ? error : undefined
    appendWorkflowEvent(run, ollamaError ? 'ollama_error' : 'mcp_workflow_error', errorMessage(error), { code: ollamaError?.code ?? mcpError?.code ?? 'MCP_WORKFLOW_ERROR' }, undefined, ollamaError ? 'ollama' : 'mcp-client')
    completeWorkflow(run, 'failed', completionMessage)
    return response.status(ollamaError?.httpStatus ?? (mcpError?.code === 'MCP_INVALID_ARGUMENTS' ? 400 : 503)).json({
      error: errorMessage(error), code: ollamaError?.code ?? mcpError?.code ?? 'MCP_WORKFLOW_ERROR', workflowId: run.id, workflow: publicWorkflow(run), triage: run.triage,
    })
  }

  app.use(express.json({ limit: '16kb' }))

  app.get('/api/health', async (_request, response) => {
    const ollamaStatus = await ollama.status()
    return response.json({ status: 'ok', mode: 'local-api', ollama: ollamaStatus, mcp: mcp.status() })
  })

  app.get('/api/mcp/tools', async (_request, response) => {
    try { return response.json({ tools: await mcp.listTools(), source: 'mcp-server' }) }
    catch (error) { return response.status(503).json({ error: errorMessage(error), code: error instanceof McpClientError ? error.code : 'MCP_UNAVAILABLE' }) }
  })

  app.post('/api/workflows', async (request, response) => {
    if (!isPlainObject(request.body) || !hasOnlyKeys(request.body, ['input', 'action']) || !('input' in request.body) || !('action' in request.body)) {
      return response.status(400).json({ error: 'Body must contain only input and action.' })
    }
    let triage: WorkflowResult
    let action: ProposedAction | { type: 'unknown'; operation: string }
    try {
      triage = runTriageWorkflow(request.body.input, now, { deferFinalEvent: true, liveMcp: true })
      action = parseProposedAction(request.body.action)
    } catch (error) {
      return response.status(400).json({ error: errorMessage(error) })
    }

    const id = randomUUID()
    const createdAt = timestamp()
    const initialEvents = triage.events.map((event: WorkflowEvent) => ({
      id: `${id}:${event.id}`,
      type: event.type,
      timestamp: event.timestamp,
      message: event.message,
      workflowId: id,
      origin: event.origin,
      ...(event.data ? { data: event.data } : {}),
    } satisfies ApiEvent))
    const run: WorkflowRunRecord = {
      id, status: 'running', createdAt, updatedAt: createdAt, input: triage.input,
      action, triage, events: initialEvents,
    }
    state.workflows.set(id, run)
    state.events.push(...initialEvents)

    let discovered: DiscoveredMcpTool[]
    try {
      discovered = await mcp.listTools()
      appendWorkflowEvent(run, 'mcp_connection_established', 'Connected to the persistent MCP server process.', { tools: discovered.length }, undefined, 'mcp-client')
      appendWorkflowEvent(run, 'mcp_tools_discovered', `Discovered ${discovered.length} MCP tools from the server.`, { tools: discovered.map((tool) => tool.name) }, undefined, 'mcp-client')
    } catch (error) {
      return failWorkflow(run, response, error, 'The MCP server could not be reached; no simulated data was substituted.')
    }

    const readTools = discovered.filter((tool) => ['get_ticket', 'list_tickets', 'search_knowledge_base'].includes(tool.name) && tool.annotations?.readOnlyHint === true)
    let selected: { name: string; args: Record<string, unknown> } | undefined
    let selectionError = ''
    for (let attempt = 0; attempt < 2 && !selected; attempt += 1) {
      appendWorkflowEvent(run, 'ollama_tool_selection_started', `Asking ${ollama.model} to select one discovered read-only MCP tool${attempt ? ' (correction attempt)' : ''}.`, { attempt: attempt + 1, tools: readTools.map((tool) => tool.name) }, undefined, 'ollama')
      try {
        const candidate = await ollama.selectReadTool({
          request: triage.input.request,
          ticketId: triage.input.ticketId,
          tools: readTools,
          ...(attempt ? { correction: `The previous selection was invalid: ${selectionError}. Select a valid discovered read-only tool and arguments.` } : {}),
        })
        const tool = readTools.find((entry) => entry.name === candidate.tool)
        if (!tool) throw new Error(`Selected tool "${candidate.tool}" is not an available discovered read-only tool.`)
        validateJsonSchema(tool.inputSchema, candidate.arguments)
        validateSelectionArguments(tool, candidate.arguments, triage.input.ticketId)
        selected = { name: tool.name, args: candidate.arguments }
        appendWorkflowEvent(run, 'mcp_arguments_validated', `Validated arguments for ${tool.name}.`, { tool: tool.name, arguments: candidate.arguments }, undefined, 'mcp-client')
      } catch (error) {
        if (error instanceof OllamaError && !['INVALID_MODEL_OUTPUT', 'MALFORMED_RESPONSE'].includes(error.code)) {
          return failWorkflow(run, response, error, 'Workflow stopped because local tool selection failed.')
        }
        selectionError = errorMessage(error)
        appendWorkflowEvent(run, 'ollama_tool_selection_invalid', `Tool selection attempt ${attempt + 1} was rejected: ${selectionError}`, { attempt: attempt + 1 }, undefined, 'ollama')
      }
    }
    if (!selected) return failWorkflow(run, response, new Error(`The model could not produce a valid read-only MCP tool request after one correction: ${selectionError}`), 'Workflow stopped safely; no MCP call or policy action was executed.')

    let retrieved: unknown
    try {
      appendWorkflowEvent(run, 'tool_requested', `Invoking discovered MCP tool ${selected.name}.`, { tool: selected.name, arguments: selected.args }, undefined, 'mcp-client')
      const toolResult = await mcp.callTool(selected.name, selected.args)
      retrieved = extractToolValue(toolResult)
      if (selected.name === 'get_ticket') {
        if (!isRecord(retrieved) || !isRecord(retrieved.ticket)) throw new Error('MCP get_ticket did not return a ticket object.')
        triage.ticket = normalizeTicket(retrieved.ticket, triage.input.ticketId)
      }
      appendWorkflowEvent(run, 'tool_result', `MCP tool ${selected.name} returned successfully.`, { tool: selected.name, resultStatus: 'success' }, undefined, 'mcp-server')
    } catch (error) {
      appendWorkflowEvent(run, 'mcp_tool_failed', `MCP tool ${selected.name} failed: ${errorMessage(error)}`, { tool: selected.name, code: error instanceof McpClientError ? error.code : 'MCP_TOOL_ERROR' }, undefined, 'mcp-server')
      return failWorkflow(run, response, error, 'Workflow stopped without substituting demonstration tool results.')
    }

    appendWorkflowEvent(run, 'ollama_request_started', `Requesting a local assessment from ${ollama.model} using the actual MCP result.`, { model: ollama.model, tool: selected.name }, undefined, 'ollama')
    try {
      run.assessment = await ollama.generateTriage({
        request: triage.input.request,
        ticket: triage.ticket ? structuredClone(triage.ticket) : null,
        toolName: selected.name,
        toolResult: retrieved,
        decisions: triage.decisions,
      })
      appendWorkflowEvent(run, 'ollama_response_received', `Received a structured assessment from ${run.assessment.model}.`, {
        model: run.assessment.model,
        needsClarification: run.assessment.needsClarification,
      }, undefined, 'ollama')
    } catch (error) {
      const ollamaError = error instanceof OllamaError
        ? error
        : new OllamaError('The local model request failed unexpectedly.', 'OLLAMA_HTTP_ERROR', 502)
      appendWorkflowEvent(run, 'ollama_error', ollamaError.message, { code: ollamaError.code }, undefined, 'ollama')
      completeWorkflow(run, 'failed', 'Workflow stopped before policy evaluation because local AI assessment failed.')
      return response.status(ollamaError.httpStatus).json({
        error: ollamaError.message,
        code: ollamaError.code,
        workflowId: id,
        workflow: publicWorkflow(run),
        triage,
      })
    }

    const decision = evaluator(action)
    run.policyDecision = structuredClone(decision)
    appendWorkflowEvent(run, 'policy_evaluated', `${decision.outcome}: ${decision.reason}`, { outcome: decision.outcome, reason: decision.reason }, undefined, 'policy-engine')
    if (decision.outcome === 'BLOCK') {
      appendWorkflowEvent(run, 'action_blocked', 'The proposed operation was blocked and was not executed.', { outcome: decision.outcome }, undefined, 'policy-engine')
      completeWorkflow(run, 'blocked', 'Workflow completed after policy blocked the proposed action.')
      return response.status(200).json({ workflow: publicWorkflow(run), triage, decision, assessment: run.assessment, executed: false })
    }
    if (decision.outcome === 'REQUIRE_APPROVAL') {
      const approvalId = randomUUID()
      const created = timestamp()
      const approval: ApprovalRecord = {
        id: approvalId, action: structuredClone(action as ProposedAction), status: 'pending',
        createdAt: created, updatedAt: created, decision: structuredClone(decision), workflowId: id,
      }
      state.approvals.set(approvalId, approval)
      run.status = 'pending_approval'
      run.approvalId = approvalId
      appendWorkflowEvent(run, 'approval_requested', `Approval requested for ${(action as ProposedAction).type}.`, { status: 'pending' }, approvalId, 'policy-engine')
      return response.status(201).json({ workflow: publicWorkflow(run), triage, decision, assessment: run.assessment, approval: publicApproval(approval), executed: false })
    }

    try {
      const result = await executeMcpAction(mcp, action as ProposedAction, (type, message, data) => appendWorkflowEvent(run, type, message, data, undefined, type === 'tool_result' ? 'mcp-server' : 'mcp-client'))
      run.result = result
      appendWorkflowEvent(run, 'action_executed', `Executed allowed ${(action as ProposedAction).type} through the MCP server.`, { result }, undefined, 'mcp-server')
      completeWorkflow(run, 'completed', 'Workflow completed after the allowed action executed successfully.')
      return response.status(200).json({ workflow: publicWorkflow(run), triage, decision, assessment: run.assessment, result, executed: true })
    } catch (error) {
      appendWorkflowEvent(run, 'mcp_tool_failed', errorMessage(error), { code: error instanceof McpClientError ? error.code : 'MCP_TOOL_ERROR' }, undefined, 'mcp-server')
      completeWorkflow(run, 'failed', 'Workflow completed without execution because the MCP action failed.')
      return response.status(502).json({ workflow: publicWorkflow(run), triage, decision, assessment: run.assessment, error: errorMessage(error), executed: false })
    }
  })

  app.get('/api/workflows/:workflowId', (request, response) => {
    if (!isUuid(request.params.workflowId)) return response.status(400).json({ error: 'Workflow ID must be a UUID.' })
    const run = state.workflows.get(request.params.workflowId)
    if (!run) return response.status(404).json({ error: 'Workflow was not found.' })
    return response.json({ workflow: publicWorkflow(run), triage: run.triage, assessment: run.assessment, decision: run.policyDecision })
  })

  app.post('/api/policy/evaluate', (request, response) => {
    if (!isPlainObject(request.body) || !hasOnlyKeys(request.body, ['action'])) {
      return response.status(400).json({ error: 'Body must contain only an action object.' })
    }
    const decision = evaluator(request.body.action)
    recordEvent('policy_evaluated', `${decision.outcome}: ${decision.reason}`)
    return response.json({ decision })
  })

  app.post('/api/approvals', (request, response) => {
    if (!isPlainObject(request.body) || !hasOnlyKeys(request.body, ['action']) || !('action' in request.body)) {
      return response.status(400).json({ error: 'Body must contain only an action object.' })
    }
    let action: ProposedAction
    try {
      const parsed = parseProposedAction(request.body.action)
      if (parsed.type === 'unknown') {
        const decision = evaluator(request.body.action)
        recordEvent('policy_evaluated', `${decision.outcome}: ${decision.reason}`)
        return response.status(403).json({ decision })
      }
      action = parsed
    } catch (error) {
      return response.status(400).json({ error: errorMessage(error) })
    }

    const decision = evaluator(action)
    recordEvent('policy_evaluated', `${decision.outcome}: ${decision.reason}`)
    if (decision.outcome === 'BLOCK') return response.status(403).json({ decision })
    if (decision.outcome === 'ALLOW') return response.status(409).json({ decision, error: 'This action is allowed directly and does not need an approval.' })

    const id = randomUUID()
    const createdAt = timestamp()
    const record: ApprovalRecord = {
      id,
      action: structuredClone(action),
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
      decision: structuredClone(decision),
    }
    state.approvals.set(id, record)
    recordEvent('approval_requested', `Approval requested for ${action.type}.`, id)
    return response.status(201).json({ approval: publicApproval(record) })
  })

  app.get('/api/approvals/:approvalId', (request, response) => {
    if (!isUuid(request.params.approvalId)) return response.status(400).json({ error: 'Approval ID must be a UUID.' })
    const record = state.approvals.get(request.params.approvalId)
    if (!record) return response.status(404).json({ error: 'Approval was not found.' })
    return response.json({ approval: publicApproval(record) })
  })

  app.post('/api/approvals/:approvalId/decision', (request, response) => {
    if (!isUuid(request.params.approvalId)) return response.status(400).json({ error: 'Approval ID must be a UUID.' })
    if (!isPlainObject(request.body) || !hasOnlyKeys(request.body, ['decision']) || !['approve', 'reject'].includes(String(request.body.decision))) {
      return response.status(400).json({ error: 'Body must contain only decision: approve or reject.' })
    }
    const record = state.approvals.get(request.params.approvalId)
    if (!record) return response.status(404).json({ error: 'Approval was not found.' })
    if (record.status !== 'pending') return response.status(409).json({ error: `Approval is already ${record.status}.`, approval: publicApproval(record) })

    if (request.body.decision === 'reject') {
      record.status = 'rejected'
      record.updatedAt = timestamp()
      const run = record.workflowId ? state.workflows.get(record.workflowId) : undefined
      if (run) {
        appendWorkflowEvent(run, 'approval_rejected', 'Action rejected; it cannot be executed.', { status: 'rejected' }, record.id, 'human')
        completeWorkflow(run, 'rejected', 'Workflow completed after the proposed action was rejected.')
      } else recordEvent('approval_rejected', 'Action rejected; it cannot be executed.', record.id)
      return response.json({ approval: publicApproval(record), executed: false, ...(run ? { workflow: publicWorkflow(run) } : {}) })
    }

    const currentDecision = evaluator(record.action)
    record.decision = structuredClone(currentDecision)
    const approvalWorkflow = record.workflowId ? state.workflows.get(record.workflowId) : undefined
    if (approvalWorkflow) approvalWorkflow.policyDecision = structuredClone(currentDecision)
    if (approvalWorkflow) appendWorkflowEvent(approvalWorkflow, 'policy_evaluated', `${currentDecision.outcome}: ${currentDecision.reason}`, { outcome: currentDecision.outcome, reason: currentDecision.reason, phase: 'approval_revalidation' }, record.id, 'policy-engine')
    else recordEvent('policy_evaluated', `${currentDecision.outcome}: ${currentDecision.reason}`, record.id, undefined, 'policy-engine', { outcome: currentDecision.outcome, reason: currentDecision.reason, phase: 'approval_revalidation' })
    if (currentDecision.outcome === 'BLOCK') {
      record.status = 'blocked'
      record.updatedAt = timestamp()
      const run = record.workflowId ? state.workflows.get(record.workflowId) : undefined
      if (run) {
        appendWorkflowEvent(run, 'action_blocked', `Approval refused by current policy: ${currentDecision.reason}`, { outcome: 'BLOCK' }, record.id, 'policy-engine')
        completeWorkflow(run, 'blocked', 'Workflow completed after policy blocked the approved action.')
      } else recordEvent('approval_blocked', `Approval refused by current policy: ${currentDecision.reason}`, record.id)
      return response.status(403).json({ approval: publicApproval(record), decision: currentDecision, error: 'Current policy blocks this action.', ...(run ? { workflow: publicWorkflow(run) } : {}) })
    }
    if (currentDecision.outcome !== 'REQUIRE_APPROVAL') {
      record.status = 'blocked'
      record.updatedAt = timestamp()
      const run = record.workflowId ? state.workflows.get(record.workflowId) : undefined
      if (run) {
        appendWorkflowEvent(run, 'action_blocked', 'Policy changed; create a new action request under the current policy.', { outcome: currentDecision.outcome }, record.id, 'policy-engine')
        completeWorkflow(run, 'blocked', 'Workflow completed after the pending action was invalidated by policy.')
      } else recordEvent('approval_invalidated', 'Policy changed; create a new action request under the current policy.', record.id)
      return response.status(409).json({ approval: publicApproval(record), decision: currentDecision, error: 'The action no longer requires approval; this pending request cannot authorize it.', ...(run ? { workflow: publicWorkflow(run) } : {}) })
    }

    record.status = 'approved'
    record.updatedAt = timestamp()
    const run = record.workflowId ? state.workflows.get(record.workflowId) : undefined
    if (run) {
      run.status = 'approved'
      appendWorkflowEvent(run, 'approval_granted', 'Action approved; execution is still a separate request.', { status: 'approved' }, record.id, 'human')
    } else recordEvent('approval_granted', 'Action approved; execution is still a separate request.', record.id)
    return response.json({ approval: publicApproval(record), executed: false, ...(run ? { workflow: publicWorkflow(run) } : {}) })
  })

  app.post('/api/actions/execute', async (request, response) => {
    if (!isPlainObject(request.body)) return response.status(400).json({ error: 'Body must be an object.' })

    if (hasOnlyKeys(request.body, ['approvalId']) && typeof request.body.approvalId === 'string') {
      if (!isUuid(request.body.approvalId)) return response.status(400).json({ error: 'Approval ID must be a UUID.' })
      const record = state.approvals.get(request.body.approvalId)
      if (!record) return response.status(404).json({ error: 'Approval was not found.' })
      if (record.status === 'executed') return response.status(409).json({ error: 'Approved action has already been executed.', approval: publicApproval(record) })
      if (record.status !== 'approved') return response.status(record.status === 'blocked' ? 403 : 409).json({ error: `Action cannot execute while approval is ${record.status}.`, approval: publicApproval(record) })

      const currentDecision = evaluator(record.action)
      record.decision = structuredClone(currentDecision)
      const executionWorkflow = record.workflowId ? state.workflows.get(record.workflowId) : undefined
      if (executionWorkflow) executionWorkflow.policyDecision = structuredClone(currentDecision)
      if (executionWorkflow) appendWorkflowEvent(executionWorkflow, 'policy_evaluated', `${currentDecision.outcome}: ${currentDecision.reason}`, { outcome: currentDecision.outcome, reason: currentDecision.reason, phase: 'execution_revalidation' }, record.id, 'policy-engine')
      else recordEvent('policy_evaluated', `${currentDecision.outcome}: ${currentDecision.reason}`, record.id, undefined, 'policy-engine', { outcome: currentDecision.outcome, reason: currentDecision.reason, phase: 'execution_revalidation' })
      if (currentDecision.outcome === 'BLOCK') {
        record.status = 'blocked'
        record.updatedAt = timestamp()
        const run = record.workflowId ? state.workflows.get(record.workflowId) : undefined
        if (run) {
          appendWorkflowEvent(run, 'execution_blocked', `Policy revalidation blocked execution: ${currentDecision.reason}`, { outcome: 'BLOCK' }, record.id, 'policy-engine')
          completeWorkflow(run, 'blocked', 'Workflow completed without execution after policy revalidation blocked the action.')
        } else recordEvent('execution_blocked', `Policy revalidation blocked execution: ${currentDecision.reason}`, record.id)
        return response.status(403).json({ decision: currentDecision, approval: publicApproval(record), executed: false, ...(run ? { workflow: publicWorkflow(run) } : {}) })
      }
      if (currentDecision.outcome === 'REQUIRE_APPROVAL' && record.status !== 'approved') {
        return response.status(409).json({ decision: currentDecision, error: 'Approval is required before execution.' })
      }
      const run = record.workflowId ? state.workflows.get(record.workflowId) : undefined
      try {
        const result = await executeMcpAction(mcp, record.action, (type, message, data) => {
          if (run) appendWorkflowEvent(run, type, message, data, record.id, type === 'tool_result' ? 'mcp-server' : 'mcp-client')
        })
        record.status = 'executed'
        record.updatedAt = timestamp()
        record.result = result
        if (run) {
          run.result = result
          appendWorkflowEvent(run, 'action_executed', `Executed approved ${record.action.type} through the MCP server.`, { result }, record.id, 'mcp-server')
          completeWorkflow(run, 'completed', 'Workflow completed after approval and successful execution.')
        } else recordEvent('action_executed', `Executed approved ${record.action.type}.`, record.id)
        return response.json({ approval: publicApproval(record), result, executed: true, ...(run ? { workflow: publicWorkflow(run) } : {}) })
      } catch (error) {
        record.status = 'blocked'
        record.updatedAt = timestamp()
        if (run) {
          appendWorkflowEvent(run, 'mcp_tool_failed', errorMessage(error), { code: error instanceof McpClientError ? error.code : 'MCP_TOOL_ERROR' }, record.id, 'mcp-server')
          completeWorkflow(run, 'failed', 'Workflow completed without execution because the MCP write failed.')
        } else recordEvent('mcp_tool_failed', errorMessage(error), record.id)
        return response.status(502).json({ error: errorMessage(error), approval: publicApproval(record), executed: false, ...(run ? { workflow: publicWorkflow(run) } : {}) })
      }
    }

    if (!hasOnlyKeys(request.body, ['action']) || !('action' in request.body)) {
      return response.status(400).json({ error: 'Provide only an action or an approvalId.' })
    }
    let action: ProposedAction
    try {
      const parsed = parseProposedAction(request.body.action)
      if (parsed.type === 'unknown') {
        const decision = evaluator(request.body.action)
        return response.status(403).json({ decision, executed: false })
      }
      action = parsed
    } catch (error) {
      return response.status(400).json({ error: errorMessage(error) })
    }
    const decision = evaluator(action)
    recordEvent('policy_evaluated', `${decision.outcome}: ${decision.reason}`)
    if (decision.outcome === 'BLOCK') return response.status(403).json({ decision, executed: false })
    if (decision.outcome === 'REQUIRE_APPROVAL') return response.status(409).json({ decision, error: 'Create and approve a pending request before executing this action.', executed: false })
    let result: unknown
    try { result = await executeMcpAction(mcp, action, (type, message) => recordEvent(type, message)) }
    catch (error) { return response.status(502).json({ decision, error: errorMessage(error), executed: false }) }
    recordEvent('action_executed', `Executed allowed ${action.type}.`)
    return response.json({ decision, result, executed: true })
  })

  app.get('/api/events', (_request, response) => response.json({ events: state.events.map((event) => ({ ...event })) }))

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Request body must be valid JSON.' })
    return response.status(500).json({ error: 'Unexpected API error.' })
  }
  app.use(errorHandler)
  return app
}

async function executeMcpAction(mcp: McpAdapter, action: ProposedAction, record: (type: string, message: string, data?: Record<string, unknown>) => void): Promise<unknown> {
  let name: string
  let args: Record<string, unknown>
  if (action.type === 'read_ticket') {
    name = 'get_ticket'; args = { ticketId: action.ticketId }
  } else if (action.type === 'search_knowledge_base') {
    name = 'search_knowledge_base'; args = { query: action.query }
  } else if (action.type === 'update_ticket_priority') {
    name = 'update_ticket_priority'; args = { ticketId: action.ticketId, priority: action.priority }
  } else {
    throw new Error('Blocked actions cannot be executed.')
  }
  record('tool_requested', `Invoking MCP tool ${name} after policy authorization.`, { tool: name, arguments: args })
  const response = await mcp.callTool(name, args)
  const value = extractToolValue(response)
  record('tool_result', `MCP tool ${name} returned successfully.`, { tool: name, resultStatus: 'success' })
  return value
}

function validateSelectionArguments(tool: DiscoveredMcpTool, args: Record<string, unknown>, ticketId: string): void {
  if (tool.name === 'get_ticket' && (Object.keys(args).length !== 1 || args.ticketId !== ticketId)) throw new Error('get_ticket must use only the workflow ticketId.')
  if (tool.name === 'list_tickets' && Object.keys(args).length !== 0) throw new Error('list_tickets takes no arguments.')
  if (tool.name === 'search_knowledge_base' && (Object.keys(args).length !== 1 || typeof args.query !== 'string' || args.query.trim().length < 2 || args.query.length > 200)) throw new Error('search_knowledge_base requires only a query of 2 to 200 characters.')
}

function extractToolValue(result: { structuredContent?: unknown; content: Array<{ type: string; text?: string }> }): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent
  const text = result.content.find((item) => item.type === 'text')?.text
  if (!text) throw new Error('MCP tool returned no structured or text result.')
  try { return JSON.parse(text) as unknown } catch { return { text } }
}

function normalizeTicket(value: Record<string, unknown>, expectedId: string): DemoTicket {
  if (value.id !== expectedId || typeof value.subject !== 'string' || !['refund', 'account_access', 'damaged_delivery', 'general'].includes(String(value.issueType)) || !['single_customer', 'multiple_customers', 'business_blocking'].includes(String(value.customerImpact)) || typeof value.daysWaiting !== 'number' || !Number.isInteger(value.daysWaiting) || value.daysWaiting < 0 || value.daysWaiting > 60 || (value.status !== 'open' && value.status !== 'pending')) {
    throw new Error('MCP get_ticket returned a ticket that did not match the expected demonstration shape.')
  }
  return value as unknown as DemoTicket
}

function publicApproval(record: ApprovalRecord): ApprovalRecord {
  return structuredClone(record)
}

function publicWorkflow(record: WorkflowRunRecord): WorkflowRunRecord {
  return structuredClone(record)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Invalid request.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

