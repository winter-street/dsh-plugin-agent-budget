import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'

const MAX_BODY_BYTES = 16 * 1024

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLoopback(address: string): boolean {
  if (address === '::1') return true
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address
  return isIP(ipv4) === 4 && ipv4.startsWith('127.')
}

/** The host route registry provides no authentication boundary. */
export function authorizeRequest(req: IncomingMessage): void {
  if (!isLoopback(req.socket.remoteAddress ?? '')) {
    throw new HttpError(403, 'budget administration is only available over loopback')
  }
  const host = req.headers.host
  if (!host || !/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/i.test(host)) {
    throw new HttpError(403, 'invalid local Host header')
  }
  const scheme = 'encrypted' in req.socket && req.socket.encrypted ? 'https' : 'http'
  const expectedOrigin = new URL(`${scheme}://${host}`).origin
  if (req.headers.origin !== undefined && req.headers.origin !== expectedOrigin) {
    throw new HttpError(403, 'cross-origin requests are forbidden')
  }
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'cross-site requests are forbidden')
  }
  if (req.method === 'POST') {
    if (req.headers['x-agent-budget-request'] !== '1') {
      throw new HttpError(403, 'X-Agent-Budget-Request: 1 is required')
    }
    const contentType = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      throw new HttpError(415, 'Content-Type must be application/json')
    }
    if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') {
      throw new HttpError(415, 'compressed request bodies are not supported')
    }
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const length = req.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new HttpError(413, 'request body exceeds 16 KiB')
  }
  const chunks: Buffer[] = []
  let size = 0
  // iterator({ destroyOnReturn: false }) allows a 413 response before closing
  // an oversized chunked request instead of resetting the socket immediately.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body exceeds 16 KiB')
    chunks.push(buffer)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'request body must contain valid JSON')
  }
  if (!isRecord(value)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  return value
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(status >= 400 ? { connection: 'close' } : {}),
  })
  res.end(JSON.stringify(body))
}
