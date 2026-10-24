/**
 * Jev-inspired decision simulator. This is deterministic project code, not the
 * Jev API, SDK, or Jev model. These interfaces are illustrative only.
 */

export type NoulDecision = {
  type: 'noul'
  value: boolean
  simulated: true
}

export type ChoiceDecision<T extends string> = {
  type: 'choice'
  value: T
  options: readonly T[]
  simulated: true
}

export type ScoreDecision = {
  type: 'score'
  value: number
  scale: { min: number; max: number }
  simulated: true
}

export type IssueType = 'refund' | 'account_access' | 'damaged_delivery' | 'general'
export type CustomerImpact = 'single_customer' | 'multiple_customers' | 'business_blocking'
export type Department = 'billing' | 'technical_support' | 'shipping' | 'general_support'
export type Urgency = 'normal' | 'urgent'

export interface DecisionInput {
  issueType: IssueType
  customerImpact: CustomerImpact
  daysWaiting: number
}

export interface TriageDecisions {
  department: ChoiceDecision<Department>
  urgency: NoulDecision
  severity: ScoreDecision
}

export const DEPARTMENTS: readonly Department[] = [
  'billing', 'technical_support', 'shipping', 'general_support',
]

const ISSUE_DEPARTMENT: Record<IssueType, Department> = {
  refund: 'billing',
  account_access: 'technical_support',
  damaged_delivery: 'shipping',
  general: 'general_support',
}

const ISSUE_SEVERITY: Record<IssueType, number> = {
  refund: 1,
  account_access: 1,
  damaged_delivery: 2,
  general: 0,
}

const IMPACT_SEVERITY: Record<CustomerImpact, number> = {
  single_customer: 0,
  multiple_customers: 1,
  business_blocking: 2,
}

export function validateDecisionInput(value: unknown): DecisionInput {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Decision input must be an object.')
  }
  const input = value as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(ISSUE_DEPARTMENT, String(input.issueType))) {
    throw new Error('Issue type is not supported.')
  }
  if (!Object.prototype.hasOwnProperty.call(IMPACT_SEVERITY, String(input.customerImpact))) {
    throw new Error('Customer impact is not supported.')
  }
  if (typeof input.daysWaiting !== 'number' || !Number.isInteger(input.daysWaiting) || input.daysWaiting < 0 || input.daysWaiting > 60) {
    throw new Error('Days waiting must be a whole number from 0 to 60.')
  }
  return {
    issueType: input.issueType as IssueType,
    customerImpact: input.customerImpact as CustomerImpact,
    daysWaiting: input.daysWaiting,
  }
}

export function simulateDecisions(value: unknown): TriageDecisions {
  const input = validateDecisionInput(value)
  const severity = Math.min(
    3,
    ISSUE_SEVERITY[input.issueType] + IMPACT_SEVERITY[input.customerImpact] + (input.daysWaiting >= 7 ? 1 : 0),
  )

  return {
    department: {
      type: 'choice',
      value: ISSUE_DEPARTMENT[input.issueType],
      options: DEPARTMENTS,
      simulated: true,
    },
    urgency: { type: 'noul', value: severity >= 2 || input.daysWaiting >= 5, simulated: true },
    severity: { type: 'score', value: severity, scale: { min: 0, max: 3 }, simulated: true },
  }
}
