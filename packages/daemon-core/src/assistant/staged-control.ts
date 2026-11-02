/**
 * Staged control proposals (`ctl-*`) — the owner-approval card for session
 * control and host handoff (design docs/design/2026-11-01-assistant-session-handoff.md
 * §4.2, §6.3, §7.6).
 *
 * A proposal is an immutable record in `<configDir>/assistant/staged-control/`.
 * It lives ONE HOUR (quota information goes stale): an expired record is
 * reported as `staged_expired` and removed on the next list/resolve. Resolution
 * is owner-only (`assistant_staged_resolve`); the apply callback runs at most
 * once per id (the record is removed before the effect is reported, and a
 * failed apply keeps it so the owner can retry within the TTL).
 *
 * The record carries ids, enums and the owner's own words / the assistant's
 * short reason — local file only, never the status path.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withProjectApprovalWrite } from '../mesh/host-handoff/project-write-cut.js';
import { getConfigDir } from '../config/config.js';

export const STAGED_CONTROL_TTL_MS = 60 * 60_000;
const ID_RE = /^ctl-[a-f0-9]{24}$/;

export type StagedControlKind = 'session_control' | 'host_handoff';
export type StagedControlTrigger = 'owner_request' | 'busy_target' | 'switch_provider' | 'quota_exhausted';

export interface StagedControlProposal {
    kind: StagedControlKind;
    project: string;
    meshId: string;
    trigger: StagedControlTrigger;
    /** session_control */
    role?: 'coordinator' | 'worker' | 'assistant';
    action?: 'stop' | 'restart' | 'switch_provider';
    sessionId?: string;
    provider?: string;
    model?: string;
    thinkingLevel?: string;
    /** host_handoff */
    targetDaemonId?: string;
    targetNodeId?: string;
    reason?: string;
    interpretedFrom?: string;
    /** Card text for a quota-driven proposal: ids, enums, numbers only. */
    quota?: { fromProvider: string; fromRemainingPct?: number; toProvider: string; toRemainingPct?: number; resetsAt?: number };
}

export interface StagedControlRecord extends StagedControlProposal {
    version: 1;
    id: string;
    createdAt: number;
    expiresAt: number;
}

export type StagedControlResolveResult =
    | { success: true; result: 'discarded' }
    | { success: true; result: 'applied'; applied: Record<string, unknown> }
    | { success: false; code: 'staged_not_found' | 'staged_expired' | 'staged_apply_failed' | 'invalid_args'; error: string; applied?: Record<string, unknown> };

function syncDir(dir: string): void {
    if (process.platform === 'win32') return;
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

export class StagedControlStore {
    readonly dir: string;
    private readonly configDir: string;
    private readonly now: () => number;

    constructor(opts: { configDir?: string; now?: () => number } = {}) {
        this.configDir = opts.configDir ?? getConfigDir();
        this.dir = join(this.configDir, 'assistant', 'staged-control');
        this.now = opts.now ?? Date.now;
    }

    private projectReference(record: StagedControlProposal): string | undefined {
        return record.kind === 'session_control' && record.role === 'assistant' ? undefined : record.meshId;
    }

    private path(id: string): string { return join(this.dir, `${id}.json`); }

    write(proposal: StagedControlProposal): StagedControlRecord {
        return withProjectApprovalWrite(this.configDir, this.projectReference(proposal), () => this.writeUnlocked(proposal));
    }
    private writeUnlocked(proposal: StagedControlProposal): StagedControlRecord {
        const at = this.now();
        const id = `ctl-${randomBytes(12).toString('hex')}`;
        const record: StagedControlRecord = { version: 1, id, createdAt: at, expiresAt: at + STAGED_CONTROL_TTL_MS, ...proposal };
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        const tmp = `${this.path(id)}.tmp-${randomBytes(6).toString('hex')}`;
        const fd = openSync(tmp, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify(record, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
        renameSync(tmp, this.path(id));
        syncDir(this.dir);
        return record;
    }

    /** `null` when absent or unreadable; an expired record is returned with `expired: true`. */
    read(id: string): { record: StagedControlRecord; expired: boolean } | null {
        if (!ID_RE.test(id)) return null;
        try {
            const value = JSON.parse(readFileSync(this.path(id), 'utf8')) as StagedControlRecord;
            if (!value || value.version !== 1 || value.id !== id || (value.kind !== 'session_control' && value.kind !== 'host_handoff')) return null;
            return { record: value, expired: this.now() >= value.expiresAt };
        } catch { return null; }
    }

    /** Live (unexpired) proposals, oldest first; expired ones are removed. */
    list(): StagedControlRecord[] {
        if (!existsSync(this.dir)) return [];
        const out: StagedControlRecord[] = [];
        for (const name of readdirSync(this.dir)) {
            if (!name.startsWith('ctl-') || !name.endsWith('.json')) continue;
            const id = name.slice(0, -5);
            const read = this.read(id);
            if (!read) continue;
            if (read.expired) { try { this.remove(id); } catch { /* retain frozen originals */ } continue; }
            out.push(read.record);
        }
        return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }

    remove(id: string): void {
        const value = this.read(id);
        if (!value) return;
        withProjectApprovalWrite(this.configDir, this.projectReference(value.record), () => this.removeUnlocked(id));
    }
    private removeUnlocked(id: string): void {
        try { unlinkSync(this.path(id)); } catch { /* already gone */ }
    }

    /** Open (unexpired) proposals for one session — used to avoid stacking identical cards. */
    findOpen(match: (r: StagedControlRecord) => boolean): StagedControlRecord | undefined {
        return this.list().find(match);
    }

    async resolve(id: string, decision: 'apply' | 'discard',
        apply: (record: StagedControlRecord) => Promise<{ success: boolean } & Record<string, unknown>>): Promise<StagedControlResolveResult> {
        const value = this.read(id);
        if (!value) return { success: false, code: 'staged_not_found', error: 'Control proposal not found.' };
        // Handoff itself acquires the project cut. Consume this consent durably
        // under that cut, then release it before invoking the state machine.
        // A retained receipt prevents a crashed caller from replaying consent.
        if (value.record.kind === 'host_handoff' && decision === 'apply') {
            let accepted: StagedControlRecord | undefined;
            try {
                const early = withProjectApprovalWrite(this.configDir, value.record.meshId, () => {
                    const current = this.read(id);
                    if (!current) return { success: false as const, code: 'staged_not_found' as const, error: 'Control proposal not found.' };
                    if (current.expired) return { success: false as const, code: 'staged_expired' as const, error: 'Control proposal expired (1 hour); ask again.' };
                    renameSync(this.path(id), `${this.path(id)}.consumed`);
                    syncDir(this.dir);
                    accepted = current.record;
                    return undefined;
                });
                if (early) return early;
                const applied = await apply(accepted!);
                if (applied.success === true) return { success: true, result: 'applied', applied };
                return { success: false, code: 'staged_apply_failed', error: String(applied.error ?? applied.code ?? 'apply failed'), applied };
            } catch (e) { return { success: false, code: 'staged_apply_failed', error: (e as Error).message }; }
        }
        try { return await withProjectApprovalWrite(this.configDir, this.projectReference(value.record), () => this.resolveUnlocked(id, decision, apply)); }
        catch (e) { return { success: false, code: 'staged_apply_failed', error: (e as Error).message }; }
    }

    private async resolveUnlocked(
        id: string,
        decision: 'apply' | 'discard',
        apply: (record: StagedControlRecord) => Promise<{ success: boolean } & Record<string, unknown>>,
    ): Promise<StagedControlResolveResult> {
        if (decision !== 'apply' && decision !== 'discard') return { success: false, code: 'invalid_args', error: 'decision must be apply or discard' };
        const read = this.read(id);
        if (!read) return { success: false, code: 'staged_not_found', error: 'Control proposal not found.' };
        if (read.expired) {
            this.removeUnlocked(id);
            return { success: false, code: 'staged_expired', error: 'Control proposal expired (1 hour); ask again.' };
        }
        if (decision === 'discard') {
            this.removeUnlocked(id);
            return { success: true, result: 'discarded' };
        }
        // Remove first: a crash between apply and cleanup must not re-apply on retry.
        this.removeUnlocked(id);
        let applied: { success: boolean } & Record<string, unknown>;
        try { applied = await apply(read.record); }
        catch (e) { applied = { success: false, error: (e as Error)?.message ?? String(e) }; }
        if (applied.success !== true) {
            // The effect did not run; keep the card so the owner can retry within the TTL.
            this.restore(read.record);
            return { success: false, code: 'staged_apply_failed', error: String(applied.error ?? applied.code ?? 'apply failed'), applied };
        }
        return { success: true, result: 'applied', applied };
    }

    private restore(record: StagedControlRecord): void {
        try {
            mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            writeFileSync(this.path(record.id), JSON.stringify(record, null, 2), { mode: 0o600 });
        } catch { /* best-effort */ }
    }
}

let shared: StagedControlStore | null = null;
export function getStagedControlStore(): StagedControlStore {
    return shared ?? (shared = new StagedControlStore());
}
/** Test seam. */
export function setStagedControlStoreForTest(store: StagedControlStore | null): void {
    shared = store;
}
