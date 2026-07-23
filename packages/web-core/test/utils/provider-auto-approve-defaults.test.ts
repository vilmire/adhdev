import { describe, expect, it } from 'vitest'
import type { AutoApproveModesConfig } from '@adhdev/daemon-core'
import { resolveEffectiveAutoApprove } from '../../src/utils/provider-auto-approve-defaults'

const config: AutoApproveModesConfig = {
    default: 'parsed',
    modes: [
        { id: 'parsed', label: 'Parsed', strategy: 'pty-parse-default', risk: 'safe' },
        { id: 'accept-edits', label: 'Accept edits', strategy: 'launch-args', risk: 'safe', launchArgs: ['--accept-edits'] },
        {
            id: 'yolo',
            label: 'YOLO',
            strategy: 'launch-args',
            risk: 'safe', // registry claims safe, but the launchArg is known-dangerous
            launchArgs: ['--dangerously-bypass-approvals-and-sandbox'],
        },
    ],
}

describe('resolveEffectiveAutoApprove (browser display mirror of the daemon resolver)', () => {
    it('ENABLE gate off → disabled regardless of a repo-requested mode', () => {
        const r = resolveEffectiveAutoApprove({
            config,
            requestedModeId: 'accept-edits',
            machineAutoApproveEnabled: false,
            machineDangerousAllowed: true,
        })
        expect(r.status).toBe('disabled')
        expect(r.effectiveMode).toBeUndefined()
        // The repo request is still surfaced (so the UI can explain what was requested).
        expect(r.requestedModeId).toBe('accept-edits')
    })

    it('adopts a valid repo-requested mode when enabled', () => {
        const r = resolveEffectiveAutoApprove({
            config,
            requestedModeId: 'accept-edits',
            machineAutoApproveEnabled: true,
            machineDangerousAllowed: false,
        })
        expect(r.status).toBe('requested')
        expect(r.effectiveMode?.id).toBe('accept-edits')
        expect(r.downgraded).toBe(false)
    })

    it('falls back to the provider default when no repo mode is requested', () => {
        const r = resolveEffectiveAutoApprove({
            config,
            machineAutoApproveEnabled: true,
            machineDangerousAllowed: false,
        })
        expect(r.status).toBe('requested')
        expect(r.effectiveMode?.id).toBe('parsed')
    })

    it('surfaces an unknown/stale requested id as invalid_fallback → provider default', () => {
        const r = resolveEffectiveAutoApprove({
            config,
            requestedModeId: 'does-not-exist',
            machineAutoApproveEnabled: true,
            machineDangerousAllowed: false,
        })
        expect(r.status).toBe('invalid_fallback')
        expect(r.requestedModeUnknown).toBe(true)
        expect(r.effectiveMode?.id).toBe('parsed')
    })

    it('DOWNGRADE: a repo-requested dangerous mode without machine opt-in downgrades to pty-parse and reports it', () => {
        const r = resolveEffectiveAutoApprove({
            config,
            requestedModeId: 'yolo',
            machineAutoApproveEnabled: true,
            machineDangerousAllowed: false,
        })
        expect(r.status).toBe('downgraded')
        expect(r.downgraded).toBe(true)
        expect(r.requestedModeId).toBe('yolo')
        expect(r.effectiveMode?.id).toBe('parsed') // downgraded target, NOT hidden as 'yolo selected'
    })

    it('honors a repo-requested dangerous mode when the machine opted in', () => {
        const r = resolveEffectiveAutoApprove({
            config,
            requestedModeId: 'yolo',
            machineAutoApproveEnabled: true,
            machineDangerousAllowed: true,
        })
        expect(r.status).toBe('requested')
        expect(r.downgraded).toBe(false)
        expect(r.effectiveMode?.id).toBe('yolo')
    })

    it('reports none when the only usable mode is dangerous and there is no pty fallback', () => {
        const dangerousOnly: AutoApproveModesConfig = {
            default: 'yolo',
            modes: [config.modes[2]],
        }
        const r = resolveEffectiveAutoApprove({
            config: dangerousOnly,
            machineAutoApproveEnabled: true,
            machineDangerousAllowed: false,
        })
        expect(r.status).toBe('none')
        expect(r.effectiveMode).toBeUndefined()
    })
})
