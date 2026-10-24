import { describe, expect, it, vi } from 'vitest'
import { createOllamaAdapter, OllamaError, type TriageGenerationContext } from './ollama'

const context: TriageGenerationContext = {
  request: 'Please review a refund request after a delayed delivery.',
  ticket: {
    id: 'TK-2048', subject: 'Refund request after delayed delivery', issueType: 'refund',
    customerImpact: 'single_customer', daysWaiting: 8, status: 'open',
  },
  ticketPriority: 'normal',
  decisions: {
    department: { type: 'choice', value: 'billing', options: ['billing', 'technical_support', 'shipping', 'general_support'], simulated: true },
    urgency: { type: 'noul', value: true, simulated: true },
    severity: { type: 'score', value: 2, scale: { min: 0, max: 3 }, simulated: true },
  },
}

const validAssessment = {
  summary: 'The customer asks for a refund after a delayed delivery.',
  recommendation: 'Review the supplied ticket history and explain the verified next step.',
  explanation: 'The supplied request and ticket identify a refund question and delayed delivery.',
  needsClarification: false,
  clarifyingQuestion: null,
}

function ollamaResponse(content: unknown, model = 'qwen2.5:1.5b') {
  return new Response(JSON.stringify({ model, done: true, message: { role: 'assistant', content: JSON.stringify(content) } }), { status: 200 })
}

describe('local Ollama adapter', () => {
  it('uses the documented non-streaming chat request and parses a successful assessment', async () => {
    let capturedUrl = ''
    let capturedBody: Record<string, unknown> = {}
    const fetcher: typeof fetch = async (input, init) => {
      capturedUrl = String(input)
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return ollamaResponse(validAssessment)
    }
    const adapter = createOllamaAdapter({ baseUrl: 'http://ollama.test/', model: 'qwen2.5:1.5b', fetcher })

    const result = await adapter.generateTriage(context)

    expect(capturedUrl).toBe('http://ollama.test/api/chat')
    expect(capturedBody).toMatchObject({ model: 'qwen2.5:1.5b', stream: false, format: { type: 'object' } })
    expect(capturedBody.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('TK-2048') }),
    ]))
    expect(result).toEqual({ ...validAssessment, model: 'qwen2.5:1.5b', origin: 'ollama' })
  })

  it('parses a valid ambiguity response without adding confidence or policy fields', async () => {
    const assessment = {
      ...validAssessment,
      needsClarification: true,
      clarifyingQuestion: 'Which order is affected by the delay?',
    }
    const adapter = createOllamaAdapter({ fetcher: async () => ollamaResponse(assessment) })
    const result = await adapter.generateTriage({ ...context, request: 'Please fix the issue with my order.' })
    expect(result.needsClarification).toBe(true)
    expect(result.clarifyingQuestion).toContain('Which order')
    expect(result).not.toHaveProperty('confidence')
    expect(result).not.toHaveProperty('policyDecision')
  })

  it('rejects malformed HTTP JSON and malformed model content', async () => {
    const malformedHttp = createOllamaAdapter({ fetcher: async () => new Response('{', { status: 200 }) })
    await expect(malformedHttp.generateTriage(context)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })

    const malformedContent = createOllamaAdapter({ fetcher: async () => new Response(JSON.stringify({ model: 'qwen2.5:1.5b', done: true, message: { content: 'not JSON' } }), { status: 200 }) })
    await expect(malformedContent.generateTriage(context)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' })
  })

  it('rejects unexpected fields, missing fields, excessive text, and inconsistent clarification output', async () => {
    const invalidOutputs = [
      { ...validAssessment, confidence: 0.99 },
      { ...validAssessment, summary: '' },
      { ...validAssessment, recommendation: 'x'.repeat(801) },
      { ...validAssessment, needsClarification: true },
    ]
    for (const invalid of invalidOutputs) {
      const adapter = createOllamaAdapter({ fetcher: async () => ollamaResponse(invalid) })
      await expect(adapter.generateTriage(context)).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' })
    }
  })

  it('reports an unavailable Ollama server with a useful local-start hint', async () => {
    const adapter = createOllamaAdapter({ fetcher: async () => { throw new TypeError('fetch failed') } })
    await expect(adapter.generateTriage(context)).rejects.toMatchObject({ code: 'OLLAMA_UNAVAILABLE', httpStatus: 503 })
    await expect(adapter.generateTriage(context)).rejects.toThrow('ollama serve')
  })

  it('turns a timed-out request into a 504 Ollama error', async () => {
    const fetcher: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
    const adapter = createOllamaAdapter({ timeoutMs: 5, fetcher })
    await expect(adapter.generateTriage(context)).rejects.toMatchObject({ code: 'OLLAMA_TIMEOUT', httpStatus: 504 })

    const slowBody: typeof fetch = async (_input, init) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
    } as Response)
    const bodyTimeout = createOllamaAdapter({ timeoutMs: 5, fetcher: slowBody })
    await expect(bodyTimeout.generateTriage(context)).rejects.toMatchObject({ code: 'OLLAMA_TIMEOUT', httpStatus: 504 })
  })

  it('distinguishes a missing model and can inspect installed models via /api/tags', async () => {
    const missing = createOllamaAdapter({ fetcher: async () => new Response(JSON.stringify({ error: 'model not found, try pulling it first' }), { status: 404 }) })
    await expect(missing.generateTriage(context)).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND', httpStatus: 503 })

    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ models: [{ name: 'qwen2.5:1.5b' }] }), { status: 200 }))
    const installed = createOllamaAdapter({ fetcher })
    await expect(installed.status()).resolves.toMatchObject({ available: true, modelAvailable: true })
    const absent = createOllamaAdapter({ fetcher: async () => new Response(JSON.stringify({ models: [] }), { status: 200 }) })
    await expect(absent.status()).resolves.toMatchObject({ available: true, modelAvailable: false, message: expect.stringContaining('ollama pull') })
    const invalidList = createOllamaAdapter({ fetcher: async () => new Response('{', { status: 200 }) })
    await expect(invalidList.status()).resolves.toMatchObject({ available: true, modelAvailable: false, message: 'Ollama returned an invalid model list.' })
  })

  it('rejects responses missing the completed chat message fields', async () => {
    const adapter = createOllamaAdapter({ fetcher: async () => new Response(JSON.stringify({ model: 'qwen2.5:1.5b', done: false, message: { content: '{}' } }), { status: 200 }) })
    await expect(adapter.generateTriage(context)).rejects.toBeInstanceOf(OllamaError)
  })

  it('parses structured tool selections and rejects malformed selections', async () => {
    const adapter = createOllamaAdapter({ fetcher: async () => ollamaResponse({ tool: 'get_ticket', arguments: { ticketId: 'TK-2048' } }) })
    await expect(adapter.selectReadTool({ request: 'Find the ticket', ticketId: 'TK-2048', tools: [] })).resolves.toEqual({ tool: 'get_ticket', arguments: { ticketId: 'TK-2048' } })
    const malformed = createOllamaAdapter({ fetcher: async () => ollamaResponse({ tool: 'get_ticket', arguments: [], extra: true }) })
    await expect(malformed.selectReadTool({ request: 'Find the ticket', ticketId: 'TK-2048', tools: [] })).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' })
    const badJson = createOllamaAdapter({ fetcher: async () => new Response(JSON.stringify({ model: 'qwen2.5:1.5b', done: true, message: { content: 'not json' } }), { status: 200 }) })
    await expect(badJson.selectReadTool({ request: 'Find ticket', ticketId: 'TK-2048', tools: [] })).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' })
  })
})
