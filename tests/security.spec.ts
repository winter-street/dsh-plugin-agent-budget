import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { finish, TestHarness, text, usage } from './helpers.ts'

describe('administration boundary', () => {
  it('returns JSON 413 for an oversized chunked request over a real socket', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const route = harness.webServerRoutes[0]!
    const server = createServer((req, res) => { void route.handler(req, res) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const response = await new Promise<{ code: number; body: string }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, method: 'POST', path: '/agent-budget/api/reset', headers: {
          'content-type': 'application/json', 'x-agent-budget-request': '1', 'transfer-encoding': 'chunked',
        } }, res => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', chunk => { body += chunk })
          res.on('end', () => resolve({ code: res.statusCode!, body }))
          res.on('error', reject)
        })
        req.on('error', reject)
        req.end(' '.repeat(20_000))
      })
      expect(response.code).toBe(413)
      expect(JSON.parse(response.body)).toMatchObject({ ok: false })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it.each([
    { remoteAddress: '192.168.1.5' },
    { remoteAddress: '::ffff:192.168.1.5' },
    { headers: { host: 'attacker.example' } },
    { headers: { host: 'localhost.attacker.example' } },
    { headers: { origin: 'https://attacker.example' } },
    { headers: { origin: 'null' } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { 'sec-fetch-site': 'same-site' } },
    { headers: { 'x-agent-budget-request': '' } },
  ])('rejects unauthorized mutations (%j)', async options => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('protected')
    await harness.stream(root, [usage({ inputTokens: 10 }), finish()])
    const before = harness.ledgerLines()
    expect((await harness.callApi('POST', '/reset', { scopeKey: root.id }, options)).code).toBe(403)
    expect(harness.ledgerLines()).toEqual(before)
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('allows local same-origin clients (%s)', async remoteAddress => {
    const harness = new TestHarness({ maxTokens: 100 })
    expect((await harness.callApi('GET', '/scopes', undefined, {
      remoteAddress, headers: { origin: 'http://localhost:3000' },
    })).code).toBe(200)
  })

  it.each(['{', 'null', '[]', '1', '"value"'])('reports invalid JSON objects as 400 (%s)', async rawBody => {
    const harness = new TestHarness({ maxTokens: 100 })
    expect((await harness.callApi('POST', '/reset', undefined, { rawBody })).code).toBe(400)
  })

  it('bounds both advertised and streamed request sizes', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    expect((await harness.callApi('POST', '/reset', undefined, {
      headers: { 'content-length': '16385' },
    })).code).toBe(413)
    expect((await harness.callApi('POST', '/reset', undefined, { rawBody: ' '.repeat(16385) })).code).toBe(413)
    expect((await harness.callApi('POST', '/reset', {}, { headers: { 'content-type': 'text/plain' } })).code).toBe(415)
  })

  it('preserves exact scope identifiers instead of trimming them', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root(' scope ')
    await harness.stream(root, [usage({ inputTokens: 10 })])
    expect((await harness.callApi('POST', '/reset', { scopeKey: root.id })).code).toBe(200)
    expect(await harness.status(root)).toMatchObject({ usedTokens: 0 })
  })

  it('rejects resetting an active scope until the stream has settled', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('active-reset')
    const iterator = harness.streamHandlers[0]!({ provider: 'mock', model: 'mock', messages: [], sessionId: root.id },
      () => (async function* () { yield usage({ inputTokens: 10 }); yield usage({ inputTokens: 20 }) })())[Symbol.asyncIterator]()
    await iterator.next()
    expect((await harness.callApi('POST', '/reset', { scopeKey: root.id })).code).toBe(409)
    await iterator.next()
    await iterator.next()
    expect(await harness.status(root)).toMatchObject({ usedTokens: 20 })
    expect((await harness.callApi('POST', '/reset', { scopeKey: root.id })).code).toBe(200)
  })
})

describe('fail-closed accounting and replay', () => {
  it('treats an empty successful stream as missing usage', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('empty')
    await harness.stream(root, [])
    expect(await harness.status(root)).toMatchObject({ exhausted: true, unmeteredCalls: 1 })
  })

  it('marks a transport exception before output as unknown usage', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('transport-error')
    const stream = harness.streamHandlers[0]!({ provider: 'mock', model: 'mock', messages: [], sessionId: root.id },
      () => { throw new Error('transport failure') })
    await expect(Array.fromAsync(stream)).rejects.toThrow('transport failure')
    expect(await harness.status(root)).toMatchObject({ exhausted: true, unmeteredCalls: 1 })
  })

  it('blocks unresolved calls recovered after a process crash', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('crash')
    await harness.stream(root, [usage({ inputTokens: 10 })])
    appendFileSync(join(harness.storageDir, 'ledger.jsonl'), JSON.stringify({
      type: 'start', version: 1, scopeKey: root.id, callId: 'crashed-call',
    }) + '\n')
    harness.dispose()
    const replay = new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })
    expect(await replay.status(replay.resume(root))).toMatchObject({ exhausted: true, unmeteredCalls: 1 })
    await expect(replay.stream(root, [finish()])).rejects.toMatchObject({ code: 'TOKEN_BUDGET_EXHAUSTED' })
  })

  it('rechecks the budget when an iterable is consumed later', async () => {
    const harness = new TestHarness({ maxTokens: 10 })
    const root = harness.root('deferred')
    let dispatched = false
    const stream = harness.streamHandlers[0]!({ provider: 'mock', model: 'mock', messages: [], sessionId: root.id }, () => {
      dispatched = true
      return (async function* () { yield finish() })()
    })
    await harness.stream(root, [usage({ inputTokens: 10 })])
    await expect(Array.fromAsync(stream)).rejects.toMatchObject({ code: 'TOKEN_BUDGET_EXHAUSTED' })
    expect(dispatched).toBe(false)
  })

  it('retains partial usage but marks cancellation before settlement incomplete', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('partial')
    const stream = harness.streamHandlers[0]!({ provider: 'mock', model: 'mock', messages: [], sessionId: root.id },
      () => (async function* () { yield usage({ inputTokens: 10 }); yield text() })())
    for await (const chunk of stream) { expect(chunk.type).toBe('usage'); break }
    expect(await harness.status(root)).toMatchObject({ usedTokens: 10, exhausted: true, unmeteredCalls: 1 })
  })

  it('accepts consumers that stop at the provider finish chunk', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('finish-break')
    const stream = harness.streamHandlers[0]!({ provider: 'mock', model: 'mock', messages: [], sessionId: root.id },
      () => (async function* () { yield usage({ inputTokens: 10 }); yield finish() })())
    for await (const chunk of stream) { if (chunk.type === 'finish') break }
    expect(await harness.status(root)).toMatchObject({ usedTokens: 10, exhausted: false, unmeteredCalls: 0 })
  })

  it('holds the writer lock until disposed plugin streams finish', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('dispose-active')
    const stream = harness.streamHandlers[0]!({ provider: 'mock', model: 'mock', messages: [], sessionId: root.id },
      () => (async function* () { yield usage({ inputTokens: 10 }); yield finish() })())[Symbol.asyncIterator]()
    await stream.next()
    harness.dispose()
    expect(() => new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })).toThrow('storage is locked')
    await stream.next()
    await stream.next()
    const replay = new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })
    expect(await replay.status(replay.resume(root))).toMatchObject({ usedTokens: 10, exhausted: false })
  })

  it('records a stream that throws after generating output', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('throwing')
    const stream = harness.streamHandlers[0]!({ provider: 'mock', model: 'mock', messages: [], sessionId: root.id },
      () => (async function* (): AsyncGenerator<StreamChunk> { yield text(); throw new Error('connection lost') })())
    await expect(Array.fromAsync(stream)).rejects.toThrow('connection lost')
    expect(await harness.status(root)).toMatchObject({ exhausted: true, unmeteredCalls: 1 })
    harness.dispose()
    const replay = new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })
    expect(await replay.status(replay.resume(root))).toMatchObject({ exhausted: true, unmeteredCalls: 1 })
  })

  it('records consumer cancellation after output', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('cancelled')
    const stream = harness.streamHandlers[0]!({ provider: 'mock', model: 'mock', messages: [], sessionId: root.id },
      () => (async function* () { yield text(); yield usage({ inputTokens: 10 }) })())
    for await (const chunk of stream) { expect(chunk.type).toBe('text-delta'); break }
    expect(await harness.status(root)).toMatchObject({ exhausted: true, unmeteredCalls: 1 })
  })

  it('fails closed when a valid cumulative sample is followed by invalid usage', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('invalid-later')
    await expect(harness.stream(root, [usage({ inputTokens: 10 }), usage({ inputTokens: -1 })])).rejects.toThrow()
    expect(await harness.status(root)).toMatchObject({ usedTokens: 10, exhausted: true, unmeteredCalls: 1 })
    harness.dispose()
    const replay = new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })
    expect(await replay.status(replay.resume(root))).toMatchObject({ usedTokens: 10, exhausted: true })
  })

  it('rejects overflow without poisoning the replayable ledger', async () => {
    const harness = new TestHarness({ maxTokens: Number.MAX_SAFE_INTEGER })
    const root = harness.root('overflow')
    await harness.stream(root, [usage({ inputTokens: Number.MAX_SAFE_INTEGER - 1 })])
    await expect(harness.stream(root, [usage({ outputTokens: 2 })])).rejects.toThrow('safe integer range')
    expect(await harness.status(root)).toMatchObject({ usedTokens: Number.MAX_SAFE_INTEGER - 1, exhausted: true })
    harness.dispose()
    const replay = new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })
    expect(await replay.status(replay.resume(root))).toMatchObject({ usedTokens: Number.MAX_SAFE_INTEGER - 1, exhausted: true })
  })

  it.each(['{', '{"type":"unknown","version":1,"scopeKey":"x"}',
    '{"type":"sample","version":1,"scopeKey":"x","callId":"c","sessionId":"x","model":"m","provider":"p","purpose":"conversation","usage":{"inputTokens":-1,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0}}',
  ])('refuses corrupt ledger records instead of silently dropping accounting (%s)', raw => {
    const harness = new TestHarness({ maxTokens: 100 })
    writeFileSync(join(harness.storageDir, 'ledger.jsonl'), raw + '\n')
    harness.dispose()
    expect(() => new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })).toThrow(/ledger/)
  })

  it('repairs a missing newline on a complete final record before appending', async () => {
    const harness = new TestHarness({ maxTokens: 100 })
    const root = harness.root('newline')
    await harness.stream(root, [usage({ inputTokens: 10 })])
    const file = join(harness.storageDir, 'ledger.jsonl')
    writeFileSync(file, readFileSync(file, 'utf8').trimEnd())
    harness.dispose()
    const replay = new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })
    await replay.stream(replay.resume(root), [usage({ inputTokens: 5 })])
    expect(replay.ledgerLines().filter(line => line.type === 'sample')).toHaveLength(2)
    expect(await replay.status(root)).toMatchObject({ usedTokens: 15 })
    appendFileSync(file, '{')
    replay.dispose()
    expect(() => new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })).toThrow(/malformed ledger/)
  })

  it('exclusively locks the store and releases it on disposal', () => {
    const harness = new TestHarness({ maxTokens: 100 })
    expect(() => new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })).toThrow('storage is locked')
    harness.dispose()
    expect(() => new TestHarness({ maxTokens: 100, storageDir: harness.storageDir })).not.toThrow()
  })
})
