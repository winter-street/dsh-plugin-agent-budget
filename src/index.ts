/** Shared, replayable token budgets for one DSH agent tree. */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { KNOWN_SESSION_EVENT_TYPES, SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/cordis' {
  interface Context {
    webServer: {
      register(route: {
        kind: 'prefix'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
      }): () => void
    }
  }
}

export const name = 'agent-budget'
export const inject = ['llm', 'sessions', 'tools', 'agents', 'webServer']

const EVENT_VERSION = 1 as const
const EXHAUSTED_CODE = 'TOKEN_BUDGET_EXHAUSTED'
const EVENT_TYPES = ['budget/open', 'budget/sample', 'budget/unmetered'] as const

type MissingUsagePolicy = 'exhaust' | 'ignore'
type ScopeMode = 'session' | 'tree'

interface UsageBuckets {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/**
 * DSH session-event payloads. Kept only for backward compatibility with logs
 * written by earlier plugin versions; the runtime no longer appends them.
 */
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

/** Plugin configuration. The limit is fixed in a budget scope's first open event. */
export interface Config {
  maxTokens: number
  missingUsage?: MissingUsagePolicy
  scope?: ScopeMode
  storageDir?: string
}

/** Loader-facing schema; runtime validation also protects direct plugin calls. */
export const Config: z<Config> = z.object({
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  missingUsage: z.union(['exhaust', 'ignore'] as const).default('exhaust'),
  scope: z.union(['session', 'tree'] as const).default('tree'),
  storageDir: z.string(),
})

/** One append-only ledger line in the plugin-owned sidecar store. */
type LedgerLine =
  | {
    type: 'open'
    version: typeof EVENT_VERSION
    scopeKey: string
    epochId: string
    limitTokens: number
  }
  | {
    type: 'sample'
    version: typeof EVENT_VERSION
    scopeKey: string
    callId: string
    sessionId: string
    provider: string
    model: string
    purpose: BudgetSample['purpose']
    usage: UsageBuckets
  }
  | {
    type: 'unmetered'
    version: typeof EVENT_VERSION
    scopeKey: string
    callId: string
    sessionId: string
    provider: string
    model: string
    purpose: BudgetSample['purpose']
  }
  | {
    type: 'adjust'
    version: typeof EVENT_VERSION
    scopeKey: string
    limitTokens: number
  }
  | {
    type: 'reset'
    version: typeof EVENT_VERSION
    scopeKey: string
  }

interface LedgerState {
  open: LedgerOpen | undefined
  samples: Map<string, UsageBuckets>
  unmetered: Set<string>
  usage: UsageBuckets
}

interface LedgerOpen {
  version: typeof EVENT_VERSION
  scopeKey: string
  epochId: string
  limitTokens: number
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

interface OwnershipCache {
  generation: number
  builtGeneration: number
  ownerByChild: Map<string, string> | undefined
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

function defaultStorageDir(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'agent-budget')
}

function validateConfig(config: Config): {
  missingUsage: MissingUsagePolicy
  scope: ScopeMode
  storageDir: string
} {
  for (const key of Object.keys(config)) {
    if (key !== 'maxTokens'
      && key !== 'missingUsage'
      && key !== 'scope'
      && key !== 'storageDir') {
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
  const scope = config.scope ?? 'tree'
  if (scope !== 'session' && scope !== 'tree') {
    throw new TypeError('agent-budget: scope must be "session" or "tree"')
  }
  const storageDir = config.storageDir ?? defaultStorageDir()
  if (storageDir.length === 0) {
    throw new TypeError('agent-budget: storageDir must be a non-empty path')
  }
  return { missingUsage, scope, storageDir }
}

function emptyState(): LedgerState {
  return {
    open: undefined,
    samples: new Map(),
    unmetered: new Set(),
    usage: { ...ZERO_USAGE },
  }
}

function createOwnershipCache(): OwnershipCache {
  return {
    generation: 0,
    builtGeneration: -1,
    ownerByChild: undefined,
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

function isLedgerLine(value: unknown): value is LedgerLine {
  if (!isRecord(value) || typeof value.version !== 'number' || value.version !== EVENT_VERSION) {
    return false
  }
  if (!nonEmptyString(value.scopeKey)) return false
  if (value.type === 'open') {
    return nonEmptyString(value.epochId)
      && typeof value.limitTokens === 'number'
      && Number.isSafeInteger(value.limitTokens)
      && value.limitTokens > 0
  }
  if (value.type === 'sample' || value.type === 'unmetered') {
    return nonEmptyString(value.callId)
      && nonEmptyString(value.sessionId)
      && nonEmptyString(value.provider)
      && nonEmptyString(value.model)
      && (value.purpose === 'conversation'
        || value.purpose === 'compaction'
        || value.purpose === 'session-title')
  }
  if (value.type === 'adjust') {
    return typeof value.limitTokens === 'number'
      && Number.isSafeInteger(value.limitTokens)
      && value.limitTokens > 0
  }
  if (value.type === 'reset') {
    return true
  }
  return false
}

function foldLedgerLine(scopeKey: string, state: LedgerState, line: LedgerLine): void {
  if (line.scopeKey !== scopeKey) return
  if (line.type === 'open') {
    if (state.open === undefined) {
      state.open = {
        version: EVENT_VERSION,
        scopeKey: line.scopeKey,
        epochId: line.epochId,
        limitTokens: line.limitTokens,
      }
    }
    return
  }
  const ledgerOpen = state.open
  if (ledgerOpen === undefined) return
  if (line.type === 'sample') {
    const previous = state.samples.get(line.callId)
    if (previous !== undefined) add(state.usage, previous, -1)
    state.samples.set(line.callId, line.usage)
    state.unmetered.delete(line.callId)
    add(state.usage, line.usage, 1)
    return
  }
  if (line.type === 'unmetered') {
    if (!state.samples.has(line.callId)) state.unmetered.add(line.callId)
    return
  }
  if (line.type === 'adjust') {
    ledgerOpen.limitTokens = line.limitTokens
    return
  }
  if (line.type === 'reset') {
    state.samples.clear()
    state.unmetered.clear()
    state.usage = { ...ZERO_USAGE }
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

function appendLedgerLine(file: string, line: LedgerLine): void {
  appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
}

class LedgerStore {
  private readonly ledgerPath: string
  private readonly indexPath: string
  readonly states = new Map<string, LedgerState>()
  private readonly scopeIndex = new Map<string, string>()

  constructor(readonly dir: string) {
    this.ledgerPath = join(dir, 'ledger.jsonl')
    this.indexPath = join(dir, 'scope-index.json')
  }

  load(): void {
    ensureDir(this.dir)
    if (existsSync(this.indexPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.indexPath, 'utf8')) as unknown
        if (isRecord(parsed)) {
          for (const [sessionId, scopeKey] of Object.entries(parsed)) {
            if (nonEmptyString(sessionId) && nonEmptyString(scopeKey)) {
              this.scopeIndex.set(sessionId, scopeKey)
            }
          }
        }
      } catch {
        // A corrupt index is not fatal: runtime ownership can rebuild it.
      }
    }
    if (existsSync(this.ledgerPath)) {
      const lines = readFileSync(this.ledgerPath, 'utf8').split(/\r?\n/)
      for (const raw of lines) {
        if (raw.length === 0) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(raw) as unknown
        } catch {
          // Tolerate a torn final line after a crash.
          continue
        }
        if (!isLedgerLine(parsed)) continue
        let state = this.states.get(parsed.scopeKey)
        if (state === undefined) {
          state = emptyState()
          this.states.set(parsed.scopeKey, state)
        }
        foldLedgerLine(parsed.scopeKey, state, parsed)
      }
    }
  }

  state(scopeKey: string): LedgerState {
    let state = this.states.get(scopeKey)
    if (state === undefined) {
      state = emptyState()
      this.states.set(scopeKey, state)
    }
    return state
  }

  lookupScope(sessionId: string): string | undefined {
    return this.scopeIndex.get(sessionId)
  }

  bindSession(sessionId: string, scopeKey: string): void {
    if (this.scopeIndex.get(sessionId) === scopeKey) return
    this.scopeIndex.set(sessionId, scopeKey)
    writeJsonAtomic(this.indexPath, Object.fromEntries(this.scopeIndex))
  }

  appendOpen(scopeKey: string, epochId: string, limitTokens: number): void {
    const line: LedgerLine = {
      type: 'open',
      version: EVENT_VERSION,
      scopeKey,
      epochId,
      limitTokens,
    }
    appendLedgerLine(this.ledgerPath, line)
    foldLedgerLine(scopeKey, this.state(scopeKey), line)
  }

  appendSample(scopeKey: string, sample: Omit<Extract<LedgerLine, { type: 'sample' }>, 'type' | 'version'>): void {
    const line: LedgerLine = {
      type: 'sample',
      version: EVENT_VERSION,
      ...sample,
    }
    appendLedgerLine(this.ledgerPath, line)
    foldLedgerLine(scopeKey, this.state(scopeKey), line)
  }

  appendUnmetered(scopeKey: string, sample: Omit<Extract<LedgerLine, { type: 'unmetered' }>, 'type' | 'version'>): void {
    const line: LedgerLine = {
      type: 'unmetered',
      version: EVENT_VERSION,
      ...sample,
    }
    appendLedgerLine(this.ledgerPath, line)
    foldLedgerLine(scopeKey, this.state(scopeKey), line)
  }

  appendAdjust(scopeKey: string, limitTokens: number): void {
    const line: LedgerLine = {
      type: 'adjust',
      version: EVENT_VERSION,
      scopeKey,
      limitTokens,
    }
    appendLedgerLine(this.ledgerPath, line)
    foldLedgerLine(scopeKey, this.state(scopeKey), line)
  }

  appendReset(scopeKey: string): void {
    const line: LedgerLine = {
      type: 'reset',
      version: EVENT_VERSION,
      scopeKey,
    }
    appendLedgerLine(this.ledgerPath, line)
    foldLedgerLine(scopeKey, this.state(scopeKey), line)
  }
}

function denial(budget: BudgetStatus): AsyncIterable<StreamChunk> {
  return (async function* (): AsyncGenerator<StreamChunk> {
    if (budget.exhausted) throw new TokenBudgetExhaustedError(budget)
    yield* []
  })()
}

function runtimeRoot(ctx: Context, sessionId: string, cache: OwnershipCache): string | undefined {
  const agents = ctx.get('agents')
  if (agents === undefined) return undefined
  const live = agents.list()
  if (live.length === 0) return undefined
  let ownerByChild = cache.ownerByChild
  if (ownerByChild === undefined || cache.builtGeneration !== cache.generation) {
    ownerByChild = new Map<string, string>()
    for (const child of live) {
      const childId = String(child.session.id)
      for (const candidate of live) {
        if (String(candidate.session.id) === childId) continue
        if (agents.isOwnedBy(child.session.id, candidate)) {
          ownerByChild.set(childId, String(candidate.session.id))
          break
        }
      }
    }
    cache.ownerByChild = ownerByChild
    cache.builtGeneration = cache.generation
  }
  const agent = agents.get(SessionId(sessionId))
  if (agent === undefined) return undefined
  const visited = new Set<string>()
  let currentId = String(agent.session.id)
  for (;;) {
    if (visited.has(currentId)) return undefined
    visited.add(currentId)
    const ownerId = ownerByChild.get(currentId)
    if (ownerId === undefined) return currentId
    currentId = ownerId
  }
}

function durableRoot(ctx: Context, sessionId: string): string | undefined {
  const first = ctx.sessions.get(SessionId(sessionId))
  if (first === undefined) return undefined
  const visited = new Set<string>()
  let current = first
  while (current.header.origin === 'subagent') {
    if (visited.has(current.id)) return undefined
    visited.add(current.id)
    const parentId = current.header.parentSession
    if (parentId === undefined) return undefined
    const parent = ctx.sessions.get(parentId)
    if (parent === undefined) return undefined
    current = parent
  }
  return current.id
}

function resolveScopeKey(
  ctx: Context,
  store: LedgerStore,
  sessionId: string,
  scope: ScopeMode,
  logger: ReturnType<Context['logger']>,
  cache: OwnershipCache,
): string {
  if (scope === 'session') return sessionId
  const runtime = runtimeRoot(ctx, sessionId, cache)
  if (runtime !== undefined) {
    const indexed = store.lookupScope(sessionId)
    if (indexed !== undefined && indexed !== runtime) {
      logger.warn(
        'agent-budget: corrected scope index for session %s: %s -> %s',
        sessionId,
        indexed,
        runtime,
      )
    }
    store.bindSession(sessionId, runtime)
    return runtime
  }
  const indexed = store.lookupScope(sessionId)
  if (indexed !== undefined) return indexed
  const durable = durableRoot(ctx, sessionId)
  if (durable !== undefined) {
    store.bindSession(sessionId, durable)
    return durable
  }
  logger.warn(
    'agent-budget: cannot resolve tree root for session %s; falling back to an independent budget',
    sessionId,
  )
  store.bindSession(sessionId, sessionId)
  return sessionId
}

function openLedger(
  store: LedgerStore,
  config: Config,
  logger: ReturnType<Context['logger']>,
  scopeKey: string,
): { state: LedgerState; event: LedgerOpen } {
  const state = store.state(scopeKey)
  if (state.open === undefined) {
    const payload = {
      version: EVENT_VERSION,
      scopeKey,
      epochId: randomUUID(),
      limitTokens: config.maxTokens,
    }
    store.appendOpen(scopeKey, payload.epochId, payload.limitTokens)
    logger.info(
      'budget opened: scope=%s epoch=%s limit=%d',
      payload.scopeKey,
      payload.epochId,
      payload.limitTokens,
    )
  }
  if (state.open === undefined) throw new Error('agent-budget: failed to open budget ledger')
  return { state, event: state.open }
}

function budgetStatus(
  store: LedgerStore,
  config: Config,
  scopeKey: string,
  create: boolean,
  logger: ReturnType<Context['logger']>,
  missingUsage: MissingUsagePolicy,
): BudgetStatus {
  const state = create ? openLedger(store, config, logger, scopeKey).state : store.state(scopeKey)
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function scopesOf(store: LedgerStore): string[] {
  return [...store.states.keys()].filter(scopeKey => store.state(scopeKey).open !== undefined)
}

/** Register the shared budget gate, sidecar ledger, and read-only status tool. */
export function apply(ctx: Context, config: Config): void {
  const { missingUsage, scope, storageDir } = validateConfig(config)
  const logger = ctx.logger('agent-budget')
  const store = new LedgerStore(storageDir)
  store.load()
  const ownershipCache = createOwnershipCache()

  // Old plugin versions wrote budget events into session logs. Keep the event
  // vocabulary registered so those logs remain readable while the migration
  // tool removes them; new writes go only to the sidecar ledger.
  if (!(KNOWN_SESSION_EVENT_TYPES instanceof Set)) {
    throw new Error('agent-budget: DSH known-event registry is not extensible')
  }
  for (const type of EVENT_TYPES) KNOWN_SESSION_EVENT_TYPES.add(type)

  ctx.on('agent/created', () => {
    ownershipCache.generation += 1
  })
  ctx.on('agent/disposed', () => {
    ownershipCache.generation += 1
  })

  const createStatus = (scopeKey: string, create: boolean): BudgetStatus => {
    return budgetStatus(store, config, scopeKey, create, logger, missingUsage)
  }

  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined) return next()
    const sessionId = String(options.sessionId)
    const purpose = purposeOf(options)

    // Fail before any ledger write or provider work starts: a subject that
    // cannot be replayed must not be recorded.
    assertSubjectFields({
      sessionId,
      provider: options.provider,
      model: options.model,
      purpose,
    })

    const scopeKey = resolveScopeKey(ctx, store, sessionId, scope, logger, ownershipCache)
    const before = createStatus(scopeKey, true)
    if (before.exhausted) {
      logger.warn(
        'budget exhausted before provider dispatch: scope=%s limit=%d used=%d unmetered=%d',
        scopeKey,
        before.limitTokens,
        before.usedTokens,
        before.unmeteredCalls,
      )
      return denial(before)
    }

    const callId = randomUUID()
    const subject = {
      scopeKey,
      callId,
      sessionId,
      provider: options.provider,
      model: options.model,
      purpose,
    }
    const recordUnmetered = (): void => {
      logger.warn(
        'unmetered llm call recorded: call=%s session=%s provider=%s model=%s',
        subject.callId,
        subject.sessionId,
        subject.provider,
        subject.model,
      )
      store.appendUnmetered(scopeKey, subject)
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
            store.appendSample(scopeKey, { ...subject, usage })
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
      const sessionId = String(exec.agent.session.id)
      const scopeKey = resolveScopeKey(ctx, store, sessionId, scope, logger, ownershipCache)
      return createStatus(scopeKey, false)
    },
    presentCall: () => ({ card: 'generic', title: 'Token budget status', kind: 'other' }),
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/agent-budget/api',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.replace(/^\/agent-budget\/api/, '') || '/'
        if (req.method === 'GET' && path === '/scopes') {
          const scopes: Array<Record<string, unknown>> = []
          for (const scopeKey of scopesOf(store)) {
            const entry: Record<string, unknown> = { scopeKey }
            Object.assign(entry, budgetStatus(store, config, scopeKey, false, logger, missingUsage))
            scopes.push(entry)
          }
          return sendJson(res, 200, { ok: true, scopes })
        }
        if (req.method === 'POST' && path === '/adjust-limit') {
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>
          const scopeKey = typeof body.scopeKey === 'string' ? body.scopeKey.trim() : ''
          const limitTokens = typeof body.limitTokens === 'number' ? body.limitTokens : Number.NaN
          if (scopeKey.length === 0 || !Number.isSafeInteger(limitTokens) || limitTokens < 1) {
            return sendJson(res, 400, { ok: false, error: 'scopeKey and a positive safe integer limitTokens are required' })
          }
          if (store.state(scopeKey).open === undefined) {
            return sendJson(res, 404, { ok: false, error: `scope not found: ${scopeKey}` })
          }
          store.appendAdjust(scopeKey, limitTokens)
          return sendJson(res, 200, {
            ok: true,
            status: budgetStatus(store, config, scopeKey, false, logger, missingUsage),
          })
        }
        if (req.method === 'POST' && path === '/reset') {
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>
          const scopeKey = typeof body.scopeKey === 'string' ? body.scopeKey.trim() : ''
          if (scopeKey.length === 0) {
            return sendJson(res, 400, { ok: false, error: 'scopeKey is required' })
          }
          if (store.state(scopeKey).open === undefined) {
            return sendJson(res, 404, { ok: false, error: `scope not found: ${scopeKey}` })
          }
          store.appendReset(scopeKey)
          return sendJson(res, 200, {
            ok: true,
            status: budgetStatus(store, config, scopeKey, false, logger, missingUsage),
          })
        }
        return sendJson(res, 404, { ok: false, error: `not found: ${path}` })
      } catch (error: unknown) {
        return sendJson(res, 500, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'agent-budget: settings-api')
}
