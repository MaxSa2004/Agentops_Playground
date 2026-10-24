import { describe, expect, it } from 'vitest'
import { simulateDecisions, validateDecisionInput } from './decision-simulator'
import { runTriageWorkflow, validateWorkflowInput, type WorkflowInput } from './workflow'

const baseInput: WorkflowInput = {
  ticketId: 'TK-2048',
  request: 'Please review this customer support ticket.',
  issueType: 'refund',
  customerImpact: 'single_customer',
  daysWaiting: 8,
}

describe('simulated typed decisions', () => {
  it('validates a supported decision input', () => {
    expect(validateDecisionInput({ issueType: 'refund', customerImpact: 'single_customer', daysWaiting: 2 })).toEqual({
      issueType: 'refund', customerImpact: 'single_customer', daysWaiting: 2,
    })
  })

  it('rejects unsupported issue and impact values', () => {
    expect(() => validateDecisionInput({ issueType: 'payments', customerImpact: 'single_customer', daysWaiting: 2 })).toThrow('Issue type')
    expect(() => validateDecisionInput({ issueType: 'refund', customerImpact: 'everyone', daysWaiting: 2 })).toThrow('Customer impact')
  })

  it('rejects out-of-range and fractional wait values', () => {
    for (const daysWaiting of [-1, 61, 1.5, Number.NaN]) {
      expect(() => simulateDecisions({ issueType: 'refund', customerImpact: 'single_customer', daysWaiting })).toThrow('Days waiting')
    }
  })

  it('returns a bounded choice decision for department', () => {
    const { department } = simulateDecisions({ issueType: 'account_access', customerImpact: 'single_customer', daysWaiting: 0 })
    expect(department).toEqual({ type: 'choice', value: 'technical_support', options: ['billing', 'technical_support', 'shipping', 'general_support'], simulated: true })
    expect(department.options).toContain(department.value)
  })

  it('returns a simulated yes/no urgency decision without confidence values', () => {
    const { urgency } = simulateDecisions({ issueType: 'general', customerImpact: 'single_customer', daysWaiting: 0 })
    expect(urgency).toEqual({ type: 'noul', value: false, simulated: true })
    expect(urgency).not.toHaveProperty('confidence')
  })

  it('returns a score within its declared scale', () => {
    const { severity } = simulateDecisions({ issueType: 'damaged_delivery', customerImpact: 'business_blocking', daysWaiting: 9 })
    expect(severity).toEqual({ type: 'score', value: 3, scale: { min: 0, max: 3 }, simulated: true })
  })
})

describe('deterministic support triage workflow', () => {
  it('validates requests and ticket ID format', () => {
    expect(validateWorkflowInput(baseInput)).toEqual(baseInput)
    expect(() => validateWorkflowInput({ ...baseInput, request: ' ' })).toThrow('Request')
    expect(() => validateWorkflowInput({ ...baseInput, request: 'x'.repeat(501) })).toThrow('Request')
    expect(() => validateWorkflowInput({ ...baseInput, ticketId: 'bad-id' })).toThrow('Ticket ID')
  })

  it('triages a refund after a long wait and records observable events', () => {
    const result = runTriageWorkflow(baseInput, fixedClock)
    expect(result.status).toBe('completed')
    expect(result.ticket?.subject).toContain('Refund request')
    expect(result.decisions.department.value).toBe('billing')
    expect(result.decisions.urgency.value).toBe(true)
    expect(result.decisions.severity.value).toBe(2)
    expect(result.events.map((event) => event.type)).toEqual([
      'task_received', 'decisions_generated', 'tool_requested', 'tool_result', 'policy_evaluated', 'workflow_completed',
    ])
    expect(result.events.find((event) => event.type === 'tool_requested')?.data).toMatchObject({ tool: 'get_ticket', simulated: true })
    expect(result.events.find((event) => event.type === 'policy_evaluated')?.data?.status).toBe('not_implemented')
  })

  it('triages account access as normal severity one', () => {
    const result = runTriageWorkflow({ ...baseInput, ticketId: 'TK-1982', issueType: 'account_access', daysWaiting: 1 })
    expect(result.decisions.department.value).toBe('technical_support')
    expect(result.decisions.urgency.value).toBe(false)
    expect(result.decisions.severity.value).toBe(1)
  })

  it('triages damaged delivery and clamps severity to the configured maximum', () => {
    const result = runTriageWorkflow({ ...baseInput, ticketId: 'TK-2116', issueType: 'damaged_delivery', customerImpact: 'business_blocking', daysWaiting: 10 })
    expect(result.decisions.department.value).toBe('shipping')
    expect(result.decisions.severity.value).toBe(3)
    expect(result.decisions.urgency.value).toBe(true)
  })

  it('returns a structured missing-ticket result without claiming a live MCP call', () => {
    const result = runTriageWorkflow({ ...baseInput, ticketId: 'TK-9999' })
    expect(result.status).toBe('ticket_not_found')
    expect(result.ticket).toBeUndefined()
    expect(result.events.some((event) => event.data?.found === false)).toBe(true)
  })
})

function fixedClock(): Date {
  return new Date('2026-10-24T10:42:08.000Z')
}
