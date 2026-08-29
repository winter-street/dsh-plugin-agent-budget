import { describe, expect, it } from 'vitest'
import { TestHarness } from './helpers.ts'
import { finish, usage } from './helpers.ts'

describe('budget adjust and reset ledger semantics', () => {
  it('adjusts the limit without mutating historical sample lines', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('adjust-limit')
    await harness.stream(root, [usage({ inputTokens: 30, outputTokens: 5 }), finish()])

    const response = await harness.callApi('POST', '/adjust-limit', {
      scopeKey: root.id,
      limitTokens: 50,
    })
    expect(response.code).toBe(200)
    expect(response.body).toMatchObject({ ok: true })
    expect(response.body.status).toMatchObject({ limitTokens: 50, usedTokens: 35 })

    expect(await harness.status(root)).toMatchObject({ limitTokens: 50, usedTokens: 35 })

    const types = harness.ledgerLines().map(line => line.type)
    expect(types).toEqual(['open', 'sample', 'adjust'])

    const replay = new TestHarness({ maxTokens: 999, storageDir: harness.storageDir })
    const resumed = replay.resume(root)
    expect(await replay.status(resumed)).toMatchObject({ limitTokens: 50, usedTokens: 35 })
  })

  it('resets usage while keeping the adjusted limit', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('reset-scope')
    await harness.stream(root, [usage({ inputTokens: 60, outputTokens: 10 }), finish()])
    await harness.callApi('POST', '/adjust-limit', { scopeKey: root.id, limitTokens: 200 })
    await harness.stream(root, [usage({ inputTokens: 5, outputTokens: 2 }), finish()])

    expect(await harness.status(root)).toMatchObject({ limitTokens: 200, usedTokens: 77 })

    const response = await harness.callApi('POST', '/reset', { scopeKey: root.id })
    expect(response.code).toBe(200)
    expect(response.body).toMatchObject({ ok: true })
    expect(response.body.status).toMatchObject({
      limitTokens: 200,
      usedTokens: 0,
      remainingTokens: 200,
      exhausted: false,
      unmeteredCalls: 0,
    })

    expect(harness.ledgerLines().filter(line => line.type === 'reset')).toHaveLength(1)

    const replay = new TestHarness({ maxTokens: 999, storageDir: harness.storageDir })
    const resumed = replay.resume(root)
    expect(await replay.status(resumed)).toMatchObject({ limitTokens: 200, usedTokens: 0 })
  })

  it('returns 404 for unknown scopes without writing ledger lines', async () => {
    const harness = new TestHarness({ maxTokens: 100 })

    const adjust = await harness.callApi('POST', '/adjust-limit', {
      scopeKey: 'missing-scope',
      limitTokens: 10,
    })
    expect(adjust.code).toBe(404)

    const reset = await harness.callApi('POST', '/reset', { scopeKey: 'missing-scope' })
    expect(reset.code).toBe(404)

    expect(harness.ledgerLines()).toHaveLength(0)
  })

  it('rejects invalid adjust payloads with 400', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('bad-adjust')
    await harness.stream(root, [usage({ inputTokens: 1 }), finish()])

    const responses = await Promise.all([
      { scopeKey: '', limitTokens: 10 },
      { scopeKey: root.id, limitTokens: 0 },
      { scopeKey: root.id, limitTokens: 1.5 },
    ].map(payload => harness.callApi('POST', '/adjust-limit', payload)))
    for (const response of responses) {
      expect(response.code).toBe(400)
    }
    expect(harness.ledgerLines().filter(line => line.type === 'adjust')).toHaveLength(0)
  })
})
