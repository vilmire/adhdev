/** Owner-resolved destructive requests. Consumed before execution, including on failure. */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../config/config.js';
import { writeFileAtomic600 } from '../assistant/store-guards.js';

export interface DriverWorkerIdentity {
    meshId: string; taskId: string; sessionId: string; attemptId?: string; nodeId?: string;
}
export type DriverOwnerSource = 'p2p' | 'ws' | 'standalone';
export interface StagedDriverAction {
    kind: 'driver_action_request'; id: string; type: string; action: string;
    args: Record<string, unknown>; activationDigest: string; resourceKey?: string;
    requester: DriverWorkerIdentity; requesterTaskId: string;
    createdAt: number; expiresAt: number;
    status: 'pending' | 'consumed' | 'discarded' | 'expired' | 'stale';
}
const ID = /^driver-action-[a-f0-9-]+$/;
export const DRIVER_ACTION_TTL_MS = 30 * 60_000;
export class DriverActionStaging {
    readonly dir: string;
    constructor(configDir = getConfigDir(), private readonly now = Date.now) {
        this.dir = join(configDir, 'assistant', 'staged');
    }
    private save(record: StagedDriverAction): void {
        writeFileAtomic600(join(this.dir, `${record.id}.json`), JSON.stringify(record, null, 2) + '\n');
    }
    write(input: Pick<StagedDriverAction, 'type' | 'action' | 'args' | 'activationDigest' | 'requester' | 'resourceKey'>): StagedDriverAction {
        const record: StagedDriverAction = { ...structuredClone(input), kind: 'driver_action_request',
            id: `driver-action-${randomUUID()}`, requesterTaskId: input.requester.taskId,
            createdAt: this.now(), expiresAt: this.now() + DRIVER_ACTION_TTL_MS, status: 'pending' };
        this.save(record);
        return record;
    }
    read(id: string): StagedDriverAction | null {
        if (!ID.test(id)) return null;
        try {
            const r = JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as StagedDriverAction;
            return r.kind === 'driver_action_request' && r.id === id && typeof r.type === 'string'
                && typeof r.action === 'string' && r.args && typeof r.args === 'object' && !Array.isArray(r.args)
                && /^sha256:[a-f0-9]{64}$/.test(r.activationDigest) && !!r.requester?.sessionId
                && !!r.requester.meshId && r.requester.taskId === r.requesterTaskId
                && Number.isFinite(r.expiresAt) && r.expiresAt === r.createdAt + DRIVER_ACTION_TTL_MS ? r : null;
        } catch { return null; }
    }
    list(): StagedDriverAction[] {
        if (!existsSync(this.dir)) return [];
        return readdirSync(this.dir).filter(f => f.endsWith('.json')).flatMap(f => {
            const r = this.read(f.slice(0, -5));
            if (!r || r.status !== 'pending') return [];
            if (r.expiresAt <= this.now()) { this.finish(r, 'expired'); return []; }
            return [r];
        });
    }
    finish(record: StagedDriverAction, status: StagedDriverAction['status']): void {
        this.save({ ...record, status });
    }
    /** No await between pending check and durable consume: concurrent resolves cannot replay. */
    claim(id: string, digest: string | undefined, decision: 'apply' | 'discard'):
        { record: StagedDriverAction } | { code: string } {
        const r = this.read(id);
        if (!r) return { code: 'staged_not_found' };
        if (r.status !== 'pending') return { code: r.status === 'expired' || r.status === 'stale' ? r.status : 'already_resolved' };
        if (decision === 'discard') { this.finish(r, 'discarded'); return { code: 'discarded' }; }
        if (this.now() >= r.expiresAt) { this.finish(r, 'expired'); return { code: 'expired' }; }
        if (r.activationDigest !== digest) { this.finish(r, 'stale'); return { code: 'stale' }; }
        this.finish(r, 'consumed');
        return { record: r };
    }
}
