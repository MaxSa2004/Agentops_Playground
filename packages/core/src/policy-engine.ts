import { DEMO_TICKETS } from './demo-data'

export type PolicyOutcome = 'ALLOW' | 'BLOCK' | 'REQUIRE_APPROVAL'
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'

export type ProposedAction =
  | { type: 'read_ticket'; ticketId: string }
  | { type: 'search_knowledge_base'; query: string }
  | { type: 'update_ticket_priority'; ticketId: string; priority: TicketPriority }
  | { type: 'delete_ticket'; ticketId: string }

export interface PolicyDecision {
  outcome: PolicyOutcome
  reason: string
  action?: ProposedAction
}

const PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent']
const TICKET_ID = /^TK-\d{4}$/

/** Validate known operation payloads while retaining unknown operation names so policy can block them. */
export function parseProposedAction(value: unknown): ProposedAction | { type: 'unknown'; operation: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Action must be an object.')
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.type !== 'string' || raw.type.length < 1 || raw.type.length > 80) {
    throw new Error('Action type must be a non-empty string of at most 80 characters.')
  }

  if (raw.type === 'read_ticket' || raw.type === 'delete_ticket') {
    if (Object.keys(raw).some((key) => !['type', 'ticketId'].includes(key)) || typeof raw.ticketId !== 'string' || !TICKET_ID.test(raw.ticketId)) {
      throw new Error(`${raw.type} requires only a valid ticketId.`)
    }
    return { type: raw.type, ticketId: raw.ticketId }
  }
  if (raw.type === 'search_knowledge_base') {
    if (Object.keys(raw).some((key) => !['type', 'query'].includes(key)) || typeof raw.query !== 'string' || raw.query.trim().length < 2 || raw.query.length > 200) {
      throw new Error('search_knowledge_base requires a query of 2 to 200 characters.')
    }
    return { type: raw.type, query: raw.query.trim() }
  }
  if (raw.type === 'update_ticket_priority') {
    if (Object.keys(raw).some((key) => !['type', 'ticketId', 'priority'].includes(key)) || typeof raw.ticketId !== 'string' || !TICKET_ID.test(raw.ticketId) || !PRIORITIES.includes(raw.priority as TicketPriority)) {
      throw new Error('update_ticket_priority requires only a valid ticketId and priority.')
    }
    return { type: raw.type, ticketId: raw.ticketId, priority: raw.priority as TicketPriority }
  }
  return { type: 'unknown', operation: raw.type }
}

/** Deterministic policy rules; no AI or decision-simulator output is consulted. */
export function evaluatePolicy(value: unknown): PolicyDecision {
  let action: ReturnType<typeof parseProposedAction>
  try {
    action = parseProposedAction(value)
  } catch (error) {
    return { outcome: 'BLOCK', reason: error instanceof Error ? error.message : 'Malformed action.' }
  }

  if (action.type === 'unknown') return { outcome: 'BLOCK', reason: `Operation "${action.operation}" is not authorized.` }
  if (action.type === 'delete_ticket') return { outcome: 'BLOCK', reason: 'Deleting demonstration tickets is hard-prohibited, including with user approval.', action }
  if (action.type === 'read_ticket') {
    if (!DEMO_TICKETS.some((ticket) => ticket.id === action.ticketId)) return { outcome: 'BLOCK', reason: 'Ticket does not exist in the demonstration dataset.', action }
    return { outcome: 'ALLOW', reason: 'Reading an existing fictional support ticket is permitted.', action }
  }
  if (action.type === 'search_knowledge_base') return { outcome: 'ALLOW', reason: 'Searching the fictional support knowledge base is read-only and permitted.', action }
  if (action.type === 'update_ticket_priority') {
    if (!DEMO_TICKETS.some((ticket) => ticket.id === action.ticketId)) return { outcome: 'BLOCK', reason: 'Ticket does not exist in the demonstration dataset.', action }
    return { outcome: 'REQUIRE_APPROVAL', reason: 'Changing ticket priority is a write operation and requires explicit human approval.', action }
  }
  return { outcome: 'BLOCK', reason: 'Operation is not authorized.' }
}
