import { describe, expect, it } from 'vitest'
import { normalizeReadChatCommandStatus } from '../../src/commands/read-chat-presentation.js'

// READ-CHAT-STATUS-CLAMP (owner-visible failure 2026-08-24): a worker session
// whose turn projection surfaced raw 'stopped' failed EVERY read_chat for a
// day in a 2s loop — one unknown status token cost the whole transcript. The
// normalizer must clamp anything outside the contract instead of passing it
// through to the validator.
describe('normalizeReadChatCommandStatus — contract clamp', () => {
    it('maps the known non-contract lifecycle tokens to error', () => {
        for (const raw of ['stopped', 'disconnected', 'not_monitored']) {
            expect(normalizeReadChatCommandStatus(raw, undefined)).toBe('error')
        }
    })

    it('clamps an UNKNOWN token to no_progress instead of passing it through', () => {
        expect(normalizeReadChatCommandStatus('totally_new_state', undefined)).toBe('no_progress')
    })

    it('an unknown token with a staged modal clamps to waiting_approval', () => {
        const modal = { buttons: ['Yes', 'No'] }
        expect(normalizeReadChatCommandStatus('totally_new_state', modal)).toBe('waiting_approval')
    })

    it('contract statuses still pass through untouched', () => {
        for (const ok of ['idle', 'generating', 'streaming', 'no_progress']) {
            expect(normalizeReadChatCommandStatus(ok, undefined)).toBe(ok)
        }
    })
})
