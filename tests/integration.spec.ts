import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply, inject, name } from '../src/index.ts'
import { finish, usage } from './helpers.ts'

class MockAdapter extends LlmAdapter {
  calls = 0

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield usage({ inputTokens: 3, outputTokens: 2 })
      yield finish()
    })()
  }
}

describe('DSH runtime integration', () => {
  it('wraps a real LlmRuntime stream and unregisters on plugin disposal', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'agent-budget-integration-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = ctx.plugin({ name, inject, apply }, { maxTokens: 10, storageDir })
    await fiber.await()
    const adapter = new MockAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const session = ctx.sessions.create(SessionId('runtime-integration'))
    const chunks = await Array.fromAsync(ctx.llm.stream({
      provider: 'mock',
      model: 'mock-model',
      messages: [],
      sessionId: session.id,
    }))
    expect(adapter.calls).toBe(1)
    expect(chunks).toHaveLength(2)
    expect(session.events.some(event => event.type.startsWith('budget/'))).toBe(false)
    expect(ctx.tools.get('budget_status')).toBeDefined()

    await fiber.dispose()
    expect(ctx.tools.get('budget_status')).toBeUndefined()
    const samples = session.events.filter(event => event.type === 'budget/sample').length
    await Array.fromAsync(ctx.llm.stream({
      provider: 'mock',
      model: 'mock-model',
      messages: [],
      sessionId: session.id,
    }))
    expect(adapter.calls).toBe(2)
    expect(session.events.filter(event => event.type === 'budget/sample')).toHaveLength(samples)
  })
})
