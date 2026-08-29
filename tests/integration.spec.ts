import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
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

class VariableMockAdapter extends LlmAdapter {
  calls = 0
  private readonly inputTokens: number
  private readonly outputTokens: number

  constructor(inputTokens: number, outputTokens: number) {
    super()
    this.inputTokens = inputTokens
    this.outputTokens = outputTokens
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    const { inputTokens, outputTokens } = this
    return (async function* (): AsyncGenerator<StreamChunk> {
      yield usage({ inputTokens, outputTokens })
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
    await ctx.plugin(AgentRegistry)
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

  it('keeps independent sessions independent and reconstructable without the plugin', async () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'agent-budget-integration-'))
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    const fiber = ctx.plugin({ name, inject, apply }, { maxTokens: 100, storageDir })
    await fiber.await()

    const heavy = new VariableMockAdapter(90, 10)
    const light = new VariableMockAdapter(1, 0)
    ctx.llm.registerAdapter(['heavy'], heavy)
    ctx.llm.registerAdapter(['light'], light)

    const first = ctx.sessions.create(SessionId('independent-first'))
    const second = ctx.sessions.create(SessionId('independent-second'))
    const firstChunks = await Array.fromAsync(ctx.llm.stream({
      provider: 'heavy',
      model: 'mock-model',
      messages: [],
      sessionId: first.id,
    }))
    const secondChunks = await Array.fromAsync(ctx.llm.stream({
      provider: 'light',
      model: 'mock-model',
      messages: [],
      sessionId: second.id,
    }))
    expect(heavy.calls).toBe(1)
    expect(light.calls).toBe(1)
    expect(firstChunks.map(chunk => chunk.type)).toEqual(['usage', 'finish'])
    expect(secondChunks.map(chunk => chunk.type)).toEqual(['usage', 'finish'])

    const tool = ctx.tools.get('budget_status')
    if (tool === undefined) throw new Error('budget_status tool was not registered')
    const firstStatus = await tool.execute({}, { agent: { session: first } } as never)
    const secondStatus = await tool.execute({}, { agent: { session: second } } as never)
    expect(firstStatus).toMatchObject({ usedTokens: 100, exhausted: true })
    expect(secondStatus).toMatchObject({ usedTokens: 1, exhausted: false })

    await fiber.dispose()
    expect(() => Session.create(first.id, first.events, first.header)).not.toThrow()
    expect(() => Session.create(second.id, second.events, second.header)).not.toThrow()
  })
})
