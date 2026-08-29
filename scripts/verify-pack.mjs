import { execFileSync, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Keep the scratch area inside the workspace so restricted environments that
// only allow workspace writes can still run `npm pack`.
const root = fileURLToPath(new URL('../', import.meta.url))
const directory = mkdtempSync(join(root, '.dsh-agent-budget-pack-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const publint = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'publint.cmd' : 'publint',
)
try {
  const npmEnvironment = { ...process.env, npm_config_cache: join(directory, '.npm-cache') }
  // Run publint with its full pack check first. In restricted sandboxes its
  // pack step fails to spawn a piped package-manager child, so retry with
  // `--pack false` (metadata only) and rely on our own npm pack step below.
  const publintOutPath = join(directory, 'publint.out.txt')
  const publintErrPath = join(directory, 'publint.err.txt')
  const publintOutFd = openSync(publintOutPath, 'w')
  const publintErrFd = openSync(publintErrPath, 'w')
  const publintResult = spawnSync(publint, ['.'], {
    env: npmEnvironment,
    shell: process.platform === 'win32',
    stdio: ['ignore', publintOutFd, publintErrFd],
  })
  closeSync(publintOutFd)
  closeSync(publintErrFd)
  const publintStdout = readFileSync(publintOutPath, 'utf8')
  const publintStderr = readFileSync(publintErrPath, 'utf8')
  if (publintResult.error !== undefined) throw publintResult.error
  if (publintResult.status !== 0) {
    const spawnFailure = /spawn EPERM|Failed to spawn|os error 5|拒绝访问|EPERM/i.test(publintStdout)
      || /spawn EPERM|Failed to spawn|os error 5|拒绝访问|EPERM/i.test(publintStderr)
    if (!spawnFailure) {
      process.stdout.write(publintStdout)
      process.stderr.write(publintStderr)
      throw new Error(`publint exited with code ${publintResult.status}`)
    }
    process.stdout.write('publint pack step is unavailable in this sandbox; re-running with --pack false\n')
    execFileSync(publint, ['.', '--pack', 'false'], {
      env: npmEnvironment,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
  } else {
    process.stdout.write(publintStdout)
  }

  // Write npm's JSON report to a file descriptor instead of capturing stdout
  // through a Node pipe, so restricted environments that block pipe-spawn can
  // still run the archive verification.
  const packJsonPath = join(directory, 'pack.json')
  const packErrPath = join(directory, 'pack.err.txt')
  const packJsonFd = openSync(packJsonPath, 'w')
  const packErrFd = openSync(packErrPath, 'w')
  const packResult = spawnSync(npm, [
    'pack',
    '--pack-destination', directory,
    '--ignore-scripts',
    '--json',
  ], {
    env: npmEnvironment,
    shell: process.platform === 'win32',
    stdio: ['ignore', packJsonFd, packErrFd],
  })
  closeSync(packJsonFd)
  closeSync(packErrFd)
  if (packResult.error !== undefined) throw packResult.error
  if (packResult.status !== 0) {
    process.stderr.write(readFileSync(packErrPath, 'utf8'))
    throw new Error(`npm pack exited with code ${packResult.status}`)
  }
  const report = readFileSync(packJsonPath, 'utf8')
  // `npm pack` may run the package `prepare` script before printing its JSON
  // report, so the file can contain build logs ahead of the JSON array. Build
  // logs can include ANSI color codes such as "[34m", so find the JSON array by
  // its actual shape (`[` followed by an object) instead of the first `[`.
  const jsonStart = report.search(/\[\s*\{/)
  if (jsonStart === -1) throw new Error('npm pack produced no JSON report')
  const packed = JSON.parse(report.slice(jsonStart))[0]
  if (!packed?.filename) throw new Error('npm pack did not report an archive')
  const names = new Set(packed.files.map(file => file.path))
  for (const required of ['lib/index.js', 'lib/index.d.ts', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE']) {
    if (!names.has(required)) throw new Error(`packed artifact is missing ${required}`)
  }
  if (names.has('examples/cordis.patch.yml')) {
    throw new Error('packed artifact must not contain the stale examples/cordis.patch.yml')
  }
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (packageJson.name !== 'dsh-plugin-agent-budget') throw new Error('unexpected package name')
  const patch = packageJson.dsh?.bundle?.patch
  if (patch === undefined) throw new Error('package.json must declare dsh.bundle.patch')
  if (!names.has(patch.replace(/^\.\//, ''))) {
    throw new Error(`dsh.bundle.patch (${patch}) is not included in the packed artifact`)
  }

  if (process.env.PACK_INSTALL === '1') {
    const consumer = join(directory, 'consumer')
    mkdirSync(consumer)
    execFileSync(npm, ['init', '--yes'], {
      cwd: consumer,
      env: npmEnvironment,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    })
    execFileSync(npm, ['install', join(directory, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: consumer,
      env: npmEnvironment,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      "import('dsh-plugin-agent-budget').then(m => { if (Object.keys(m).sort().join(',') !== 'Config,apply,inject,name') process.exit(1) })",
    ], { cwd: consumer, stdio: 'inherit' })
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
