/** Shared, replayable token budgets for one DSH agent tree. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agent-budget'
export const inject = ['llm', 'sessions', 'tools']

const EVENT_VERSION = 1 as const
const EXHAUSTED_CODE = 'TOKEN_BUDGET_EXHAUSTED'
const EVENT_TYPES = ['budget/open', 'budget/sample', 'budget/unmetered'] as const

type MissingUsagePolicy = 'exhaust' | 'ignore'

interface UsageBuckets {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

interface BudgetOpen {
  version: typeof EVENT_VERSION
  rootSessionId: string
  epochId: string
  limitTokens: number
}

interface BudgetSample {
  version: typeof EVENT_VERSION
  rootSessionId: string
  epochId: string
  callId: string
  sessionId: string
  provider: string
  model: string
  purpose: 'conversation' | 'compaction' | 'session-title'
  usage: UsageBuckets
}

interface BudgetUnmetered {
  version: typeof EVENT_VERSION
  rootSessionId: string
  epochId: string
  callId: string
  sessionId: string
  provider: string
  model: string
  purpose: 'conversation' | 'compaction' | 'session-title'
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    'budget/open': BudgetOpen
    'budget/sample': BudgetSample
    'budget/unmetered': BudgetUnmetered
  }
}

/** Plugin configuration. The limit is fixed in a root session's first open event. */
export interface Config {
  maxTokens: number
  missingUsage?: MissingUsagePolicy
}

/** Loader-facing schema; runtime validation also protects direct plugin calls. */
export const Config: z<Config> = z.object({
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  missingUsage: z.union(['exhaust', 'ignore'] as const).default('exhaust'),
})

interface LedgerState {
  consumedEvents: number
  open: BudgetOpen | undefined
  samples: Map<string, UsageBuckets>
  unmetered: Set<string>
  usage: UsageBuckets
}

interface BudgetStatus {
  limitTokens: number
  usedTokens: number
  remainingTokens: number
  exhausted: boolean
  usage: UsageBuckets
  meteringComplete: boolean
  unmeteredCalls: number
}

const ZERO_USAGE: Readonly<UsageBuckets> = Object.freeze({
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
})

class TokenBudgetExhaustedError extends HarnessError {
  constructor(status: BudgetStatus) {
    super(
      `token budget exhausted (${status.usedTokens}/${status.limitTokens} tokens settled)`,
      EXHAUSTED_CODE,
    )
  }
}

function validateConfig(config: Config): MissingUsagePolicy {
  for (const key of Object.keys(config)) {
    if (key !== 'maxTokens' && key !== 'missingUsage') {
      throw new TypeError(`agent-budget: unknown config key ${JSON.stringify(key)}`)
    }
  }
  if (!Number.isSafeInteger(config.maxTokens) || config.maxTokens < 1) {
    throw new TypeError('agent-budget: maxTokens must be a positive safe integer')
  }
  const missingUsage = config.missingUsage ?? 'exhaust'
  if (missingUsage !== 'exhaust' && missingUsage !== 'ignore') {
    throw new TypeError('agent-budget: missingUsage must be "exhaust" or "ignore"')
  }
  return missingUsage
}

function emptyState(): LedgerState {
  return {
    consumedEvents: 0,
    open: undefined,
    samples: new Map(),
    unmetered: new Set(),
    usage: { ...ZERO_USAGE },
  }
}

function total(usage: UsageBuckets): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
}

function add(target: UsageBuckets, usage: UsageBuckets, sign: 1 | -1): void {
  const next = {
    inputTokens: target.inputTokens + sign * usage.inputTokens,
    cacheReadTokens: target.cacheReadTokens + sign * usage.cacheReadTokens,
    cacheWriteTokens: target.cacheWriteTokens + sign * usage.cacheWriteTokens,
    outputTokens: target.outputTokens + sign * usage.outputTokens,
  }
  if (Object.values(next).some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('agent-budget: usage total is outside the safe integer range')
  }
  Object.assign(target, next)
}

function bucketsOf(usage: TokenUsage): UsageBuckets {
  const buckets = {
    inputTokens: usage.inputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens,
  }
  for (const [bucket, value] of Object.entries(buckets)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`agent-budget: usage.${bucket} must be a non-negative safe integer`)
    }
  }
  return buckets
}

function purposeOf(options: GenerateOptions): BudgetSample['purpose'] {
  return options.purpose ?? 'conversation'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function usageInteger(value: unknown, bucket: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`agent-budget: budget/sample usage.${bucket} must be a non-negative safe integer`)
  }
  return value
}

function usageFromUnknown(value: unknown): UsageBuckets {
  if (!isRecord(value)) throw new Error('agent-budget: budget/sample usage must be an object')
  return {
    inputTokens: usageInteger(value.inputTokens, 'inputTokens'),
    cacheReadTokens: usageInteger(value.cacheReadTokens, 'cacheReadTokens'),
    cacheWriteTokens: usageInteger(value.cacheWriteTokens, 'cacheWriteTokens'),
    outputTokens: usageInteger(value.outputTokens, 'outputTokens'),
  }
}

function assertSubject(data: unknown, type: string): void {
  if (!isRecord(data)
    || data.version !== EVENT_VERSION
    || !nonEmptyString(data.rootSessionId)
    || !nonEmptyString(data.epochId)
    || !nonEmptyString(data.callId)
    || !nonEmptyString(data.sessionId)
    || !nonEmptyString(data.provider)
    || !nonEmptyString(data.model)
    || data.purpose !== 'conversation' && data.purpose !== 'compaction' && data.purpose !== 'session-title') {
    throw new Error(`agent-budget: invalid ${type} event payload`)
  }
}

function assertSubjectFields(fields: {
  sessionId: string
  provider: string
  model: string
  purpose: BudgetSample['purpose']
}): void {
  if (!nonEmptyString(fields.sessionId)
    || !nonEmptyString(fields.provider)
    || !nonEmptyString(fields.model)) {
    throw new Error('agent-budget: sessionId, provider, and model must be non-empty strings')
  }
  if (fields.purpose !== 'conversation'
    && fields.purpose !== 'compaction'
    && fields.purpose !== 'session-title') {
    throw new Error('agent-budget: purpose must be "conversation", "compaction", or "session-title"')
  }
}

function assertOpenPayload(data: unknown): asserts data is BudgetOpen {
  if (!isRecord(data)
    || data.version !== EVENT_VERSION
    || !nonEmptyString(data.rootSessionId)
    || !nonEmptyString(data.epochId)
    || typeof data.limitTokens !== 'number'
    || !Number.isSafeInteger(data.limitTokens)
    || data.limitTokens < 1) {
    throw new Error('agent-budget: invalid budget/open event payload')
  }
}

function foldEvent(root: Session, state: LedgerState, event: SessionEvent): void {
  if (event.type === 'budget/open') {
    if (!isRecord(event.data)) throw new Error('agent-budget: invalid budget/open event payload')
    if (event.data.rootSessionId !== root.id) return
    if (state.open === undefined) {
      assertOpenPayload(event.data)
      state.open = {
        version: EVENT_VERSION,
        rootSessionId: root.id,
        epochId: event.data.epochId,
        limitTokens: event.data.limitTokens,
      }
    }
    return
  }
  const open = state.open
  if (open === undefined) return
  if (event.type === 'budget/sample') {
    if (!isRecord(event.data)) throw new Error('agent-budget: invalid budget/sample event payload')
    if (event.data.rootSessionId !== root.id || event.data.epochId !== open.epochId) return
    assertSubject(event.data, 'budget/sample')
    const usage = usageFromUnknown(event.data.usage)
    const previous = state.samples.get(event.data.callId)
    if (previous !== undefined) add(state.usage, previous, -1)
    state.samples.set(event.data.callId, usage)
    state.unmetered.delete(event.data.callId)
    add(state.usage, usage, 1)
    return
  }
  if (event.type === 'budget/unmetered') {
    if (!isRecord(event.data)) throw new Error('agent-budget: invalid budget/unmetered event payload')
    if (event.data.rootSessionId !== root.id || event.data.epochId !== open.epochId) return
    assertSubject(event.data, 'budget/unmetered')
    if (!state.samples.has(event.data.callId)) state.unmetered.add(event.data.callId)
  }
}

function resolveRoot(ctx: Context, sessionId: GenerateOptions['sessionId']): Session {
  if (sessionId === undefined) throw new Error('agent-budget: a session id is required')
  let session = ctx.sessions.get(sessionId)
  if (session === undefined) {
    throw new Error(`agent-budget: session ${JSON.stringify(sessionId)} is not live`)
  }
  const visited = new Set<string>()
  while (session.header.origin === 'subagent') {
    if (visited.has(session.id)) throw new Error('agent-budget: cyclic subagent session lineage')
    visited.add(session.id)
    const parentId = session.header.parentSession
    if (parentId === undefined) {
      throw new Error(`agent-budget: subagent session ${JSON.stringify(session.id)} has no parent`)
    }
    const parent = ctx.sessions.get(parentId)
    if (parent === undefined) {
      throw new Error(
        `agent-budget: parent session ${JSON.stringify(parentId)} for ${JSON.stringify(session.id)} is not live`,
      )
    }
    session = parent
  }
  return session
}

function denial(status: BudgetStatus): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    if (status.exhausted) throw new TokenBudgetExhaustedError(status)
    yield* []
  })()
}

/** Register the shared budget gate, usage ledger, and read-only status tool. */
export function apply(ctx: Context, config: Config): void {
  const missingUsage = validateConfig(config)
  const logger = ctx.logger('agent-budget')
  const states = new WeakMap<Session, LedgerState>()

  // rc.5 validates restored event vocabulary against this exported set. The
  // registration keeps plugin-authored ledgers resumable until DSH exposes a
  // first-class custom-event registration API.
  if (!(KNOWN_SESSION_EVENT_TYPES instanceof Set)) {
    throw new Error('agent-budget: DSH known-event registry is not extensible')
  }
  for (const type of EVENT_TYPES) KNOWN_SESSION_EVENT_TYPES.add(type)

  const sync = (root: Session): LedgerState => {
    let state = states.get(root)
    if (state === undefined) {
      state = emptyState()
      states.set(root, state)
    }
    while (state.consumedEvents < root.events.length) {
      const event = root.events[state.consumedEvents]
      if (event === undefined) throw new Error('agent-budget: non-contiguous session log')
      foldEvent(root, state, event)
      state.consumedEvents += 1
    }
    return state
  }

  const open = (root: Session): { state: LedgerState; event: BudgetOpen } => {
    const state = sync(root)
    if (state.open === undefined) {
      const payload = {
        version: EVENT_VERSION,
        rootSessionId: root.id,
        epochId: randomUUID(),
        limitTokens: config.maxTokens,
      }
      assertOpenPayload(payload)
      root.append('budget/open', payload)
      sync(root)
      logger.info(
        'budget opened: root=%s epoch=%s limit=%d',
        payload.rootSessionId,
        payload.epochId,
        payload.limitTokens,
      )
    }
    if (state.open === undefined) throw new Error('agent-budget: failed to open budget ledger')
    return { state, event: state.open }
  }

  const status = (root: Session, create: boolean): BudgetStatus => {
    const state = create ? open(root).state : sync(root)
    const limitTokens = state.open?.limitTokens ?? config.maxTokens
    const usedTokens = total(state.usage)
    const unmeteredCalls = state.unmetered.size
    return {
      limitTokens,
      usedTokens,
      remainingTokens: Math.max(0, limitTokens - usedTokens),
      exhausted: usedTokens >= limitTokens || (missingUsage === 'exhaust' && unmeteredCalls > 0),
      usage: { ...state.usage },
      meteringComplete: unmeteredCalls === 0,
      unmeteredCalls,
    }
  }

  ctx.on('session/event', (session) => {
    if (states.has(session)) sync(session)
  })

  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined) return next()
    const root = resolveRoot(ctx, options.sessionId)
    const purpose = purposeOf(options)

    // Fail before any budget event is written or provider work starts: a
    // subject that cannot be replayed must not be recorded.
    assertSubjectFields({
      sessionId: options.sessionId,
      provider: options.provider,
      model: options.model,
      purpose,
    })

    const before = status(root, true)
    if (before.exhausted) {
      logger.warn(
        'budget exhausted before provider dispatch: root=%s limit=%d used=%d unmetered=%d',
        root.id,
        before.limitTokens,
        before.usedTokens,
        before.unmeteredCalls,
      )
      return denial(before)
    }

    const callId = randomUUID()
    const subject = {
      version: EVENT_VERSION,
      rootSessionId: root.id,
      epochId: open(root).event.epochId,
      callId,
      sessionId: options.sessionId,
      provider: options.provider,
      model: options.model,
      purpose,
    }
    assertSubject(subject, 'budget/sample')

    const recordUnmetered = (): void => {
      logger.warn(
        'unmetered llm call recorded: call=%s session=%s provider=%s model=%s',
        subject.callId,
        subject.sessionId,
        subject.provider,
        subject.model,
      )
      root.append('budget/unmetered', subject)
    }

    const stream = next()
    return (async function* (): AsyncGenerator<StreamChunk> {
      let completed = false
      let sawUsage = false
      let meaningful = false
      try {
        for await (const chunk of stream) {
          if (chunk.type === 'usage') {
            let usage: UsageBuckets
            try {
              usage = bucketsOf(chunk.usage)
            } catch (error: unknown) {
              recordUnmetered()
              throw error
            }
            root.append('budget/sample', { ...subject, usage })
            logger.debug(
              'budget sample recorded: call=%s session=%s provider=%s model=%s input=%d cacheRead=%d cacheWrite=%d output=%d',
              callId,
              subject.sessionId,
              subject.provider,
              subject.model,
              usage.inputTokens,
              usage.cacheReadTokens,
              usage.cacheWriteTokens,
              usage.outputTokens,
            )
            sawUsage = true
          } else if (chunk.type !== 'finish'
            || (chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted')) {
            meaningful = true
          }
          yield chunk
        }
        completed = true
      } finally {
        if (completed && !sawUsage && meaningful) {
          recordUnmetered()
        }
      }
    })()
  })

  // Intentionally global: today only this plugin produces TOKEN_BUDGET_EXHAUSTED.
  // If another plugin reuses that code in the future, this boundary must be
  // tightened so unrelated failures are not swallowed here.
  ctx.on('agent/request-error', (payload, next) => {
    if (payload.failure.code === EXHAUSTED_CODE) return Promise.resolve(undefined)
    return next()
  })

  ctx.tools.register(defineTool({
    name: 'budget_status',
    description: 'Read the shared token budget status for this agent tree.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limitTokens: { type: 'integer', required: true },
          usedTokens: { type: 'integer', required: true },
          remainingTokens: { type: 'integer', required: true },
          exhausted: { type: 'boolean', required: true },
          usage: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              inputTokens: { type: 'integer', required: true },
              cacheReadTokens: { type: 'integer', required: true },
              cacheWriteTokens: { type: 'integer', required: true },
              outputTokens: { type: 'integer', required: true },
            },
          },
          meteringComplete: { type: 'boolean', required: true },
          unmeteredCalls: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.exhausted
          ? `Token budget exhausted: ${value.usedTokens}/${value.limitTokens}`
          : `Token budget: ${value.usedTokens}/${value.limitTokens}`,
      }],
    },
    async execute(_args, exec) {
      if (exec.agent === undefined) {
        throw new Error('budget_status requires an owning agent session')
      }
      return status(resolveRoot(ctx, exec.agent.session.id), false)
    },
    presentCall: () => ({ card: 'generic', title: 'Token budget status', kind: 'other' }),
  }))
}
