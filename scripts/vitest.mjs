// Runs the Vitest CLI with the Vite `net use` probe disabled for restricted
// Windows sandboxes. Use worker_threads (see vitest.config.ts) so tests do not
// need to spawn child processes.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const patch = new URL('./vitest-netuse-patch.mjs', import.meta.url).href
const vitestCli = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
const result = spawnSync(process.execPath, ['--import', patch, vitestCli, ...process.argv.slice(2)], {
  stdio: 'inherit',
})
if (result.error !== undefined) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
