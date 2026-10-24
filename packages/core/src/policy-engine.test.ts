import { describe, expect, it } from 'vitest'
import { evaluatePolicy, parseProposedAction } from './policy-engine'

describe('deterministic policy engine', () => {
  it('allows reading an existing demonstration ticket', () => {
    expect(evaluatePolicy({ type: 'read_ticket', ticketId: 'TK-2048' })).toMatchObject({ outcome: 'ALLOW' })
  })

  it('allows a valid read-only knowledge search', () => {
    expect(evaluatePolicy({ type: 'search_knowledge_base', query: 'late delivery refund' })).toMatchObject({ outcome: 'ALLOW' })
  })

  it('requires approval for ticket priority updates', () => {
    expect(evaluatePolicy({ type: 'update_ticket_priority', ticketId: 'TK-2048', priority: 'high' })).toMatchObject({ outcome: 'REQUIRE_APPROVAL' })
  })

  it('blocks prohibited, unknown, missing-ticket, and malformed operations', () => {
    expect(evaluatePolicy({ type: 'delete_ticket', ticketId: 'TK-2048' })).toMatchObject({ outcome: 'BLOCK' })
    expect(evaluatePolicy({ type: 'run_shell', command: 'anything' })).toMatchObject({ outcome: 'BLOCK' })
    expect(evaluatePolicy({ type: 'read_ticket', ticketId: 'TK-9999' })).toMatchObject({ outcome: 'BLOCK' })
    expect(evaluatePolicy({ type: 'update_ticket_priority', ticketId: 'not-a-ticket', priority: 'high' })).toMatchObject({ outcome: 'BLOCK' })
    expect(evaluatePolicy(null)).toMatchObject({ outcome: 'BLOCK' })
  })

  it('rejects extra or invalid fields when parsing known actions', () => {
    expect(() => parseProposedAction({ type: 'read_ticket', ticketId: 'TK-2048', force: true })).toThrow()
    expect(() => parseProposedAction({ type: 'search_knowledge_base', query: 'x' })).toThrow()
    expect(() => parseProposedAction({ type: 'update_ticket_priority', ticketId: 'TK-2048', priority: 'critical' })).toThrow()
  })
})
