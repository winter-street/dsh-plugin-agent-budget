// Runs oxlint with type-aware rules when possible, and falls back to the same
// rule set without type-aware rules only when the tsgolint helper cannot be
// spawned in a restricted sandbox. `tsc --noEmit` remains the type gate.
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const oxlint = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'oxlint.CMD' : 'oxlint',
)

function run(args) {
  const dir = mkdtempSync(join(root, '.lint-check-'))
  const outPath = join(dir, 'out.txt')
  const errPath = join(dir, 'err.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  const result = spawnSync(oxlint, args, {
    cwd: root,
    shell: process.platform === 'win32',
    stdio: ['ignore', outFd, errFd],
  })
  closeSync(outFd)
  closeSync(errFd)
  const stdout = readFileSync(outPath, 'utf8')
  const stderr = readFileSync(errPath, 'utf8')
  rmSync(dir, { recursive: true, force: true })
  if (result.error !== undefined) throw result.error
  return { status: result.status ?? 1, stdout, stderr }
}

const typed = run(['--type-aware', '-c', 'oxlint.json', 'src', 'tests'])
if (typed.status === 0) {
  process.stdout.write(typed.stdout)
  process.exit(0)
}

const spawnFailure = /Failed to spawn tsgolint|os error 5|拒绝访问|EPERM/i.test(typed.stdout)
  || /Failed to spawn tsgolint|os error 5|拒绝访问|EPERM/i.test(typed.stderr)
if (!spawnFailure) {
  process.stdout.write(typed.stdout)
  process.stderr.write(typed.stderr)
  process.exit(typed.status)
}

process.stderr.write('oxlint: type-aware rules unavailable in this environment (tsgolint spawn is blocked); re-running without type-aware rules\n')

// Sandbox fallback: type-aware oxlint cannot spawn its tsgolint helper here.
const dir = mkdtempSync(join(root, '.lint-fallback-'))
const configPath = join(dir, 'oxlint.notype.json')
writeFileSync(configPath, `${JSON.stringify({
  categories: {
    correctness: 'error',
    suspicious: 'error',
    perf: 'warn',
  },
  options: {
    typeAware: false,
    reportUnusedDisableDirectives: 'error',
  },
  ignorePatterns: ['lib/**', 'coverage/**', 'node_modules/**'],
  overrides: [
    {
      files: ['tests/**/*.ts'],
      rules: {
        'typescript/no-unsafe-type-assertion': 'off',
      },
    },
  ],
}, null, 2)}\n`)
const fallback = run(['-c', configPath, 'src', 'tests'])
rmSync(dir, { recursive: true, force: true })
process.stdout.write(fallback.stdout)
process.stderr.write(fallback.stderr)
process.exit(fallback.status)
