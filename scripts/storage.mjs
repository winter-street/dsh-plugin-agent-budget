import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** An exclusive writer lease. Crash leftovers require explicit operator recovery. */
export function acquireStorageLock(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'writer.lock')
  const identity = JSON.stringify({ pid: process.pid, id: randomUUID() }) + '\n'
  let fd
  try {
    fd = openSync(file, 'wx', 0o600)
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`agent-budget: storage is locked at ${file}; stop the other writer, or remove a stale lock only after confirming no writer is running`)
    }
    throw error
  }
  try {
    writeFileSync(fd, identity)
    fsyncSync(fd)
  } catch (error) {
    unlinkSync(file)
    throw error
  } finally {
    closeSync(fd)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (readFileSync(file, 'utf8') === identity) unlinkSync(file)
  }
}

export function writeAtomic(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`
  let fd
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, content)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
