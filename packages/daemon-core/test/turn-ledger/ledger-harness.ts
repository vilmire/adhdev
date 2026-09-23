// Shared fixtures for the turn-ledger store/ledger/property tests (C-W2).
import type { Database as DatabaseHandle } from 'better-sqlite3';
import type { MeshTopicEntry, SummaryRef, TurnEvidence, TurnEvidenceBody, TurnEvidenceKind } from '@adhdev/mesh-shared';
import { loadBetterSqlite3 } from '../../src/system/load-better-sqlite3.js';
import { ensureTurnLedgerSchema } from '../../src/mesh/turn-ledger/schema.js';
import { createTurnLedger, type TurnLedger, type TurnLedgerDeps, type TurnPublisherPort } from '../../src/mesh/turn-ledger/ledger.js';
import type { CancelDispatchRequest, TurnLedgerPorts, TurnTxnHost } from '../../src/mesh/turn-ledger/effects.js';
import type { TurnBusEvent } from '../../src/mesh/turn-ledger/types.js';

export function memDb(): DatabaseHandle {
    const Database = loadBetterSqlite3();
    const db = new Database(':memory:');
    ensureTurnLedgerSchema(db);
    return db;
}

export interface PublishedEntry { meshId: string; entry: MeshTopicEntry; ref?: SummaryRef; writer: string; seq: number }

/** In-memory publisher: records appends; `failNext` / `failMesh` inject rejections. */
export function fakePublisher(writer = 'w-dc'): TurnPublisherPort & {
    entries: PublishedEntry[];
    failNext: number;
    failMesh: Set<string>;
} {
    let seq = 0;
    const port = {
        entries: [] as PublishedEntry[],
        failNext: 0,
        failMesh: new Set<string>(),
        async publish(meshId: string, entry: MeshTopicEntry, opts?: { ref?: SummaryRef }) {
            if (port.failNext > 0) { port.failNext--; throw new Error('ERR_STORAGE injected'); }
            if (port.failMesh.has(meshId)) throw new Error(`topic sealed for ${meshId}`);
            seq += 1;
            port.entries.push({ meshId, entry, ...(opts?.ref ? { ref: opts.ref } : {}), writer, seq });
            return { writer, seq };
        },
    };
    return port;
}

export interface RecordingPorts extends TurnLedgerPorts {
    calls: string[];
    bus: NonNullable<TurnLedgerPorts['bus']>;
    busEvents: TurnBusEvent[];
    cancels: CancelDispatchRequest[];
}

export function recordingPorts(): RecordingPorts {
    const calls: string[] = [];
    const busEvents: TurnBusEvent[] = [];
    const cancels: CancelDispatchRequest[] = [];
    return {
        calls,
        busEvents,
        cancels,
        bus: (event) => { calls.push(`bus:${event.phase}`); busEvents.push(event); },
        cancelDispatch: (request) => { calls.push(`cancel:${request.sessionId}:g${request.generation}`); cancels.push(request); },
        revokeWorkerBind: (request) => { calls.push(`revoke:${request.sessionId}`); },
        releaseAttemptRef: (e) => { calls.push(`release:${e.attemptId}`); },
        redeliver: (e) => { calls.push(`redeliver:${e.sessionId}`); },
        probe: (e) => { calls.push(`probe:${e.sessionId}`); },
        afterTaskTerminal: (meshId, taskId) => { calls.push(`after:${meshId}/${taskId}`); },
    };
}

/** Host that records queue/graph effects without a real mesh_queue. */
export function recordingHost(): TurnTxnHost & { calls: string[] } {
    const calls: string[] = [];
    return {
        calls,
        requeue: (e) => { calls.push(`requeue:${e.taskId}`); },
        graphAdvance: (e) => { calls.push(`graph:${e.taskId}:${e.outcome}`); return { transitioned: true }; },
    };
}

export function ledgerOn(db: DatabaseHandle, over: Partial<TurnLedgerDeps> = {}): TurnLedger {
    return createTurnLedger({ db, selfDaemonId: 'dc', autoFlush: false, now: () => T0, ...over });
}

export const T0 = 1_750_000_000_000;
export const SUMMARY: SummaryRef = { topic: 'mesh.m1.handoff', writer: 'w-dw', seq: 7 };

type BodyOf<K extends TurnEvidenceKind> = Omit<Extract<TurnEvidenceBody, { kind: K }>, 'kind'>;
let counter = 0;

/** Evidence builder: attemptRef a1/gen defaults, fresh eventId per call unless given. */
export function evd<K extends TurnEvidenceKind>(kind: K, body: BodyOf<K>, envelope: Partial<TurnEvidence> = {}): TurnEvidence {
    counter += 1;
    return {
        eventId: `ev-${kind}-${counter}`, at: T0, source: 'fsm_edge', sessionId: 's1', observedBy: 'dw',
        attemptRef: { attemptId: 'a1', generation: 0 },
        ...envelope, kind, ...body,
    } as TurnEvidence;
}

export function dispatch(opts: { attemptId?: string; session?: string; scope?: 'mesh_queue' | 'mesh_direct'; meshId?: string; taskId?: string; eventId?: string } = {}): TurnEvidence {
    return evd('dispatch_accepted', {
        scope: opts.scope ?? 'mesh_direct', messageId: 'msg-1', meshId: opts.meshId ?? 'm1', nodeId: 'n1', providerType: 'claude-cli',
        coordinator: { daemonId: 'dc', coordinatorRunId: 'run1', sessionId: 'coord' },
    }, {
        source: 'dispatch', sessionId: opts.session ?? 's1', observedBy: 'dc',
        attemptRef: { attemptId: opts.attemptId ?? 'a1', generation: 0 }, taskId: opts.taskId ?? 't1',
        ...(opts.eventId ? { eventId: opts.eventId } : {}),
    });
}

export const LIVE_IDLE = { modal: false, adapterPending: false, trailingTool: false };

/** The rows of a kind in turn_events. */
export function rowsOf(db: DatabaseHandle, kind: string, attemptId?: string): Array<Record<string, unknown>> {
    return (attemptId
        ? db.prepare('SELECT * FROM turn_events WHERE kind = ? AND attempt_id = ? ORDER BY rowid').all(kind, attemptId)
        : db.prepare('SELECT * FROM turn_events WHERE kind = ? ORDER BY rowid').all(kind)) as Array<Record<string, unknown>>;
}

export function pendingCount(db: DatabaseHandle): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM turn_events WHERE publish_state = 'pending'`).get() as { n: number }).n;
}
