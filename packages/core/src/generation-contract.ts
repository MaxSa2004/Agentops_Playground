/** Structured, user-facing output from local generative AI. */
export interface GeneratedTriageAssessment {
  summary: string
  recommendation: string
  explanation: string
  needsClarification: boolean
  clarifyingQuestion: string | null
  model: string
  origin: 'ollama'
}
