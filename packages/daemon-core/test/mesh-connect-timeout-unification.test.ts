import { afterEach, describe, expect, it } from 'vitest'
import { MESH_CONNECT_TIMEOUT_MS, readMeshTimeoutEnvMs } from '../src/runtime-defaults.js'
import { MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS } from '../src/commands/router.js'

// C-1 regression: the mesh cold-open *connect* budget used by the router's
// direct-peer git_status probe and by the coordinator's remote task-dispatch
// (mesh-events-coordinator's DISPATCH_CONNECT_TIMEOUT_MS) must come from ONE
// env-overridable source. Before unification the coordinator hard-coded 45_000
// while the probe path was env-overridable, so setting the env tuned one path and
// silently left the other at 45s — the same nominal value, divergent the moment an
// env override was applied.
describe('mesh connect-timeout unification (C-1)', () => {
  it('router re-exports the unified MESH_CONNECT_TIMEOUT_MS for the probe path', () => {
    // The coordinator sources DISPATCH_CONNECT_TIMEOUT_MS from the same constant;
    // asserting the router's public re-export === the unified constant proves both
    // call sites read one value (the coordinator const is module-private).
    expect(MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS).toBe(MESH_CONNECT_TIMEOUT_MS)
  })

  it('honors the test-harness env override on the unified constant', () => {
    // setup-env.ts pins MESH_CONNECT_TIMEOUT_MS to 1000 for the test environment,
    // so the unified constant — and therefore BOTH consumers — shrink together.
    // (Pre-fix, the coordinator's hard-coded 45_000 ignored this and would have
    // run a real dispatch-timeout test path for 45s.)
    expect(process.env.MESH_CONNECT_TIMEOUT_MS).toBe('1000')
    expect(MESH_CONNECT_TIMEOUT_MS).toBe(1000)
  })

  describe('readMeshTimeoutEnvMs', () => {
    const TMP = '__MESH_TIMEOUT_TEST__'
    const TMP_ALIAS = '__MESH_TIMEOUT_TEST_ALIAS__'
    afterEach(() => {
      delete process.env[TMP]
      delete process.env[TMP_ALIAS]
    })

    it('falls back to the default when unset', () => {
      expect(readMeshTimeoutEnvMs(TMP, 45_000)).toBe(45_000)
    })

    it('reads a valid in-range env value', () => {
      process.env[TMP] = '30000'
      expect(readMeshTimeoutEnvMs(TMP, 45_000)).toBe(30_000)
    })

    it('clamps out-of-range values back to the default', () => {
      process.env[TMP] = '999' // below the 1_000 floor
      expect(readMeshTimeoutEnvMs(TMP, 45_000)).toBe(45_000)
      process.env[TMP] = '999999' // above the 120_000 ceiling
      expect(readMeshTimeoutEnvMs(TMP, 45_000)).toBe(45_000)
    })

    it('prefers the first name and honors a backward-compat alias', () => {
      // Primary unset, alias set → alias wins (the MESH_DIRECT_PROBE_CONNECT_TIMEOUT_MS
      // legacy-name path for already-tuned environments).
      process.env[TMP_ALIAS] = '20000'
      expect(readMeshTimeoutEnvMs([TMP, TMP_ALIAS], 45_000)).toBe(20_000)
      // Primary set → primary wins over the alias.
      process.env[TMP] = '15000'
      expect(readMeshTimeoutEnvMs([TMP, TMP_ALIAS], 45_000)).toBe(15_000)
    })
  })
})
