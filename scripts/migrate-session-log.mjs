#!/usr/bin/env node
/**
 * Migrate legacy budget events out of DSH session logs into the plugin-owned
 * sidecar ledger.
 *
 * Older versions of dsh-plugin-agent-budget wrote budget/* events into
 * session.jsonl(.zstd). DSH readers without the plugin reject those sessions
 * because the event types are not ignorable. This tool:
 *
 *   1. scans ~/.dsh/sessions for .jsonl and .jsonl.zstd artifacts;
 *   2. converts budget/* events into ledger.jsonl / scope-index.json;
 *   3. removes budget/* events from the session log and renumbers the
 *      remaining event seq values (including sourceEventSeqs references);
 *   4. backs up each modified artifact before writing.
 *
 * Run it while DSH is not using the affected profile:
 *   node scripts/migrate-session-log.mjs [--dsh-home <path>]
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EVENT_VERSION = 1
const BUDGET_TYPES = new Set(['budget/open', 'budget/sample', 'budget/unmetered'])
const ZSTD_MAGIC = 0xFD2FB528

function dshHome(override) {
  return override ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function decompressZstd(buffer) {
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (tornStart !== undefined) {
    throw new Error(`incomplete final Zstandard frame at byte ${tornStart}`)
  }
  return frames.map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
}

function compressZstd(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
}

function walkSessions(root) {
  const files = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd')) files.push(full)
    }
  }
  if (existsSync(root)) visit(root)
  return files
}

function readSessionLines(file) {
  if (file.endsWith('.zstd')) {
    const parts = decompressZstd(readFileSync(file))
    return Buffer.concat(parts).toString('utf8').split(/\r?\n/).filter(Boolean)
  }
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
}

function writeSessionLines(file, lines) {
  if (!file.endsWith('.zstd')) {
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    return
  }
  // DSH requires the first zstd frame to contain exactly the header line;
  // event lines go in a separate frame. A single-frame write would make the
  // session unreadable at startup ("first frame is not exactly one header line").
  const [header, ...events] = lines
  if (header === undefined) throw new Error(`empty session log: ${file}`)
  const frames = [compressZstd(`${header}\n`)]
  if (events.length > 0) {
    frames.push(compressZstd(`${events.join('\n')}\n`))
  }
  writeFileSync(file, Buffer.concat(frames))
}

function ledgerLineFor(event) {
  const data = event.data
  if (event.type === 'budget/open') {
    return {
      type: 'open',
      version: EVENT_VERSION,
      scopeKey: data.rootSessionId,
      epochId: data.epochId,
      limitTokens: data.limitTokens,
    }
  }
  if (event.type === 'budget/sample') {
    return {
      type: 'sample',
      version: EVENT_VERSION,
      scopeKey: data.rootSessionId,
      callId: data.callId,
      sessionId: data.sessionId,
      provider: data.provider,
      model: data.model,
      purpose: data.purpose,
      usage: data.usage,
    }
  }
  if (event.type === 'budget/unmetered') {
    return {
      type: 'unmetered',
      version: EVENT_VERSION,
      scopeKey: data.rootSessionId,
      callId: data.callId,
      sessionId: data.sessionId,
      provider: data.provider,
      model: data.model,
      purpose: data.purpose,
    }
  }
  return undefined
}

function backupPath(file) {
  const base = `${file}.bak`
  if (!existsSync(base)) return base
  return `${base}.${Date.now()}`
}

async function validateSession(header, events) {
  try {
    const { Session, SessionId } = await import('@deepseek-ai/dsh-session')
    Session.create(SessionId(header.id), events, header)
  } catch (error) {
    throw new Error(`DSH validation failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function stripBudgetEvents(header, events) {
  const removedSeqs = new Set()
  const ledgerLines = []
  let scopeKey
  for (const event of events) {
    if (!BUDGET_TYPES.has(event.type)) continue
    removedSeqs.add(event.seq)
    if (scopeKey === undefined && event.data?.rootSessionId !== undefined) {
      scopeKey = event.data.rootSessionId
    }
    const converted = ledgerLineFor(event)
    if (converted !== undefined) ledgerLines.push(converted)
  }
  if (scopeKey === undefined || ledgerLines.length === 0) {
    return undefined
  }

  const oldToNew = new Map()
  const filtered = []
  let nextSeq = 0
  for (const event of events) {
    if (removedSeqs.has(event.seq)) continue
    const copy = { ...event, seq: nextSeq }
    if (Array.isArray(copy.sourceEventSeqs)) {
      copy.sourceEventSeqs = copy.sourceEventSeqs.map((source) => {
        const mapped = oldToNew.get(source)
        if (mapped === undefined) {
          throw new Error(
            `session ${header.id}: sourceEventSeqs references removed event seq ${source}`,
          )
        }
        return mapped
      })
    }
    oldToNew.set(event.seq, nextSeq)
    filtered.push(copy)
    nextSeq += 1
  }

  const newHeader = { ...header }
  if (typeof header.seedLength === 'number') {
    let removedBeforeSeed = 0
    for (const seq of removedSeqs) {
      if (seq < header.seedLength) removedBeforeSeed += 1
    }
    newHeader.seedLength = header.seedLength - removedBeforeSeed
  }

  for (let i = 0; i < filtered.length; i += 1) {
    if (filtered[i].seq !== i) {
      throw new Error(`session ${header.id}: internal renumbering invariant failed at index ${i}`)
    }
  }

  return { ledgerLines, scopeKey, filtered, newHeader }
}

export async function migrateSessionLog(homeOverride) {
  const home = dshHome(homeOverride)
  const sessionsRoot = join(home, 'sessions')
  const budgetDir = join(home, 'agent-budget')
  const ledgerPath = join(budgetDir, 'ledger.jsonl')
  const indexPath = join(budgetDir, 'scope-index.json')

  mkdirSync(budgetDir, { recursive: true })

  const scopeIndex = {}
  if (existsSync(indexPath)) {
    Object.assign(scopeIndex, JSON.parse(readFileSync(indexPath, 'utf8')))
  }

  const files = walkSessions(sessionsRoot)
  let migratedFiles = 0
  let removedEvents = 0
  let skipped = 0

  for (const file of files) {
    let lines
    try {
      lines = readSessionLines(file)
    } catch (error) {
      console.warn(`skip unreadable session log ${relative(home, file)}: ${error.message}`)
      skipped += 1
      continue
    }

    let header
    const events = []
    for (const raw of lines) {
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        console.warn(`skip ${relative(home, file)}: malformed JSON line`)
        skipped += 1
        events.length = 0
        break
      }
      if (parsed.type === 'session') header = parsed
      else events.push(parsed)
    }
    if (header === undefined || events.length === 0) continue
    if (!events.some(event => BUDGET_TYPES.has(event.type))) continue

    let result
    try {
      result = stripBudgetEvents(header, events)
    } catch (error) {
      console.warn(`skip ${relative(home, file)}: ${error.message}`)
      skipped += 1
      continue
    }
    if (result === undefined) {
      console.warn(`skip ${relative(home, file)}: budget events have no usable rootSessionId`)
      skipped += 1
      continue
    }

    try {
      await validateSession(result.newHeader, result.filtered)
    } catch (error) {
      console.warn(`skip ${relative(home, file)}: ${error.message}`)
      skipped += 1
      continue
    }

    const backup = backupPath(file)
    copyFileSync(file, backup)
    writeSessionLines(
      file,
      [JSON.stringify(result.newHeader), ...result.filtered.map(event => JSON.stringify(event))],
    )

    for (const line of result.ledgerLines) {
      appendFileSync(ledgerPath, `${JSON.stringify(line)}\n`, 'utf8')
    }
    scopeIndex[header.id] = result.scopeKey
    const fileRemoved = events.filter(event => BUDGET_TYPES.has(event.type)).length
    migratedFiles += 1
    removedEvents += fileRemoved
    console.log(`migrated ${relative(home, file)} (${fileRemoved} events -> ${backup})`)
  }

  if (migratedFiles > 0) {
    writeFileSync(indexPath, `${JSON.stringify(scopeIndex, null, 2)}\n`, 'utf8')
  }

  console.log(
    `done: ${migratedFiles} session log(s) migrated, ${removedEvents} budget event(s) removed, ${skipped} skipped`,
  )
  return { migratedFiles, removedEvents, skipped }
}

async function main() {
  const args = process.argv.slice(2)
  let homeOverride
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--dsh-home') {
      homeOverride = args[i + 1]
      i += 1
    } else {
      console.error(`unknown argument: ${args[i]}`)
      process.exit(2)
    }
  }
  await migrateSessionLog(homeOverride)
}

if (process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`migration failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
