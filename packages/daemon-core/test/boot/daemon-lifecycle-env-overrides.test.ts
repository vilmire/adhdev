import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// initDaemonComponents() has heavy side effects (CDP, providers, seqscribe, …)
// that make a full boot test impractical here, so — matching the existing
// daemon-lifecycle-router-wiring.test.ts pattern — this asserts the WIRING
// property directly from source: persisted env overrides must be applied
// before every other early-boot step that can read a feature flag.
describe('daemon lifecycle env-override wiring', () => {
  const source = readFileSync(join(import.meta.dirname, '../../src/boot/daemon-lifecycle.ts'), 'utf-8')

  it('imports applyDaemonEnvOverrides from config/env-overrides.js', () => {
    expect(source).toContain("import { applyDaemonEnvOverrides } from '../config/env-overrides.js';")
  })

  it('calls applyDaemonEnvOverrides with process.env before ProviderLoader construction', () => {
    const applyCallIndex = source.indexOf('applyDaemonEnvOverrides(')
    const providerLoaderIndex = source.indexOf('new ProviderLoader(')

    expect(applyCallIndex).toBeGreaterThan(-1)
    expect(providerLoaderIndex).toBeGreaterThan(-1)
    expect(applyCallIndex).toBeLessThan(providerLoaderIndex)
  })

  it('calls applyDaemonEnvOverrides before the process-hardening/log-interceptor boot steps finish setting up', () => {
    // Not strictly "before everything" (LOG must exist first), but must land
    // before any lazy env-flag read elsewhere in the daemon can plausibly run —
    // i.e. before the provider-channel migration / ProviderLoader section.
    const applyCallIndex = source.indexOf('applyDaemonEnvOverrides(')
    const migrationIndex = source.indexOf('migrateProviderChannelConfig')

    expect(applyCallIndex).toBeGreaterThan(-1)
    expect(migrationIndex).toBeGreaterThan(-1)
    expect(applyCallIndex).toBeLessThan(migrationIndex)
  })

  it('passes process.env (not a snapshot) so the applied values are visible to later reads', () => {
    const applyCallBlock = source.slice(
      source.indexOf('applyDaemonEnvOverrides('),
      source.indexOf('applyDaemonEnvOverrides(') + 200,
    )
    expect(applyCallBlock).toContain('process.env')
  })
})
