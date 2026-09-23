/**
 * S2 runChannelBootSync (wiring-unification B4). Replaces the source-text guard
 * in enabled-unchecked-boot-race.test.ts: after a verified-channel sync
 * ACTIVATES providers, boot must re-detect (registerToDetector + a full
 * availability refresh) — the sync's own loadAll() cleared providerAvailability,
 * so providers enabled before it landed would otherwise read `enabled_unchecked`
 * forever. The outcome is RETURNED (S3 turns it into daemon_facts) instead of
 * calling a host callback.
 */
import { describe, expect, it, vi } from 'vitest'
import { runChannelBootSync } from '../../src/boot/stages/providers.js'

function loader(first: any, update: any = null) {
  const log: string[] = []
  return {
    log,
    channel: 'stable',
    maybeFirstSyncVerifiedChannel: vi.fn(async () => { log.push('first'); return first }),
    maybeSyncVerifiedChannelOnDaemonUpdate: vi.fn(async () => { log.push('update'); return update }),
    registerToDetector: vi.fn(() => { log.push('registerToDetector') }),
  }
}

describe('runChannelBootSync', () => {
  it('first-sync activation re-detects and reports the activation count; the update sync does not run', async () => {
    const l = loader({ status: 'ok', activated: ['a', 'b'], errors: [] })
    const refresh = vi.fn(async () => { l.log.push('refresh') })
    await expect(runChannelBootSync(l as any, refresh)).resolves.toEqual({ activated: 2 })
    expect(l.log).toEqual(['first', 'registerToDetector', 'refresh'])
  })

  it('no first-sync → the daemon-update sync runs AFTER it (never concurrently) and re-detects on activation', async () => {
    const l = loader(null, { status: 'ok', activated: ['a'], errors: [] })
    const refresh = vi.fn(async () => { l.log.push('refresh') })
    await expect(runChannelBootSync(l as any, refresh)).resolves.toEqual({ activated: 1 })
    expect(l.log).toEqual(['first', 'update', 'registerToDetector', 'refresh'])
  })

  it('an error or an empty activation re-detects nothing and reports 0; a throw never rejects', async () => {
    const errored = loader(null, { status: 'error', activated: [], errors: [{ code: 'x', message: 'y' }] })
    const refresh = vi.fn(async () => {})
    await expect(runChannelBootSync(errored as any, refresh)).resolves.toEqual({ activated: 0 })
    expect(refresh).not.toHaveBeenCalled()

    const throwing = loader(null)
    throwing.maybeFirstSyncVerifiedChannel = vi.fn(async () => { throw new Error('registry down') })
    await expect(runChannelBootSync(throwing as any, refresh)).resolves.toEqual({ activated: 0 })
  })
})
