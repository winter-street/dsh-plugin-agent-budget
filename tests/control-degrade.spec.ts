import { describe, expect, it } from 'vitest'
import { TestHarness, finish, text, usage } from './helpers.ts'

describe('control config validation', () => {
  it.each([0, 1, -0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid degradeRatio %s',
    (degradeRatio) => {
      expect(() => new TestHarness({ maxTokens: 100, degradeRatio })).toThrow('(0, 1)')
    },
  )

  it('rejects an empty degradeModel', () => {
    expect(() => new TestHarness({ maxTokens: 100, degradeRatio: 0.2, degradeModel: '' }))
      .toThrow('degradeModel')
  })

  it.each([0, -1, 1.5])('rejects invalid maxOutputTokens %s', (maxOutputTokens) => {
    expect(() => new TestHarness({ maxTokens: 100, maxOutputTokens })).toThrow('maxOutputTokens')
  })

  it.each([0, -1, 1.5])('rejects invalid maxConcurrentCalls %s', (maxConcurrentCalls) => {
    expect(() => new TestHarness({ maxTokens: 100, maxConcurrentCalls })).toThrow('maxConcurrentCalls')
  })
})

describe('request degradation', () => {
  it('does not register the request hook without degradeRatio', () => {
    const harness = new TestHarness({ maxTokens: 100 })
    expect(harness.requestHandlers).toHaveLength(0)
  })

  it('returns the identical config object while above the threshold', async () => {
    const harness = new TestHarness({ maxTokens: 100, degradeRatio: 0.2, degradeModel: 'cheap-model' })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 50, outputTokens: 10 }), finish()])

    const result = await harness.request(root, { maxTokens: 5000 })
    expect(result).toBe(harness.lastRequestBase)
  })

  it('does not degrade at the exact threshold boundary', async () => {
    const harness = new TestHarness({ maxTokens: 100, degradeRatio: 0.2 })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 80 }), finish()])

    const result = await harness.request(root, { maxTokens: 5000 })
    expect(result).toBe(harness.lastRequestBase)
  })

  it('clamps maxTokens to the remaining budget and swaps the model', async () => {
    const harness = new TestHarness({ maxTokens: 100, degradeRatio: 0.2, degradeModel: 'cheap-model' })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 80, outputTokens: 5 }), finish()])

    const result = await harness.request(root, { maxTokens: 5000 })
    expect(result).not.toBe(harness.lastRequestBase)
    expect(result).toMatchObject({ model: 'cheap-model', maxTokens: 15 })
  })

  it('tightens maxTokens without touching the model when degradeModel is unset', async () => {
    const harness = new TestHarness({ maxTokens: 100, degradeRatio: 0.2 })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 85 }), finish()])

    const result = await harness.request(root, { maxTokens: 5000 })
    expect(result).toMatchObject({ model: 'mock-model', maxTokens: 15 })
  })

  it('honors the maxOutputTokens hard cap while degraded', async () => {
    const harness = new TestHarness({ maxTokens: 100, degradeRatio: 0.2, maxOutputTokens: 8 })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 85 }), finish()])

    const result = await harness.request(root, { maxTokens: 5000 })
    expect(result).toMatchObject({ maxTokens: 8 })
  })

  it('clamps maxTokens to a floor of one when almost nothing remains', async () => {
    const harness = new TestHarness({ maxTokens: 100, degradeRatio: 0.2 })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 99 }), finish()])

    const result = await harness.request(root, { maxTokens: 5000 })
    expect(result).toMatchObject({ maxTokens: 1 })
  })

  it('returns the identical object when tightening changes nothing', async () => {
    const harness = new TestHarness({ maxTokens: 100, degradeRatio: 0.2 })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 85 }), finish()])

    const result = await harness.request(root, { maxTokens: 10 })
    expect(result).toBe(harness.lastRequestBase)
  })
})

describe('concurrency limit', () => {
  it('rejects calls beyond the per-scope cap and recovers afterwards', async () => {
    const harness = new TestHarness({ maxTokens: 1000, maxConcurrentCalls: 1 })
    const root = harness.root('root')
    const pending = harness.streamHandlers[0]!(
      { provider: 'mock', model: 'mock', messages: [], sessionId: root.id },
      () => (async function* () {
        yield usage({ inputTokens: 10 })
        yield text()
        yield finish()
      })(),
    )
    const iterator = pending[Symbol.asyncIterator]()
    await iterator.next()

    await expect(harness.stream(root, [usage({ inputTokens: 1 }), finish()]))
      .rejects.toMatchObject({ code: 'TOKEN_BUDGET_CONCURRENT_LIMIT' })

    await iterator.next()
    await iterator.next()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })

    const chunks = await harness.stream(root, [usage({ inputTokens: 1 }), finish()])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' })
    expect(await harness.status(root)).toMatchObject({ usedTokens: 11, unmeteredCalls: 0 })
  })

  it('is not swallowed by the request-error handler', async () => {
    const harness = new TestHarness({ maxTokens: 1000, maxConcurrentCalls: 1 })
    const root = harness.root('root')
    const handler = harness.requestErrorHandlers[0]
    if (handler === undefined) throw new Error('request-error handler was not registered')
    const outcome = await handler(
      { failure: { code: 'TOKEN_BUDGET_CONCURRENT_LIMIT' }, agent: { session: root } } as never,
      () => Promise.resolve('delegated'),
    )
    expect(outcome).toBe('delegated')
  })

  it('admits unlimited concurrency when the cap is not configured', async () => {
    const harness = new TestHarness({ maxTokens: 1000 })
    const root = harness.root('root')
    const open = () => harness.streamHandlers[0]!(
      { provider: 'mock', model: 'mock', messages: [], sessionId: root.id },
      () => (async function* () {
        yield usage({ inputTokens: 10 })
        yield finish()
      })(),
    )[Symbol.asyncIterator]()
    const first = open()
    const second = open()
    await expect(first.next()).resolves.toMatchObject({ done: false })
    await expect(second.next()).resolves.toMatchObject({ done: false })
    await first.next()
    await second.next()
  })
})

describe('budget pressure prompt', () => {
  it('registers the pressure context by default', () => {
    const harness = new TestHarness({ maxTokens: 100 })
    expect(harness.promptContexts.map(entry => entry.name)).toContain('agent-budget:pressure')
  })

  it('stays silent below the warn threshold', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 40 }), finish()])
    expect(harness.pressureTextFor(root)).toBe('')
  })

  it('warns at or above half of the budget', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 60 }), finish()])
    expect(harness.pressureTextFor(root)).toContain('Token budget notice: 60/100')
  })

  it('escalates to critical at or above eighty percent', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 85 }), finish()])
    expect(harness.pressureTextFor(root)).toContain('Token budget critical: 85/100')
  })

  it('reports critical pressure once the budget is exhausted', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('root')
    await harness.stream(root, [usage({ inputTokens: 100 }), finish()])
    expect(harness.pressureTextFor(root)).toContain('Token budget critical: 100/100')
  })

  it('contributes nothing for agent-less diagnostic assemblies', () => {
    const harness = new TestHarness({ maxTokens: 100 })
    expect(harness.pressureTextFor()).toBe('')
  })

  it('registers nothing when pressurePrompt is disabled', () => {
    const harness = new TestHarness({ maxTokens: 100, pressurePrompt: false })
    expect(harness.promptContexts).toHaveLength(0)
  })
})
