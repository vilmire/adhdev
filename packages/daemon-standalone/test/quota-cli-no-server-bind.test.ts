import * as assert from 'node:assert/strict'
import * as net from 'node:net'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

// Regression pin for a live defect: `adhdev quota <provider>` must never
// reach server bootstrap (initDaemonComponents / http listen). If the quota
// dispatch in main() is reordered to run after arg parsing or server start,
// running `quota` while a standalone daemon already occupies the default
// port fails with EADDRINUSE instead of printing quota — exactly what
// shipped and broke on a real Mac with standalone already running.
//
// This exercises the actual CLI entrypoint (via tsx, matching the `dev`
// script) rather than daemon-core internals, because the bug is about
// *ordering* inside daemon-standalone's own main(), not anything daemon-core
// does at import time.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_PORT = 3847

test('adhdev quota <provider> succeeds even when the default port is already bound', async (t) => {
  const occupier = net.createServer()
  let ownsPort = false
  try {
    await new Promise<void>((resolve, reject) => {
      occupier.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          // Something else already holds the port (e.g. a dev daemon) —
          // the invariant we're testing (port occupied) still holds.
          resolve()
        } else {
          reject(err)
        }
      })
      occupier.listen(DEFAULT_PORT, '127.0.0.1', () => {
        ownsPort = true
        resolve()
      })
    })

    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(packageRoot, 'src/index.ts'), 'quota', 'codex'],
      { cwd: packageRoot, encoding: 'utf8', timeout: 30_000 },
    )

    assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr:\n${result.stderr}`)
    assert.doesNotMatch(result.stderr, /EADDRINUSE/)
    // No server/daemon bootstrap noise — quota must not initialize the daemon.
    assert.doesNotMatch(result.stdout, /ProviderLoader/)
    assert.doesNotMatch(result.stdout, /\[Mesh\]/)
    assert.doesNotMatch(result.stdout, /\[Refinery\]/)
    // The actual quota output must be present.
    assert.match(result.stdout, /Codex CLI/)
  } finally {
    if (ownsPort) {
      await new Promise<void>((resolve) => occupier.close(() => resolve()))
    }
  }
})
