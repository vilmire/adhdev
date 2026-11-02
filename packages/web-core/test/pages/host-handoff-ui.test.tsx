// @vitest-environment jsdom
/**
 * Host handoff dialog + control cards (design 2026-11-01 §8): the dialog speaks
 * only the `mesh_host_handoff` owner verb, shows the five steps, never offers an
 * abort once activation started, and says so plainly when the daemon has the
 * feature off. Cards for session control / host handoff parse from the staged list.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeshHostHandoffDialog } from '../../src/pages/repo-mesh/MeshHostHandoffDialog'
import {
    canAbortHandoff, canRetryHandoff, parseHandoffStatus, parsePreflight, parseStartResult, phaseToStep,
} from '../../src/pages/repo-mesh/host-handoff'
import { parseStagedList } from '../../src/components/dashboard/assistant-staged'
import { parseFailoverModes } from '../../src/components/dashboard/AssistantControlSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('host-handoff parsing', () => {
    it('maps every journal phase to a step and gates abort / retry', () => {
        expect(['preflight', 'freezing', 'frozen', 'exporting', 'exported', 'awaiting_ack', 'acked', 'activating', 'uncertain', 'committed'].map(phaseToStep))
            .toEqual([-1, 0, 0, 1, 1, 2, 3, 4, 4, 5])
        for (const p of ['freezing', 'exporting', 'awaiting_ack', 'acked']) expect(canAbortHandoff(p)).toBe(true)
        for (const p of ['activating', 'uncertain', 'committed', 'aborted']) expect(canAbortHandoff(p)).toBe(false)
        expect(canRetryHandoff('uncertain')).toBe(true)
        expect(canRetryHandoff('acked')).toBe(true)
        expect(canRetryHandoff('exporting')).toBe(false)
    })
    it('reads answers defensively (cloud wrapper, older daemon, refusals)', () => {
        expect(parseHandoffStatus({ success: true, result: { success: true, enabled: true, source: { handoffId: 'h', phase: 'frozen' } } })).toEqual({ enabled: true, source: { handoffId: 'h', phase: 'frozen' } })
        expect(parseHandoffStatus({ success: false, code: 'unknown_command' })).toEqual({ enabled: false, source: null })
        expect(parseHandoffStatus(null)).toEqual({ enabled: false, source: null })
        expect(parsePreflight({ success: false, ok: false, checks: [{ id: 'target_online', ok: false, code: 'target_offline' }, { id: 'is_host', ok: true }] }))
            .toMatchObject({ ok: false, checks: [{ id: 'target_online', ok: false, code: 'target_offline' }, { id: 'is_host', ok: true }] })
        expect(parseStartResult({ success: true, handoffId: 'h1', phase: 'freezing' })).toEqual({ ok: true, handoffId: 'h1', phase: 'freezing' })
        expect(parseStartResult({ success: false, code: 'handoff_in_progress' })).toEqual({ ok: false, code: 'handoff_in_progress' })
    })
})

describe('control cards in the staged list', () => {
    it('parses session-control and host-handoff cards and drops malformed ones', () => {
        const items = parseStagedList({
            success: true, control: [
                { id: 'ctl-0123456789abcdef01234567', version: 1, kind: 'session_control', project: 'blog', meshId: 'm', trigger: 'quota_exhausted', role: 'coordinator', action: 'switch_provider', sessionId: 's', provider: 'codex-cli', createdAt: 1_800_000_000_000, expiresAt: 1_800_003_600_000, quota: { fromProvider: 'claude-cli', fromRemainingPct: 0, toProvider: 'codex-cli', toRemainingPct: 80 } },
                { id: 'ctl-aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'host_handoff', project: 'blog', meshId: 'm', trigger: 'owner_request', targetDaemonId: 'daemon_x', createdAt: 1_800_000_001_000 },
                { id: 'not-a-card', kind: 'session_control', project: 'blog', trigger: 'owner_request', action: 'stop' },
                { id: 'ctl-bbbbbbbbbbbbbbbbbbbbbbbb', kind: 'session_control', project: 'blog', trigger: 'weird', action: 'stop' },
            ],
        })!
        expect(items.map(i => [i.id, i.kind, i.action])).toEqual([
            ['ctl-0123456789abcdef01234567', 'session_control', 'switch_provider'],
            ['ctl-aaaaaaaaaaaaaaaaaaaaaaaa', 'host_handoff', 'start'],
        ])
        expect(items[0]!.control).toMatchObject({ trigger: 'quota_exhausted', role: 'coordinator', provider: 'codex-cli', quota: { toProvider: 'codex-cli', toRemainingPct: 80 } })
        expect(items[0]!.origin).toBe('quota')
    })
    it('failover modes default to notify and ignore junk', () => {
        expect(parseFailoverModes({ success: true, assistant: 'auto', coordinator: 'bogus' })).toEqual({ assistant: 'auto', coordinator: 'notify' })
        expect(parseFailoverModes({ success: false })).toBeNull()
    })
})

describe('MeshHostHandoffDialog', () => {
    let host: HTMLDivElement
    let root: Root
    beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
    afterEach(() => { act(() => root.unmount()); host.remove() })
    const daemons = [{ id: 'daemon_host', hostname: 'host-box' }, { id: 'daemon_b', hostname: 'laptop' }] as never
    const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
    const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null

    it('says the feature is off when the daemon reports it disabled, and offers no start', async () => {
        const send = vi.fn(async () => ({ success: true, enabled: false }))
        act(() => root.render(<MeshHostHandoffDialog open onClose={() => {}} meshId="m" hostDaemonId="daemon_host" daemons={daemons} sendCommand={send} />))
        await flush()
        expect(q('[data-handoff-disabled]')).not.toBeNull()
        expect(q('[data-handoff-action="start"]')).toBeNull()
        expect(send).toHaveBeenCalledWith('daemon_host', 'mesh_host_handoff', { op: 'status', meshId: 'm' })
    })

    it('runs preflight then start; start stays disabled until every check passes; the target list excludes the host', async () => {
        const calls: Array<Record<string, unknown>> = []
        const send = vi.fn(async (_d: string, _c: string, payload: Record<string, unknown>) => {
            calls.push(payload)
            if (payload.op === 'status') return { success: true, enabled: true, source: calls.some(c => c.op === 'start') ? { handoffId: 'h1', phase: 'awaiting_ack' } : null }
            if (payload.op === 'preflight') return { success: true, ok: true, checks: [{ id: 'is_host', ok: true }, { id: 'target_online', ok: true }] }
            if (payload.op === 'start') return { success: true, handoffId: 'h1', phase: 'freezing' }
            return { success: true }
        })
        act(() => root.render(<MeshHostHandoffDialog open onClose={() => {}} meshId="m" hostDaemonId="daemon_host" daemons={daemons} sendCommand={send as never} />))
        await flush()
        const select = q('[data-handoff-target]') as HTMLSelectElement
        expect([...select.options].map(o => o.value)).toEqual(['', 'daemon_b'])
        expect((q('[data-handoff-action="start"]') as HTMLButtonElement).disabled).toBe(true)
        await act(async () => { select.value = 'daemon_b'; select.dispatchEvent(new Event('change', { bubbles: true })) })
        await act(async () => { (q('[data-handoff-action="preflight"]') as HTMLButtonElement).click() })
        await flush()
        expect(document.body.querySelectorAll('[data-handoff-check]').length).toBe(2)
        expect((q('[data-handoff-action="start"]') as HTMLButtonElement).disabled).toBe(false)
        await act(async () => { (q('[data-handoff-action="start"]') as HTMLButtonElement).click() })
        await flush()
        expect(calls.find(c => c.op === 'start')).toEqual({ op: 'start', meshId: 'm', targetDaemonId: 'daemon_b' })
        expect(q('[data-handoff-phase="awaiting_ack"]')).not.toBeNull()
        expect(q('[data-handoff-step="verify"]')?.getAttribute('data-state')).toBe('active')
        expect(q('[data-handoff-step="freeze"]')?.getAttribute('data-state')).toBe('done')
        expect((q('[data-handoff-action="abort"]') as HTMLButtonElement).disabled).toBe(false)
    })

    it('binds a selected workspace and displays actual observed host/session plus source stop proof', async () => {
        const calls: Array<Record<string, unknown>> = []
        const send = vi.fn(async (_d: string, _c: string, payload: Record<string, unknown>) => {
            calls.push(payload)
            if (payload.op === 'status') return { success: true, enabled: true, source: null }
            if (payload.op === 'preflight') return { success: false, ok: false, checks: [{ id: 'target_launchable', ok: false }] }
            return { success: false }
        })
        act(() => root.render(<MeshHostHandoffDialog open onClose={() => {}} meshId="m" hostDaemonId="daemon_host" daemons={daemons}
            projectNodes={[{ id: 'chosen-node', daemonId: 'daemon_b', workspace: '/fixture/chosen' }, { id: 'other-node', daemonId: 'daemon_b', workspace: '/fixture/other' }]} sendCommand={send as never} />))
        await flush()
        await act(async () => { const select = q('[data-handoff-target]') as HTMLSelectElement; select.value = 'daemon_b'; select.dispatchEvent(new Event('change', { bubbles: true })) })
        expect((q('[data-handoff-action="preflight"]') as HTMLButtonElement).disabled).toBe(true)
        await act(async () => { const select = q('[data-handoff-target-node]') as HTMLSelectElement; select.value = 'chosen-node'; select.dispatchEvent(new Event('change', { bubbles: true })) })
        await act(async () => { (q('[data-handoff-action="preflight"]') as HTMLButtonElement).click() })
        await flush()
        expect(calls.find(p => p.op === 'preflight')).toMatchObject({ meshId: 'm', targetDaemonId: 'daemon_b', targetNodeId: 'chosen-node' })
        const status = { success: true, enabled: true, source: { handoffId: 'h', phase: 'committed' }, evidence: { sourceStopped: true, sourceDaemonId: 'daemon_host', sourceStopProof: { sessionIds: ['old-session'] }, target: { actualHostDaemonId: 'daemon_b', observation: { sessionId: 'actual-session', runtimeVerified: true, ready: true } } } }
        expect(parseHandoffStatus(status).evidence).toMatchObject({ sourceStopped: true, sourceSessionIds: ['old-session'], targetHost: 'daemon_b', targetSession: 'actual-session', targetVerified: true })
        act(() => root.render(<MeshHostHandoffDialog open onClose={() => {}} meshId="m2" hostDaemonId="daemon_host" daemons={daemons} sendCommand={async () => status} />))
        await flush()
        expect(q('[data-handoff-actual-host]')?.textContent).toBe('daemon_b')
        expect(q('[data-handoff-actual-session]')?.textContent).toBe('actual-session')
        expect(q('[data-handoff-source-stop]')?.textContent).toBe('old-session')
    })

    it('an uncertain switch disables abort and explains why; retry stays available', async () => {
        const send = vi.fn(async (_d: string, _c: string, p: Record<string, unknown>) => (p.op === 'status' ? { success: true, enabled: true, source: { handoffId: 'h2', phase: 'uncertain' } } : { success: true }))
        act(() => root.render(<MeshHostHandoffDialog open onClose={() => {}} meshId="m" hostDaemonId="daemon_host" daemons={daemons} sendCommand={send as never} />))
        await flush()
        expect(q('[data-handoff-uncertain]')).not.toBeNull()
        expect((q('[data-handoff-action="abort"]') as HTMLButtonElement).disabled).toBe(true)
        expect((q('[data-handoff-action="retry"]') as HTMLButtonElement).disabled).toBe(false)
    })
})
