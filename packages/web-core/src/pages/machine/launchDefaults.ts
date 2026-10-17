/**
 * Machine launch defaults — read/shape helpers for `launch_defaults_get` /
 * `launch_defaults_set` (daemon-core commands/high-family/launch-defaults.ts,
 * wire contract @adhdev/mesh-shared launch-defaults.ts).
 *
 * The daemon answers each role on its own: `stored` is the saved entry (shown
 * even when it no longer works), `effective` is what the next launch would use
 * or a loud failure. Everything is parsed defensively: the answer crosses a
 * process boundary from a daemon whose version we do not control.
 */
import type { LaunchDefaultRole } from '@adhdev/mesh-shared'

export const LAUNCH_DEFAULT_ROLE_ORDER: readonly LaunchDefaultRole[] = ['assistant', 'coordinator']

export interface LaunchDefaultSelectionView {
    provider: string
    model?: string
    thinkingLevel?: string
}
export interface LaunchDefaultRoleState {
    stored: LaunchDefaultSelectionView | null
    effective: { ok: true; selection: LaunchDefaultSelectionView } | { ok: false; code: string; reason: string }
}
export interface LaunchDefaultsState {
    documentRevision: number
    roles: Partial<Record<LaunchDefaultRole, LaunchDefaultRoleState>>
}
export type LaunchDefaultsRead =
    | { kind: 'ok'; state: LaunchDefaultsState }
    /** The daemon refused (e.g. corrupt document): show its code. */
    | { kind: 'error'; code: string }
    /** Not an answer to this verb at all (older daemon / unknown command): hide the surface. */
    | { kind: 'unsupported' }

function rec(v: unknown): Record<string, any> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null
}
function str(v: unknown): string {
    return typeof v === 'string' ? v : ''
}

/** Cloud wraps the daemon answer once (`{success, result:{…}}`); standalone does not.
 * The read answer itself carries `result: 'get'` (a string), so only an object unwraps. */
export function unwrapLaunchDefaultsAnswer(raw: unknown): Record<string, any> | null {
    const r = rec(raw)
    if (!r) return null
    const inner = rec(r.result)
    return inner && ('success' in inner || 'roles' in inner) ? inner : r
}

function selection(v: unknown): LaunchDefaultSelectionView | null {
    const r = rec(v)
    if (!r || !str(r.provider)) return null
    return { provider: str(r.provider),
        ...(str(r.model) ? { model: str(r.model) } : {}),
        ...(str(r.thinkingLevel) ? { thinkingLevel: str(r.thinkingLevel) } : {}) }
}

const LAUNCH_DEFAULT_CODES = new Set(['invalid_args', 'launch_default_required', 'launch_default_unavailable',
    'launch_selection_invalid', 'launch_default_invalid', 'revision_conflict', 'store_unavailable', 'store_busy',
    'persistence_failed', 'project_not_found', 'project_ambiguous', 'project_not_hosted',
    'project_storage_unavailable'])

export function parseLaunchDefaultsRead(raw: unknown): LaunchDefaultsRead {
    const r = unwrapLaunchDefaultsAnswer(raw)
    if (!r) return { kind: 'unsupported' }
    if (r.success === false) {
        const code = str(r.code)
        return LAUNCH_DEFAULT_CODES.has(code) ? { kind: 'error', code } : { kind: 'unsupported' }
    }
    const roles = rec(r.roles)
    if (r.result !== 'get' || !roles || !Number.isSafeInteger(r.documentRevision)) return { kind: 'unsupported' }
    const state: LaunchDefaultsState = { documentRevision: r.documentRevision, roles: {} }
    for (const role of LAUNCH_DEFAULT_ROLE_ORDER) {
        const view = rec(roles[role])
        if (!view) continue
        const effective = rec(view.effective)
        const ok = effective?.ok === true ? selection(effective.selection) : null
        state.roles[role] = {
            stored: selection(view.stored),
            effective: ok ? { ok: true, selection: ok }
                : { ok: false, code: str(effective?.code) || 'launch_default_unavailable', reason: str(effective?.reason) },
        }
    }
    return { kind: 'ok', state }
}

/** `provider · model · thinking`, omitting axes left to the provider default. */
export function formatLaunchSelection(sel: LaunchDefaultSelectionView): string {
    return [sel.provider, sel.model, sel.thinkingLevel].filter(Boolean).join(' · ')
}

/** Set (whole triple, CAS on the read's document revision) or clear the role. */
export function buildLaunchDefaultsSetArgs(role: LaunchDefaultRole, expectedRevision: number,
    draft: LaunchDefaultSelectionView | null): Record<string, unknown> {
    if (!draft) return { action: 'clear', role, expectedRevision }
    const model = draft.model?.trim()
    const thinkingLevel = draft.thinkingLevel?.trim()
    return { action: 'set', role, expectedRevision, provider: draft.provider,
        ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) }
}

/** The set answer → applied, or the refusal code (plus reason when the daemon gives one). */
export function parseLaunchDefaultsSetResult(raw: unknown): { ok: true } | { ok: false; code: string } {
    const r = unwrapLaunchDefaultsAnswer(raw)
    if (r && r.success !== false && r.result === 'applied') return { ok: true }
    const code = str(r?.code) || str(r?.error) || 'failed'
    const reason = str(r?.reason)
    return { ok: false, code: reason && reason !== code ? `${code}: ${reason}` : code }
}
