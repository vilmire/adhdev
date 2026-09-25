import { describe, expect, it } from 'vitest'
import {
    interpretProviderChannelSyncResult,
    unwrapDaemonCommandBody,
} from '../../src/utils/provider-channel-sync'

describe('unwrapDaemonCommandBody', () => {
    it('accepts standalone raw bodies and cloud { result } envelopes', () => {
        expect(unwrapDaemonCommandBody({ success: true, activated: [] })).toEqual({ success: true, activated: [] })
        expect(unwrapDaemonCommandBody({ success: true, result: { success: true, activated: [1] } })).toEqual({
            success: true,
            activated: [1],
        })
        expect(unwrapDaemonCommandBody(null)).toBeUndefined()
    })
})

describe('interpretProviderChannelSyncResult', () => {
    it('treats a moved pin as success', () => {
        expect(interpretProviderChannelSyncResult({
            success: true,
            activated: [{ type: 'opencode', from: '1.0.0', to: '1.1.0' }],
        })).toEqual({ ok: true, activatedCount: 1 })
    })

    it('unwraps the cloud P2P envelope', () => {
        expect(interpretProviderChannelSyncResult({
            success: true,
            result: { success: true, activated: [] },
        })).toEqual({ ok: true, activatedCount: 0 })
    })

    it('surfaces a daemon-level failure', () => {
        expect(interpretProviderChannelSyncResult({
            success: true,
            result: { success: false, error: 'ProviderLoader not initialized' },
        })).toEqual({ ok: false, error: 'ProviderLoader not initialized' })
    })

    it('surfaces channelSync.status === error even when success is true', () => {
        expect(interpretProviderChannelSyncResult({
            success: true,
            activated: [],
            channelSync: { status: 'error', errors: [{ message: 'digest mismatch' }] },
        })).toEqual({ ok: false, error: 'digest mismatch' })
    })
})
