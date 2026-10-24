import { simulateDecisions, validateDecisionInput, type DecisionInput, type TriageDecisions } from './decision-simulator'
import { DEMO_TICKETS, type DemoTicket } from './demo-data'

export interface WorkflowInput extends DecisionInput {
  ticketId: string
  request: string
}

export type WorkflowEventType =
  | 'task_received'
  | 'decisions_generated'
  | 'tool_requested'
  | 'tool_result'
  | 'policy_evaluated'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_rejected'
  | 'action_executed'
  | 'action_blocked'
  | 'demo_action_illustrated'
  | 'workflow_completed'

export type WorkflowEventOrigin = 'workflow' | 'decision-simulator' | 'mcp-demo' | 'mcp-client' | 'ollama' | 'policy-preview' | 'policy-engine' | 'human' | 'api' | 'browser-demo'

export interface WorkflowEvent {
  id: string
  type: WorkflowEventType
  origin: WorkflowEventOrigin
  timestamp: string
  message: string
  data?: Record<string, unknown>
}

export interface WorkflowResult {
  status: 'completed' | 'ticket_not_found'
  input: WorkflowInput
  decisions: TriageDecisions
  ticket?: DemoTicket
  recommendation: string
  events: WorkflowEvent[]
}

export function validateWorkflowInput(value: unknown): WorkflowInput {
  if (typeof value !== 'object' || value === null) throw new Error('Workflow input must be an object.')
  const input = value as Record<string, unknown>
  if (typeof input.ticketId !== 'string' || !/^TK-\d{4}$/.test(input.ticketId)) {
    throw new Error('Ticket ID must use the format TK-0000.')
  }
  if (typeof input.request !== 'string' || input.request.trim().length < 3 || input.request.length > 500) {
    throw new Error('Request must contain 3 to 500 characters.')
  }
  const decisionsInput = validateDecisionInput(input)
  return { ticketId: input.ticketId, request: input.request.trim(), ...decisionsInput }
}

export function runTriageWorkflow(
  value: unknown,
  now: () => Date = () => new Date(),
  options: { deferFinalEvent?: boolean; liveMcp?: boolean } = {},
): WorkflowResult {
  const input = validateWorkflowInput(value)
  const events: WorkflowEvent[] = []
  let sequence = 0
  const record = (type: WorkflowEventType, origin: WorkflowEventOrigin, message: string, data?: Record<string, unknown>) => {
    sequence += 1
    events.push({ id: `event-${sequence}`, type, origin, timestamp: now().toISOString(), message, ...(data ? { data } : {}) })
  }

  record('task_received', 'workflow', `Received triage request for ${input.ticketId}.`, { ticketId: input.ticketId })
  const decisions = simulateDecisions(input)
  record('decisions_generated', 'decision-simulator', 'Generated deterministic simulated department, urgency, and severity decisions.', {
    department: decisions.department.value,
    urgent: decisions.urgency.value,
    severity: decisions.severity.value,
  })
  const ticket = options.liveMcp ? undefined : DEMO_TICKETS.find((candidate) => candidate.id === input.ticketId)

  if (options.liveMcp) {
    return { status: 'completed', input, decisions, recommendation: 'Waiting for the live MCP tool result.', events }
  }

  record('tool_requested', 'mcp-demo', 'Demonstration MCP request: get_ticket.', { tool: 'get_ticket', ticketId: input.ticketId, simulated: true })

  if (!ticket) {
    record('tool_result', 'mcp-demo', `No demonstration ticket found for ${input.ticketId}.`, { found: false })
    if (!options.deferFinalEvent) {
      record('policy_evaluated', 'policy-preview', 'Policy evaluation is reserved for Phase 3.', { status: 'not_implemented' })
      record('workflow_completed', 'workflow', 'Workflow completed with a missing-ticket result.', { status: 'ticket_not_found' })
    }
    return { status: 'ticket_not_found', input, decisions, recommendation: 'No matching demonstration ticket was found. Check the ticket ID before taking action.', events }
  }

  record('tool_result', 'mcp-demo', `Retrieved ${ticket.id}: ${ticket.subject}.`, { found: true, ticketId: ticket.id, simulated: true })
  if (!options.deferFinalEvent) record('policy_evaluated', 'policy-preview', 'Policy evaluation is reserved for Phase 3; no action was executed.', { status: 'not_implemented' })
  const urgencyText = decisions.urgency.value ? 'prioritize a timely follow-up' : 'continue with the standard response queue'
  const recommendation = `Route to ${formatDepartment(decisions.department.value)}, ${urgencyText}, and review the ticket history before taking action.`
  if (!options.deferFinalEvent) record('workflow_completed', 'workflow', 'Triage demonstration completed; no ticket data was changed.', { status: 'completed' })
  return { status: 'completed', input, decisions, ticket, recommendation, events }
}

function formatDepartment(value: string): string {
  return value.split('_').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')
}
