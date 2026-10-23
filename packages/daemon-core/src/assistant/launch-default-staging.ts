/** Launch-default proposals in the existing assistant Inbox, never defaults.
 * IDs bind the immutable proposal (including role, host scope and CAS generation).
 * Owner resolution reuses the registered command's authority and persistence ports.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
    renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { LaunchDefaultsProposal, LaunchDefaultsSetResponse } from '@adhdev/mesh-shared';
import { getConfigDir } from '../config/config.js';
import { hasOnlyKeys, isLaunchDefaultsDocument, isLaunchRole, isRecord, selectionSchemaIssue } from '../launch-defaults/index.js';
import { acquireOwnedLock, type OwnedLockOptions } from '../launch-defaults/owned-lock.js';

export interface StagedLaunchDefaultWrite extends LaunchDefaultsProposal {
    version: 1;
    id: string;
    createdAt: string;
    /** Random generation prevents distinct proposals with equal content sharing consent. */
    generation: string;
    /** Project CAS is independent; retain the global setup generation too. */
    documentRevision: number;
}
const ID = /^ldf-[a-f0-9]{32}-[a-f0-9]{64}$/;
const proposalKeys = ['kind', 'role', 'project', 'selection', 'previous', 'expectedRevision', 'origin', 'callerSessionId'];
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v === v.trim();
function validProposal(v: unknown): v is LaunchDefaultsProposal {
    if (!isRecord(v) || !hasOnlyKeys(v, proposalKeys) || v.kind !== 'launch_defaults' || !isLaunchRole(v.role)
        || !Number.isSafeInteger(v.expectedRevision) || (v.expectedRevision as number) < 0
        || !['owner', 'human', 'relay', 'review', 'review_tainted'].includes(v.origin as string)
        || Object.hasOwn(v, 'project') && (v.role !== 'coordinator' || !text(v.project))
        || Object.hasOwn(v, 'callerSessionId') && !text(v.callerSessionId)
        || v.selection !== null && !!selectionSchemaIssue(v.selection)) return false;
    return v.previous === null || isLaunchDefaultsDocument({ version: 1,
        revision: v.expectedRevision, [v.role]: v.previous, history: [] });
}
function digest(value: object): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function syncDir(dir: string): void {
    // Windows cannot open a directory for fsync (EPERM/EISDIR); see sessions/outgoing-receipt-store.ts.
    if (process.platform === 'win32') return;
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
}
const failure = (code: string, error: string, detail: Record<string, unknown> = {}) =>
    ({ success: false as const, code, error, ...detail });

export class AssistantLaunchDefaultStaging {
    readonly dir: string;
    private readonly configDir: string;
    private readonly now: () => Date;
    private readonly lockOptions: OwnedLockOptions;
    constructor(opts: { configDir?: string; now?: () => Date; lock?: OwnedLockOptions } = {}) {
        this.configDir = opts.configDir ?? getConfigDir();
        this.dir = join(this.configDir, 'assistant', 'staged');
        this.now = opts.now ?? (() => new Date());
        this.lockOptions = { probePeerIdentity: true, ...opts.lock };
    }
    private path(id: string): string { return join(this.dir, `${id}.json`); }

    /** Return an id only after the Inbox record and its directory are durable. */
    write(proposal: LaunchDefaultsProposal, binding?: { documentRevision: number }): string {
        if (!validProposal(proposal)) throw new Error('Invalid launch-default proposal.');
        const documentRevision = binding?.documentRevision ?? (proposal.project ? undefined : proposal.expectedRevision);
        if (!Number.isSafeInteger(documentRevision) || documentRevision! < 0
            || proposal.project && documentRevision === 0
            || !proposal.project && documentRevision !== proposal.expectedRevision) {
            throw new Error('Missing or inconsistent global document generation.');
        }
        const body = { version: 1 as const, createdAt: this.now().toISOString(),
            generation: randomBytes(16).toString('hex'), documentRevision: documentRevision!, ...proposal };
        const id = `ldf-${body.generation}-${digest(body)}`;
        const record = { ...body, id };
        const assistantDir = join(this.configDir, 'assistant');
        mkdirSync(assistantDir, { recursive: true, mode: 0o700 });
        syncDir(this.configDir);
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        syncDir(assistantDir);
        const tmp = `${this.path(id)}.tmp-${randomBytes(8).toString('hex')}`;
        try {
            const fd = openSync(tmp, 'wx', 0o600);
            try { writeFileSync(fd, JSON.stringify(record, null, 2)); fsyncSync(fd); }
            finally { closeSync(fd); }
            renameSync(tmp, this.path(id));
            syncDir(this.dir);
        } catch (error) {
            try { unlinkSync(tmp); } catch { /* absent after rename */ }
            throw error;
        }
        return id;
    }

    read(id: string): StagedLaunchDefaultWrite | null {
        if (!ID.test(id)) return null;
        try {
            const value: unknown = JSON.parse(readFileSync(this.path(id), 'utf8'));
            if (!isRecord(value) || !hasOnlyKeys(value, [...proposalKeys, 'version', 'createdAt', 'generation', 'documentRevision', 'id'])) return null;
            const { version, createdAt, generation, documentRevision, id: storedId, ...proposal } = value;
            if (version !== 1 || !text(createdAt) || !Number.isFinite(Date.parse(createdAt))
                || typeof generation !== 'string' || !/^[a-f0-9]{32}$/.test(generation)
                || storedId !== id || !validProposal(proposal) || !Number.isSafeInteger(documentRevision)
                || (documentRevision as number) < 0 || proposal.project && documentRevision === 0
                || !proposal.project && documentRevision !== proposal.expectedRevision) return null;
            // Preserve the serialized key order used by write(), excluding only id.
            const { id: _id, ...body } = value;
            if (id !== `ldf-${generation}-${digest(body)}`) return null;
            return value as unknown as StagedLaunchDefaultWrite;
        } catch { return null; } // Preserve corrupt/unreadable evidence for recovery.
    }

    list(): StagedLaunchDefaultWrite[] {
        if (!existsSync(this.dir)) return [];
        return readdirSync(this.dir).filter(n => n.startsWith('ldf-') && n.endsWith('.json'))
            .map(n => this.read(n.slice(0, -5))).filter((r): r is StagedLaunchDefaultWrite => r !== null)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    }

    /** Only call after the existing owner-source gate. No consent/modal token
     * can substitute for that gate or alter this immutable proposal's scope. */
    async resolve(id: string, decision: 'apply' | 'discard',
        apply: (proposal: LaunchDefaultsProposal, documentRevision: number) => Promise<LaunchDefaultsSetResponse>) {
        if (decision !== 'apply' && decision !== 'discard') return failure('invalid_args', 'Invalid proposal decision.');
        if (!ID.test(id)) return failure('staged_not_found', 'Launch-default proposal not found.');
        // Owner-recorded lock: a resolver killed mid-apply leaves a lock that the
        // next resolve reclaims once that pid is gone; a live resolver is never preempted.
        const lock = acquireOwnedLock(join(this.dir, `${id}.lock`), this.lockOptions);
        if (!lock.ok) {
            return lock.errno === 'ENOENT'
                ? failure('staged_not_found', 'Launch-default proposal not found.')
                : failure('staged_busy', 'Proposal resolution lock unavailable.', { reason: lock.reason });
        }
        try {
            const rec = this.read(id);
            if (!rec) return failure('staged_not_found', 'Launch-default proposal not found.');
            let applied: LaunchDefaultsSetResponse | undefined;
            if (decision === 'apply') {
                const { version: _v, id: _id, createdAt: _at, generation: _g, documentRevision, ...proposal } = rec;
                applied = await apply(proposal, documentRevision);
                // committed:true alone is never success. Keep failed proposals,
                // including uncertain writes: their original CAS refuses replay.
                if (!applied.success) return { ...applied };
                if (applied.result !== 'applied' || applied.durable !== true) {
                    return failure('persistence_failed', 'Durable default application was not confirmed.');
                }
            }
            try { unlinkSync(this.path(id)); syncDir(this.dir); }
            catch { return failure('staged_cleanup_failed', 'Inbox resolution durability unconfirmed.',
                { committed: decision === 'apply', defaultApplied: decision === 'apply' }); }
            return applied ? { ...applied } : { success: true as const, result: 'discarded' as const };
        } catch { return failure('persistence_failed', 'Proposal application outcome is unconfirmed.'); }
        finally { lock.release(); }
    }
}
