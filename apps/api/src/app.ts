import { randomUUID } from 'node:crypto'
import express, { type ErrorRequestHandler } from 'express'
import { evaluatePolicy, parseProposedAction, runTriageWorkflow, type GeneratedTriageAssessment, type PolicyDecision, type ProposedAction, type WorkflowEvent, type WorkflowInput, type WorkflowResult } from '@agentops/core'
import { DEMO_TICKETS } from '@agentops/core'
import { createOllamaAdapter, OllamaError, type OllamaAdapter } from './ollama'

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

interface TicketRecord {
  id: string
  subject: string
  status: string
  priority: string
}

export interface ApiState {
  approvals: Map<string, ApprovalRecord>
  workflows: Map<string, WorkflowRunRecord>
  tickets: Map<string, TicketRecord>
  events: ApiEvent[]
}

export interface AppOptions {
  policyEvaluator?: (action: unknown) => PolicyDecision
  state?: ApiState
  now?: () => Date
  ollamaAdapter?: OllamaAdapter
}

export function createApiState(): ApiState {
  return {
    approvals: new Map(),
    workflows: new Map(),
    tickets: new Map(DEMO_TICKETS.map((ticket) => [ticket.id, {
      id: ticket.id, subject: ticket.subject, status: ticket.status, priority: 'normal',
    }])),
    events: [],
  }
}

export function createApp(options: AppOptions = {}) {
  const app = express()
  const state = options.state ?? createApiState()
  const evaluator = options.policyEvaluator ?? evaluatePolicy
  const ollama = options.ollamaAdapter ?? createOllamaAdapter()
  const now = options.now ?? (() => new Date())
  const timestamp = () => now().toISOString()
  const recordEvent = (type: string, message: string, approvalId?: string, workflowId?: string) => {
    const event = { id: randomUUID(), type, timestamp: timestamp(), message, ...(approvalId ? { approvalId } : {}), ...(workflowId ? { workflowId } : {}) }
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

  app.use(express.json({ limit: '16kb' }))

  app.get('/api/health', async (_request, response) => {
    const ollamaStatus = await ollama.status()
    return response.json({ status: 'ok', mode: 'local-api', ollama: ollamaStatus })
  })

  app.post('/api/workflows', async (request, response) => {
    if (!isPlainObject(request.body) || !hasOnlyKeys(request.body, ['input', 'action']) || !('input' in request.body) || !('action' in request.body)) {
      return response.status(400).json({ error: 'Body must contain only input and action.' })
    }
    let triage: WorkflowResult
    let action: ProposedAction | { type: 'unknown'; operation: string }
    try {
      triage = runTriageWorkflow(request.body.input, now, { deferFinalEvent: true })
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

    appendWorkflowEvent(run, 'ollama_request_started', `Requesting a local assessment from ${ollama.model}.`, { model: ollama.model }, undefined, 'ollama')
    try {
      const storedTicket = triage.ticket ? state.tickets.get(triage.ticket.id) : undefined
      run.assessment = await ollama.generateTriage({
        request: triage.input.request,
        ticket: triage.ticket ? structuredClone(triage.ticket) : null,
        ...(storedTicket ? { ticketPriority: storedTicket.priority } : {}),
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
      const result = executeAction(state, action as ProposedAction)
      run.result = result
      appendWorkflowEvent(run, 'action_executed', `Executed allowed ${(action as ProposedAction).type}.`, { result }, undefined, 'api')
      completeWorkflow(run, 'completed', 'Workflow completed after the allowed action executed successfully.')
      return response.status(200).json({ workflow: publicWorkflow(run), triage, decision, assessment: run.assessment, result, executed: true })
    } catch (error) {
      appendWorkflowEvent(run, 'action_blocked', errorMessage(error), { outcome: 'BLOCK' }, undefined, 'policy-engine')
      completeWorkflow(run, 'blocked', 'Workflow completed without execution because the action could not be applied.')
      return response.status(409).json({ workflow: publicWorkflow(run), triage, decision, assessment: run.assessment, error: errorMessage(error), executed: false })
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

  app.post('/api/actions/execute', (request, response) => {
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
        const result = executeAction(state, record.action)
        record.status = 'executed'
        record.updatedAt = timestamp()
        record.result = result
        if (run) {
          run.result = result
          appendWorkflowEvent(run, 'action_executed', `Executed approved ${record.action.type}.`, { result }, record.id, 'api')
          completeWorkflow(run, 'completed', 'Workflow completed after approval and successful execution.')
        } else recordEvent('action_executed', `Executed approved ${record.action.type}.`, record.id)
        return response.json({ approval: publicApproval(record), result, executed: true, ...(run ? { workflow: publicWorkflow(run) } : {}) })
      } catch (error) {
        record.status = 'blocked'
        record.updatedAt = timestamp()
        if (run) {
          appendWorkflowEvent(run, 'action_blocked', errorMessage(error), { outcome: 'BLOCK' }, record.id, 'policy-engine')
          completeWorkflow(run, 'blocked', 'Workflow completed without execution because the approved action could not be applied.')
        }
        return response.status(409).json({ error: errorMessage(error), approval: publicApproval(record), executed: false, ...(run ? { workflow: publicWorkflow(run) } : {}) })
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
    const result = executeAction(state, action)
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

function executeAction(state: ApiState, action: ProposedAction): unknown {
  if (action.type === 'read_ticket') {
    const ticket = state.tickets.get(action.ticketId)
    if (!ticket) throw new Error('Ticket no longer exists.')
    return { ticket: { ...ticket } }
  }
  if (action.type === 'search_knowledge_base') {
    const entries = [
      { title: 'Late delivery refunds', text: 'Review order history and offer the applicable refund option.' },
      { title: 'Account recovery', text: 'Use the verified account recovery steps; never request a password.' },
      { title: 'Damaged items', text: 'Record damage details and route replacement questions to shipping.' },
    ]
    const query = action.query.toLowerCase()
    return { results: entries.filter((entry) => `${entry.title} ${entry.text}`.toLowerCase().includes(query.split(' ')[0])).slice(0, 3) }
  }
  if (action.type === 'update_ticket_priority') {
    const ticket = state.tickets.get(action.ticketId)
    if (!ticket) throw new Error('Ticket no longer exists.')
    ticket.priority = action.priority
    return { ticket: { ...ticket } }
  }
  throw new Error('Blocked actions cannot be executed.')
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

