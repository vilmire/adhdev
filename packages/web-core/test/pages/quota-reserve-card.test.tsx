// @vitest-environment jsdom
/**
 * Machine "Quota reserve" card (design 2026-11-01 §7): reads quota_reserve_get,
 * saves a scope's full policy through quota_reserve_set on blur, shows the
 * within-reserve state next to current quota, offers per-account overrides only
 * with >= 2 known accounts, and stays hidden on an older daemon.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QuotaReserveCard from '../../src/pages/machine/QuotaReserveCard'
import {
    buildReserveSetArgs,
    composeScopePolicy,
    parseQuotaReserveRead,
    parseQuotaReserveSet,
    providersWithMultipleAccounts,
    validateReserveDraft,
} from '../../src/pages/machine/quotaReserve'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ACCOUNT_A = 'a'.repeat(63) + '1'
const ACCOUNT_B = 'b'.repeat(63) + '2'
const policy = (over: Record<string, number> = {}) => ({
    routingSessionMinPercent: 10, routingLongMinPercent: 15, routingSessionResetImminentMs: 300000, assistantReviewMinPercent: 20, ...over,
})
const row = (provider: string, over: Record<string, unknown> = {}) => ({
    provider, pool: null, poolKey: provider, accountKey: null, policy: policy(), source: {},
    remaining: { session: 60, long: 70, tightest: 60 }, withinReserve: false, withinReserveWindow: null, belowAssistantReview: false, ...over,
})
function answer(over: Record<string, unknown> = {}) {
    return {
        success: true,
        raw: null,
        rows: [row('claude-cli'), row('codex-cli', { remaining: { session: 8, long: 70, tightest: 8 }, withinReserve: true, withinReserveWindow: 'session' })],
        accounts: {},
        stats: { blocks: [], edits: 0, migrationConflictsResolved: 0 },
        ...over,
    }
}

describe('quota reserve model', () => {
    it('parses ok / unsupported / error answers, including the cloud result wrapper', () => {
        expect(parseQuotaReserveRead({ success: true, result: answer() })).toMatchObject({ kind: 'ok' })
        expect(parseQuotaReserveRead({ success: false, error: 'Unknown command: quota_reserve_get' })).toEqual({ kind: 'unsupported' })
        expect(parseQuotaReserveRead(null)).toEqual({ kind: 'unsupported' })
        expect(parseQuotaReserveRead({ success: false, error: 'boom' })).toEqual({ kind: 'error', message: 'boom' })
        expect(parseQuotaReserveSet({ success: false, error: 'invalid_quota_reserve: x' })).toEqual({ ok: false, message: 'invalid_quota_reserve: x' })
    })

    it('validates drafts and composes the FULL scope policy so untouched fields survive a replace', () => {
        expect(validateReserveDraft('routingSessionMinPercent', '101')).toBe('percentRange')
        expect(validateReserveDraft('routingSessionResetImminentMs', '-1')).toBe('negative')
        expect(validateReserveDraft('routingLongMinPercent', 'x')).toBe('notANumber')
        expect(validateReserveDraft('routingLongMinPercent', '')).toBeNull()
        const stored = { routingSessionMinPercent: 30, routingSessionResetImminentMs: 120000 }
        expect(composeScopePolicy(stored, 'routingLongMinPercent', '40')).toEqual({ ...stored, routingLongMinPercent: 40 })
        expect(composeScopePolicy(stored, 'routingSessionMinPercent', '')).toEqual({ routingSessionResetImminentMs: 120000 })
        expect(composeScopePolicy(undefined, 'routingSessionResetImminentMs', '2')).toEqual({ routingSessionResetImminentMs: 120000 })
        expect(buildReserveSetArgs({ scope: 'pool', key: 'claude-cli' }, { routingLongMinPercent: 40 }))
            .toEqual({ scope: 'pool', key: 'claude-cli', policy: { routingLongMinPercent: 40 }, replace: true })
    })

    it('offers account overrides only for providers with at least two known accounts', () => {
        expect(providersWithMultipleAccounts({ 'claude-cli': [ACCOUNT_A], 'codex-cli': [ACCOUNT_A, ACCOUNT_B] })).toEqual(['codex-cli'])
    })
})

describe('QuotaReserveCard', () => {
    let container: HTMLDivElement
    let root: Root
    beforeEach(() => {
        container = document.createElement('div')
        document.body.appendChild(container)
        root = createRoot(container)
    })
    afterEach(() => { act(() => root.unmount()); container.remove() })

    type Send = (id: string, type: string, data?: Record<string, unknown>) => Promise<unknown>
    async function mount(send: Send) {
        await act(async () => { root.render(<QuotaReserveCard machineId="daemon-1" sendDaemonCommand={send} />) })
    }
    async function type(el: Element | null, value: string) {
        expect(el).toBeTruthy()
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
            el!.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => { (el as HTMLElement).dispatchEvent(new FocusEvent('focusout', { bubbles: true })); (el as HTMLInputElement).blur() })
    }
    const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`)

    it('renders nothing on a daemon without the verb', async () => {
        await mount(vi.fn(async () => ({ success: false, error: 'Unknown command' })))
        expect(container.innerHTML).toBe('')
    })

    it('shows the within-reserve state next to current quota without any blocking affordance', async () => {
        await mount(vi.fn(async () => answer()))
        const claude = byId('quota-reserve-row-claude-cli')!
        const codex = byId('quota-reserve-row-codex-cli')!
        expect(claude.querySelector('[data-testid="quota-reserve-within"]')).toBeNull()
        expect(codex.querySelector('[data-testid="quota-reserve-within"]')).toBeTruthy()
        expect(codex.querySelector('[data-testid="quota-reserve-bar"]')?.getAttribute('data-within')).toBe('true')
    })

    it('saves a machine default on blur through quota_reserve_set (replace) and re-renders from the answer', async () => {
        const send = vi.fn(async (_id: string, type: string, _data?: Record<string, unknown>) =>
            type === 'quota_reserve_get' ? answer() : answer({ raw: { version: 1, defaults: { routingSessionMinPercent: 25 } } }))
        await mount(send)
        await type(byId('quota-reserve-defaults-routingSessionMinPercent'), '25')
        expect(send).toHaveBeenCalledWith('daemon-1', 'quota_reserve_set',
            { scope: 'defaults', policy: { routingSessionMinPercent: 25 }, replace: true })
        expect((byId('quota-reserve-defaults-routingSessionMinPercent') as HTMLInputElement).value).toBe('25')
    })

    it('does not send an invalid value and shows a daemon refusal inline', async () => {
        const send = vi.fn(async (_id: string, type: string) =>
            type === 'quota_reserve_get' ? answer() : { success: false, error: 'invalid_quota_reserve: owner only' })
        await mount(send)
        await type(byId('quota-reserve-defaults-routingLongMinPercent'), '400')
        expect(send.mock.calls.some(c => c[1] === 'quota_reserve_set')).toBe(false)
        await type(byId('quota-reserve-defaults-routingLongMinPercent'), '40')
        expect(byId('quota-reserve-set-error')?.textContent).toContain('invalid_quota_reserve')
    })

    it('shows per-account overrides only with two known accounts', async () => {
        await mount(vi.fn(async () => answer({ accounts: { 'claude-cli': [ACCOUNT_A] } })))
        expect(byId('quota-reserve-accounts-claude-cli')).toBeNull()
        act(() => root.unmount())
        root = createRoot(container)
        await mount(vi.fn(async () => answer({ accounts: { 'claude-cli': [ACCOUNT_A, ACCOUNT_B] } })))
        expect(byId('quota-reserve-accounts-claude-cli')).toBeTruthy()
    })

    it('tells the owner when per-mesh thresholds were merged into the machine', async () => {
        await mount(vi.fn(async () => answer({ raw: { version: 1, migration: { at: 'x', resolution: 'max', fromMeshes: [{ meshId: 'a', fields: {} }, { meshId: 'b', fields: {} }] } } })))
        expect(byId('quota-reserve-migration')).toBeTruthy()
    })
})
