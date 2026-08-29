// Restricted Windows sandboxes block Vite's `net use` probe (it spawns a
// piped child process). Vite only uses the probe to map network drives for
// realpath resolution; skipping it is safe for local workspaces.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const originalExec = childProcess.exec

childProcess.exec = function exec(command, options, callback) {
  if (typeof command === 'string' && command === 'net use') {
    const cb = typeof options === 'function' ? options : callback
    if (cb === undefined) return undefined
    const error = new Error('Vite net-use probe disabled for restricted sandboxes')
    error.code = 'ENOENT'
    cb(error, '', '')
    return undefined
  }
  return originalExec.call(this, command, options, callback)
}
