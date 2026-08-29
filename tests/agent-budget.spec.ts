import { describe, expect, it } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, Config, inject, name } from '../src/index.ts'
import { finish, TestHarness, text, usage } from './helpers.ts'

describe('plugin surface and config', () => {
  it('exposes the function-plugin entry points without a default export', async () => {
    const module = await import('../src/index.ts')
    expect({ name, inject, Config: typeof Config, apply: typeof apply }).toEqual({
      name: 'agent-budget',
      inject: ['llm', 'sessions', 'tools'],
      Config: 'function',
      apply: 'function',
    })
    expect('default' in module).toBe(false)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxTokens %s',
    (maxTokens) => {
      expect(() => new TestHarness({ maxTokens })).toThrow('positive safe integer')
    },
  )

  it('rejects unknown direct-call config keys', () => {
    expect(() => apply({} as never, { maxTokens: 10, typo: true } as never))
      .toThrow('unknown config key')
  })
})

describe('accounting', () => {
  it('replaces cumulative samples from one call and sums disjoint buckets', async () => {
    const harness = new TestHarness({ maxTokens: 1_000 })
    const root = harness.root('root')
    await harness.stream(root, [
      usage({ inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 4 }),
      usage({ inputTokens: 12, cacheReadTokens: 5, cacheWriteTokens: 6, outputTokens: 7, reasoningTokens: 7 }),
      finish(),
    ])
    await harness.stream(root, [usage({ inputTokens: 1, outputTokens: 2 }), finish()])

    expect(await harness.status(root)).toMatchObject({
      limitTokens: 1_000,
      usedTokens: 33,
      remainingTokens: 967,
      exhausted: false,
      usage: {
        inputTokens: 13,
        cacheReadTokens: 5,
        cacheWriteTokens: 6,
        outputTokens: 9,
      },
      meteringComplete: true,
      unmeteredCalls: 0,
    })
    expect(harness.ledgerLines().filter(line => line.type === 'sample')).toHaveLength(3)
  })

  it('shares a root budget across parent, siblings, and workflow descendants', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('parent')
    const first = harness.child('first', root)
    const second = harness.child('second', root)
    const workflow = harness.child('workflow', first)

    await harness.stream(root, [usage({ inputTokens: 10, outputTokens: 1 }), finish()])
    await harness.stream(first, [usage({ inputTokens: 20, outputTokens: 2 }), finish()])
    await harness.stream(second, [usage({ inputTokens: 30, outputTokens: 3 }), finish()])
    await harness.stream(workflow, [usage({ inputTokens: 4, outputTokens: 5 }), finish()])

    const statuses = await Promise.all([root, first, second, workflow].map(session => harness.status(session)))
    for (const status of statuses) expect(status).toMatchObject({ usedTokens: 75, remainingTokens: 25 })
    for (const session of [root, first, second, workflow]) {
      expect(session.events.some(event => event.type.startsWith('budget/'))).toBe(false)
    }
    expect(harness.ledgerLines().filter(line => line.type === 'sample')).toHaveLength(4)
  })

  it('honors scope: session by keeping subagent children independent', async () => {
    const harness = new TestHarness({ maxTokens: 100, scope: 'session' })
    const root = harness.root('session-scope-root')
    const first = harness.child('session-scope-first', root)
    const second = harness.child('session-scope-second', root)

    await harness.stream(first, [usage({ inputTokens: 80, outputTokens: 5 }), finish()])
    await harness.stream(second, [usage({ inputTokens: 10, outputTokens: 2 }), finish()])

    expect(await harness.status(first)).toMatchObject({ usedTokens: 85, exhausted: false })
    expect(await harness.status(second)).toMatchObject({ usedTokens: 12, exhausted: false })
    expect(await harness.status(root)).toMatchObject({ usedTokens: 0, exhausted: false })
  })

  it('isolates unrelated roots and ordinary forks, including inherited ledger events', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const original = harness.root('original')
    const unrelated = harness.root('unrelated')
    await harness.stream(original, [usage({ inputTokens: 40, outputTokens: 1 }), finish()])
    const fork = harness.fork('fork', original)

    await harness.stream(fork, [usage({ inputTokens: 5, outputTokens: 2 }), finish()])
    await harness.stream(unrelated, [usage({ inputTokens: 8, outputTokens: 3 }), finish()])

    expect(await harness.status(original)).toMatchObject({ usedTokens: 41 })
    expect(await harness.status(fork)).toMatchObject({ usedTokens: 7 })
    expect(await harness.status(unrelated)).toMatchObject({ usedTokens: 11 })
    expect(fork.events.some(event => event.type.startsWith('budget/'))).toBe(false)
    expect(harness.ledgerLines().filter(line => line.type === 'open')).toHaveLength(3)
  })

  it('counts compaction, title generation, and usage reported before failure', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('auxiliary')
    await harness.stream(root, [usage({ inputTokens: 5, outputTokens: 1 }), finish()], { purpose: 'compaction' })
    await harness.stream(root, [usage({ inputTokens: 6, outputTokens: 2 }), finish()], { purpose: 'session-title' })
    await harness.stream(root, [usage({ inputTokens: 7, outputTokens: 3 }), finish('error')])

    expect(await harness.status(root)).toMatchObject({ usedTokens: 24 })
    expect(harness.ledgerLines().filter(line => line.type === 'sample').map(line => line.purpose))
      .toEqual(['compaction', 'session-title', 'conversation'])
  })

  it('does not meter direct llm calls without a session id', async () => {
    const harness = new TestHarness({ maxTokens: 10 })
    const root = harness.root('outside')
    await harness.stream(undefined, [usage({ inputTokens: 100, outputTokens: 100 }), finish()])
    expect(await harness.status(root)).toMatchObject({ usedTokens: 0, remainingTokens: 10 })
    expect(root.events.some(event => event.type.startsWith('budget/'))).toBe(false)
    expect(harness.ledgerLines()).toHaveLength(0)
  })
})

describe('admission and incomplete metering', () => {
  it('allows admitted concurrent calls to overshoot, then denies before provider dispatch', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('concurrent')
    const handler = harness.streamHandlers[0]
    if (handler === undefined) throw new Error('missing handler')
    let providerCalls = 0
    const options = { provider: 'mock', model: 'mock-model', messages: [], sessionId: root.id }
    const first = handler(options, () => {
      providerCalls += 1
      return (async function* () { yield usage({ inputTokens: 60 }); yield finish() })()
    })
    const second = handler(options, () => {
      providerCalls += 1
      return (async function* () { yield usage({ inputTokens: 60 }); yield finish() })()
    })
    await Promise.all([Array.fromAsync(first), Array.fromAsync(second)])
    expect(providerCalls).toBe(2)
    expect(await harness.status(root)).toMatchObject({ usedTokens: 120, remainingTokens: 0, exhausted: true })

    await expect(harness.stream(root, [usage({ inputTokens: 1 }), finish()], {}, () => {
      providerCalls += 1
    })).rejects.toMatchObject({ code: 'TOKEN_BUDGET_EXHAUSTED' })
    expect(providerCalls).toBe(2)
  })

  it('fails closed on meaningful streams without usage by default', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('missing-exhaust')
    await harness.stream(root, [text(), finish()])
    expect(await harness.status(root)).toMatchObject({
      usedTokens: 0,
      remainingTokens: 100,
      exhausted: true,
      meteringComplete: false,
      unmeteredCalls: 1,
    })
    await expect(harness.stream(root, [finish()])).rejects.toMatchObject({ code: 'TOKEN_BUDGET_EXHAUSTED' })
  })

  it('records but does not exhaust unmetered calls under ignore policy', async () => {
    const harness = new TestHarness({ maxTokens: 100, missingUsage: 'ignore' })
    const root = harness.root('missing-ignore')
    await harness.stream(root, [text(), finish()])
    expect(await harness.status(root)).toMatchObject({
      exhausted: false,
      meteringComplete: false,
      unmeteredCalls: 1,
    })
    await expect(harness.stream(root, [usage({ inputTokens: 2 }), finish()])).resolves.toHaveLength(2)
  })

  it('does not classify an immediate provider error as an unmetered completion', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('provider-error')
    await harness.stream(root, [finish('error')])
    expect(await harness.status(root)).toMatchObject({ meteringComplete: true, unmeteredCalls: 0 })
  })

  it.each([
    { provider: '' },
    { model: '' },
  ])('rejects an empty subject field before writing any budget event (%j)', async (extra) => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('bad-subject')
    let providerCalls = 0
    await expect(harness.stream(root, [finish()], extra, () => {
      providerCalls += 1
    })).rejects.toThrow('non-empty')
    expect(providerCalls).toBe(0)
    expect(root.events.filter(event => event.type.startsWith('budget/'))).toHaveLength(0)
    expect(harness.ledgerLines()).toHaveLength(0)
  })
})

describe('replay and lifecycle', () => {
  it('restores the fixed limit and samples after session resume and plugin reload', async () => {
    const firstHarness = new TestHarness({ maxTokens: 50 })
    const first = firstHarness.root('durable')
    await firstHarness.stream(first, [usage({ inputTokens: 30, outputTokens: 5 }), finish()])

    const secondHarness = new TestHarness({ maxTokens: 999, storageDir: firstHarness.storageDir })
    const resumed = secondHarness.resume(first)
    expect(await secondHarness.status(resumed)).toMatchObject({
      limitTokens: 50,
      usedTokens: 35,
      remainingTokens: 15,
    })
    await secondHarness.stream(resumed, [usage({ inputTokens: 20 }), finish()])
    await expect(secondHarness.stream(resumed, [finish()])).rejects.toMatchObject({
      code: 'TOKEN_BUDGET_EXHAUSTED',
    })
  })

  it('returns the same status from a root and its child', async () => {
    const harness = new TestHarness({ maxTokens: 25 })
    const root = harness.root('status-root')
    const child = harness.child('status-child', root)
    await harness.stream(child, [usage({ inputTokens: 9, outputTokens: 1 }), finish()])
    expect(await harness.status(root)).toEqual(await harness.status(child))
  })

  it('keeps sessions reconstructable without plugin events in the log', async () => {
    const harness = new TestHarness({ maxTokens: 10 })
    const root = harness.root('reconstruct')
    await harness.stream(root, [usage({ inputTokens: 1 }), finish()])
    expect(root.events.filter(event => event.type.startsWith('budget/'))).toHaveLength(0)
    expect(() => Session.create(root.id, root.events, root.header)).not.toThrow()
  })
})
