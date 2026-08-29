import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateSessionLog } from '../scripts/migrate-session-log.mjs'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-budget-migrate-test-'))
  tempDirs.push(dir)
  return dir
}

function compressFrame(text: string): Buffer {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

function writeZstdSession(file: string, header: string, events: string[]): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const frames = [compressFrame(`${header}\n`)]
  if (events.length > 0) {
    frames.push(compressFrame(`${events.join('\n')}\n`))
  }
  writeFileSync(file, Buffer.concat(frames))
}

function scanFrames(buffer: Buffer): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    expect(buffer.length - offset).toBeGreaterThanOrEqual(4)
    expect(buffer.readUInt32LE(offset)).toBe(0xfd2fb528)
    offset += 4
    expect(buffer.length - offset).toBeGreaterThanOrEqual(1)
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    offset += remainingHeaderBytes
    for (;;) {
      expect(buffer.length - offset).toBeGreaterThanOrEqual(3)
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

function framesText(buffer: Buffer): string[] {
  return scanFrames(buffer).map(frame =>
    zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'))
}

describe('migrate-session-log', () => {
  it('migrates a multi-frame zstd session and preserves header/event frame layout', async () => {
    const home = tempHome()
    const sessionDir = join(home, 'sessions', 'project')
    const file = join(sessionDir, 'session-123.jsonl.zstd')
    const header = JSON.stringify({
      type: 'session',
      version: 0,
      id: 'session-123',
      createdAt: 1,
    })
    const events = [
      JSON.stringify({
        type: 'budget/open',
        seq: 0,
        time: 1,
        data: {
          version: 1,
          rootSessionId: 'session-123',
          epochId: 'epoch-1',
          limitTokens: 100,
        },
      }),
      JSON.stringify({
        type: 'budget/sample',
        seq: 1,
        time: 2,
        data: {
          version: 1,
          rootSessionId: 'session-123',
          epochId: 'epoch-1',
          callId: 'call-1',
          sessionId: 'session-123',
          provider: 'mock',
          model: 'mock-model',
          purpose: 'conversation',
          usage: {
            inputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 2,
          },
        },
      }),
      JSON.stringify({ type: 'turn/start', seq: 2, time: 3, data: { turn: 1 } }),
    ]
    writeZstdSession(file, header, events)

    const result = await migrateSessionLog(home)
    expect(result.migratedFiles).toBe(1)
    expect(result.removedEvents).toBe(2)

    const migrated = framesText(readFileSync(file))
    expect(migrated).toHaveLength(2)
    expect(migrated[0]?.trim()).toBe(header)
    const remaining = migrated[1]!.trim().split('\n')
    expect(remaining).toHaveLength(1)
    expect(JSON.parse(remaining[0]!)).toMatchObject({ type: 'turn/start', seq: 0 })

    const ledger = readFileSync(join(home, 'agent-budget', 'ledger.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(ledger).toHaveLength(2)
    expect(ledger[0]).toMatchObject({ type: 'open', scopeKey: 'session-123' })
    expect(ledger[1]).toMatchObject({ type: 'sample', callId: 'call-1' })

    const index = JSON.parse(
      readFileSync(join(home, 'agent-budget', 'scope-index.json'), 'utf8'),
    )
    expect(index).toEqual({ 'session-123': 'session-123' })
    expect(existsSync(`${file}.bak`)).toBe(true)
  })

  it('omits the event frame when no events remain after migration', async () => {
    const home = tempHome()
    const sessionDir = join(home, 'sessions', 'project')
    const file = join(sessionDir, 'session-456.jsonl.zstd')
    const header = JSON.stringify({
      type: 'session',
      version: 0,
      id: 'session-456',
      createdAt: 1,
    })
    const events = [
      JSON.stringify({
        type: 'budget/open',
        seq: 0,
        time: 1,
        data: {
          version: 1,
          rootSessionId: 'session-456',
          epochId: 'epoch-1',
          limitTokens: 100,
        },
      }),
    ]
    writeZstdSession(file, header, events)

    const result = await migrateSessionLog(home)
    expect(result.migratedFiles).toBe(1)
    expect(result.removedEvents).toBe(1)

    const migrated = framesText(readFileSync(file))
    expect(migrated).toHaveLength(1)
    expect(migrated[0]!.trim()).toBe(header)
    expect(existsSync(`${file}.bak`)).toBe(true)
  })

})
