import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { finish, TestHarness, usage } from './helpers.ts'

const apiKey = process.env.DEEPSEEK_API_KEY

describe.skipIf(!apiKey)('real DeepSeek usage smoke', () => {
  it('accounts the provider usage response', async () => {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 8,
        stream: false,
      }),
    })
    if (!response.ok) throw new Error(`DeepSeek smoke failed with HTTP ${response.status}: ${await response.text()}`)
    const body = await response.json() as {
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_cache_hit_tokens?: number
        prompt_cache_miss_tokens?: number
      }
    }
    if (body.usage === undefined) throw new Error('DeepSeek smoke response did not include usage')
    const read = body.usage.prompt_cache_hit_tokens ?? 0
    const input = body.usage.prompt_cache_miss_tokens
      ?? Math.max(0, (body.usage.prompt_tokens ?? 0) - read)
    const chunks: StreamChunk[] = [
      usage({
        inputTokens: input,
        cacheReadTokens: read,
        outputTokens: body.usage.completion_tokens ?? 0,
      }),
      finish(),
    ]
    const harness = new TestHarness({ maxTokens: 10_000 })
    const root = harness.root('deepseek-smoke')
    await harness.stream(root, chunks, { provider: 'deepseek-official', model: 'deepseek-chat' })
    expect((await harness.status(root)).usedTokens).toBeGreaterThan(0)
  }, 60_000)
})
