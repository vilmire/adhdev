import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { sweepTempManifest } from '../../../../scripts/test-tmp-guard.mjs'

/**
 * Vitest globalSetup (mesh mission 8679dacb): run-scoped safety net behind the
 * per-file cleanup in helpers/tmp-leak-guard.ts. Workers append every temp dir
 * they create to a manifest (ADHDEV_TEST_TMP_MANIFEST, inherited by the forks);
 * after the run we remove whatever is still there — dirs of workers that were
 * killed, files that failed to load or were skipped (their afterAll never runs).
 * Exact manifest paths only, so concurrent runs on the same machine are safe.
 * Never fails the run; it only warns so a new leak class is visible.
 */
export default function setup(): () => void {
  const manifest = path.join(os.tmpdir(), `adhdev-test-run-${process.pid}-${Date.now()}.list`)
  process.env.ADHDEV_TEST_TMP_MANIFEST = manifest
  return () => {
    const leaked = sweepTempManifest(manifest)
    delete process.env.ADHDEV_TEST_TMP_MANIFEST
    if (leaked > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[tmp-leak-guard] ${leaked} temp dir(s) outlived their test file's cleanup and were removed by the run-level sweep`)
    }
  }
}
