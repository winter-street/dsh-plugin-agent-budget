import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const loggerMock = Object.assign(
  (_name?: string) => loggerMock,
  {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  },
)

export type StreamHandler = (
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
) => AsyncIterable<StreamChunk>

type RequestErrorHandler = (
  payload: { failure: { code: string } },
  next: () => Promise<unknown>,
) => Promise<unknown>

export class TestHarness {
  readonly sessionsById = new Map<string, Session>()
  readonly streamHandlers: StreamHandler[] = []
  readonly requestErrorHandlers: RequestErrorHandler[] = []
  readonly storageDir: string
  tool: ToolDefinition | undefined

  readonly context = {
    get: () => undefined,
    logger: loggerMock,
    sessions: {
      get: (id: string) => this.sessionsById.get(id),
      list: () => [...this.sessionsById.values()],
    },
    tools: {
      register: (tool: ToolDefinition) => {
        this.tool = tool
        return () => {
          if (this.tool === tool) this.tool = undefined
        }
      },
    },
    on: (name: string, handler: unknown) => {
      if (name === 'llm/stream') this.streamHandlers.push(handler as StreamHandler)
      if (name === 'agent/request-error') this.requestErrorHandlers.push(handler as RequestErrorHandler)
      return () => undefined
    },
  } as unknown as Context

  constructor(config: Config) {
    this.storageDir = config.storageDir ?? mkdtempSync(join(tmpdir(), 'agent-budget-test-'))
    apply(this.context, {
      maxTokens: config.maxTokens,
      ...config.missingUsage === undefined ? {} : { missingUsage: config.missingUsage },
      ...config.scope === undefined ? {} : { scope: config.scope },
      storageDir: this.storageDir,
    })
  }

  add(session: Session): Session {
    this.sessionsById.set(session.id, session)
    return session
  }

  root(id: string): Session {
    return this.add(Session.create(SessionId(id)))
  }

  child(id: string, parent: Session): Session {
    return this.add(Session.create(SessionId(id), undefined, header(id, {
      parentSession: parent.id,
      origin: 'subagent',
    })))
  }

  fork(id: string, parent: Session): Session {
    return this.add(Session.create(SessionId(id), parent.events, header(id, {
      parentSession: parent.id,
      seedLength: parent.events.length,
    })))
  }

  resume(session: Session): Session {
    return this.add(Session.create(session.id, session.events, session.header))
  }

  async stream(
    session: Session | undefined,
    chunks: readonly StreamChunk[],
    extra: Partial<GenerateOptions> = {},
    onProviderCall?: () => void,
  ): Promise<StreamChunk[]> {
    const handler = this.streamHandlers[0]
    if (handler === undefined) throw new Error('stream handler was not registered')
    const options: GenerateOptions = {
      provider: 'mock',
      model: 'mock-model',
      messages: [],
      ...(session === undefined ? {} : { sessionId: session.id }),
      ...extra,
    }
    return Array.fromAsync(handler(options, () => {
      onProviderCall?.()
      return source(chunks)
    }))
  }

  async status(session: Session): Promise<Record<string, unknown>> {
    if (this.tool === undefined) throw new Error('status tool was not registered')
    const value = await this.tool.execute({}, {
      agent: { session },
    } as never)
    return value as Record<string, unknown>
  }

  ledgerLines(): Record<string, unknown>[] {
    const file = join(this.storageDir, 'ledger.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }
}

function header(
  id: string,
  lineage: Partial<Pick<SessionHeader, 'parentSession' | 'origin' | 'seedLength'>>,
): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now(),
    ...lineage,
  }
}

export function usage(values: Partial<TokenUsage> = {}): StreamChunk {
  return {
    type: 'usage',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      ...values,
    },
  }
}

export function finish(kind: 'stop' | 'error' = 'stop'): StreamChunk {
  return kind === 'stop'
    ? { type: 'finish', reason: { kind: 'stop' } }
    : {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'provider failed', code: 'SERVER' },
        },
      }
}

export function text(value = 'ok'): StreamChunk {
  return { type: 'text-delta', index: 0, text: value }
}

async function* source(chunks: readonly StreamChunk[]): AsyncGenerator<StreamChunk> {
  for (const chunk of chunks) yield chunk
}
