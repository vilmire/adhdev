/**
 * Contract versioning — the shared context every contract module operates on,
 * and the authenticated principal kinds.
 *
 * ★Principals are BRANDED: a principal is only accepted if it was issued by
 * this module (a WeakSet of issued objects). A plain object that merely looks
 * like `{ kind: 'owner' }` — a claimed role, a `source: 'ipc'` label, an
 * `ADHDEV_COORDINATOR_SESSION_ID`, a read-side synthesized host — is refused as
 * `unauthenticated` (design §4, AC01). The command layer may only issue an
 * owner principal after the router's trusted-owner-ingress proof verified, and a
 * worker principal only from a daemon-verified `wsb_`/`wtk_` credential.
 */

import type { Database as DatabaseHandle } from 'better-sqlite3';
import { ContractRefusal, type ContractBudgets, type ContractGrantOp, type ContractImpact, type ContractRuntime } from './contract-types.js';
import type { ContractSourceReader } from './contract-git-source.js';

/** Durable fencing evidence kept OUTSIDE the database, so restoring an old DB backup cannot reuse an earlier epoch. */
export interface ContractAuthorityFencePort {
    read(namespaceId: string): number | null;
    write(namespaceId: string, authorityEpoch: number): void;
}

export interface ContractCtx {
    db: DatabaseHandle;
    rt: ContractRuntime;
    budgets: ContractBudgets;
    /** This daemon's canonical id — the only daemon that may write a namespace it holds authority for. */
    localDaemonId: string;
    sourceReader: ContractSourceReader;
    fence: ContractAuthorityFencePort;
}

export interface OwnerPrincipal {
    readonly kind: 'owner';
    /** Authenticated channel principal (e.g. `owner:p2p` / `owner:standalone`) — never a caller-supplied string. */
    readonly principalId: string;
}

export interface CoordinatorPrincipal {
    readonly kind: 'coordinator';
    readonly principalId: string;
    readonly grantId: string;
    readonly namespaceId: string;
    readonly sessionId: string;
    readonly ops: readonly ContractGrantOp[];
    readonly maxImpact: ContractImpact;
}

export interface WorkerPrincipal {
    readonly kind: 'worker';
    readonly principalId: string;
    readonly meshId: string;
    readonly taskId: string;
    readonly attemptId: string;
    readonly generation: number;
    readonly sessionId: string;
}

export type ContractPrincipal = OwnerPrincipal | CoordinatorPrincipal | WorkerPrincipal;

const ISSUED = new WeakSet<object>();

/** Only for the command layer, AFTER `isTrustedOwnerIngress` verified the router-attached proof. */
export function issueOwnerPrincipal(channel: 'p2p' | 'standalone' | 'ws' | 'internal_test'): OwnerPrincipal {
    const p: OwnerPrincipal = Object.freeze({ kind: 'owner', principalId: `owner:${channel}` });
    ISSUED.add(p);
    return p;
}

/** Only after a daemon-verified worker credential resolved to this exact attempt/generation/session. */
export function issueWorkerPrincipal(identity: {
    meshId: string; taskId: string; attemptId: string; generation: number; sessionId: string;
}): WorkerPrincipal {
    const p: WorkerPrincipal = Object.freeze({
        kind: 'worker',
        principalId: `worker:${identity.sessionId}`,
        meshId: identity.meshId,
        taskId: identity.taskId,
        attemptId: identity.attemptId,
        generation: identity.generation,
        sessionId: identity.sessionId,
    });
    ISSUED.add(p);
    return p;
}

/** Internal: coordinator principals are minted only by capability verification. */
export function issueCoordinatorPrincipal(input: Omit<CoordinatorPrincipal, 'kind' | 'principalId'>): CoordinatorPrincipal {
    const p: CoordinatorPrincipal = Object.freeze({
        kind: 'coordinator',
        principalId: `coordinator:${input.sessionId}#${input.grantId}`,
        ...input,
        ops: Object.freeze([...input.ops]),
    });
    ISSUED.add(p);
    return p;
}

export function assertIssued(p: unknown): asserts p is ContractPrincipal {
    if (!p || typeof p !== 'object' || !ISSUED.has(p)) throw new ContractRefusal('unauthenticated');
}

export function assertOwner(p: unknown): asserts p is OwnerPrincipal {
    assertIssued(p);
    if (p.kind !== 'owner') throw new ContractRefusal('not_owner');
}

export function newId(ctx: ContractCtx, prefix: string): string {
    return `${prefix}_${ctx.rt.randomBytes(12).toString('hex')}`;
}

/** better-sqlite3 transaction helper — nests as a savepoint inside an outer transaction. */
export function inTxn<T>(ctx: ContractCtx, fn: () => T): T {
    return ctx.db.transaction(fn)();
}
