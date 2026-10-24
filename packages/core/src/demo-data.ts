import type { CustomerImpact, IssueType } from './decision-simulator'

export interface DemoTicket {
  id: string
  subject: string
  issueType: IssueType
  customerImpact: CustomerImpact
  daysWaiting: number
  status: 'open' | 'pending'
}

export const DEMO_TICKETS: readonly DemoTicket[] = [
  { id: 'TK-2048', subject: 'Refund request after delayed delivery', issueType: 'refund', customerImpact: 'single_customer', daysWaiting: 8, status: 'open' },
  { id: 'TK-1982', subject: 'Unable to access account after password reset', issueType: 'account_access', customerImpact: 'single_customer', daysWaiting: 1, status: 'pending' },
  { id: 'TK-2116', subject: 'Item arrived damaged and replacement is delayed', issueType: 'damaged_delivery', customerImpact: 'single_customer', daysWaiting: 3, status: 'open' },
]
