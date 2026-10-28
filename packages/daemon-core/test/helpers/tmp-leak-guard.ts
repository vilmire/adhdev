import { afterAll } from 'vitest'
// Wraps mkdtemp*/mkdir under the OS temp dir for this test process and records
// what it creates (mesh mission 8679dacb — see the module for the full rationale).
import { removeTrackedTempDirs } from '../../../../scripts/test-tmp-guard.mjs'

async function closeMeshStore(): Promise<void> {
  try {
    const { __resetMeshRuntimeStoreForTests } = await import('../../src/mesh/mesh-work-queue.js')
    __resetMeshRuntimeStoreForTests()
  } catch { /* store module not loaded */ }
}

// File-level afterAll (runs after the file's own hooks): close the process-wide
// mesh runtime sqlite singleton first (win32 cannot unlink an open db), then
// remove every directory this test file created. Production code schedules
// setImmediate/timer work (e.g. mesh-event-forwarding -> maybeAutoFastForwardIdleNode)
// that can re-open the store and re-create the config dir AFTER the file's own
// cleanup, so yield a few event-loop turns and sweep again each time.
afterAll(async () => {
  for (let i = 0; i < 4; i += 1) {
    await closeMeshStore()
    removeTrackedTempDirs()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  await closeMeshStore()
  removeTrackedTempDirs()
})
