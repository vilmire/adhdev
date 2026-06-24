import { rm } from 'node:fs/promises'

/**
 * Cross-platform temp-dir teardown for tests that point ADHDEV_CONFIG_DIR at a
 * `mkdtemp` directory and exercise the mesh runtime.
 *
 * Two Windows-specific hazards this guards against — both of which surface as a
 * real test failure (an EBUSY/EPERM thrown out of a `finally` block), NOT as a
 * weakened assertion:
 *
 *  1. Open sqlite handle. `MeshRuntimeStore` is a process-wide singleton holding
 *     an open `better-sqlite3` handle on `<configDir>/mesh-ledger/mesh-runtime.db`
 *     (plus its `-wal`/`-shm` companions). On POSIX an open file can be unlinked;
 *     on win32 it cannot — `rm(configDir, { recursive: true })` then throws
 *     `EBUSY: resource busy or locked, unlink ...mesh-runtime.db`. We therefore
 *     CLOSE the store before removing the directory. The close is idempotent and
 *     a no-op when no store was ever opened, so it is safe to call on every temp
 *     dir (including pure git fixtures). It also prevents the singleton from
 *     leaking a stale handle — pointed at an already-removed dir — into the next
 *     test in the file.
 *
 *  2. Async handle release. Even after an explicit close, win32 can hold the
 *     directory busy for a few milliseconds while the OS finishes releasing
 *     handles (sqlite, or a just-exited `git` child). A single `rm` can still hit
 *     EBUSY/EPERM/ENOTEMPTY, so we retry with a short backoff.
 */
export async function cleanupTempDir(path: string): Promise<void> {
  await resetMeshRuntimeStore()
  await rmDirWithRetry(path)
}

/** Close the process-wide mesh runtime sqlite store, if it was opened. Idempotent. */
export async function resetMeshRuntimeStore(): Promise<void> {
  try {
    const { __resetMeshRuntimeStoreForTests } = await import('../../src/mesh/mesh-work-queue.js')
    __resetMeshRuntimeStoreForTests()
  } catch {
    // Store module not loaded / never opened — nothing to close.
  }
}

/**
 * `rm(path, { recursive: true, force: true })` with a bounded retry on the win32
 * handle-release races (EBUSY/EPERM/ENOTEMPTY). On the final attempt the error is
 * re-thrown unchanged so a genuinely undeletable path still fails the test.
 */
export async function rmDirWithRetry(path: string, attempts = 10): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (err: any) {
      const code = err?.code
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY'
      if (!transient || i === attempts - 1) throw err
      await new Promise(resolve => setTimeout(resolve, 50 * (i + 1)))
    }
  }
}
