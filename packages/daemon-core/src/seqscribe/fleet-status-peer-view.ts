/**
 * Phase 4 Stage 2 — receive-side `fleet.status` SUB consumer.
 *
 * ★ `fleet.status` is a ring topic. seqscribe deliberately rejects durable
 * `onEntry(topic, consumer, ...)` registration for ring/none retention with
 * ERR_MISUSE (`onEntry requires retention "full" ... ring/none serve via SUB`).
 * Therefore this module has exactly one read path: a connection-scoped
 * `subscribe({ view: 'tail', params: { topic: FLEET_STATUS_TOPIC } })` for every
 * READY daemon peer. Do not replace this with onEntry or a local scan — ring
 * payloads are in-memory and subscribe-only by contract.
 *
 * The view is latest-only per serving peer. A SNAP replaces that peer's local
 * slot from the newest valid row in the retained tail; a DELTA replaces it only
 * when the incoming seqscribe order is newer. Detach removes the slot, so the
 * P2P payload stays bounded by currently subscribed peers and cannot present a
 * disconnected peer's old entry as a live cross-check.
 *
 * Every payload is re-projected through `projectFleetStatusEntry` and compared
 * with the serving peer's daemon identity. This both drops schema additions and
 * prevents one peer from painting another machine's dashboard card. Counters
 * record only numbers — no payload, nickname or dynamic key reaches diagnostics.
 */

import { daemonIdsEquivalent } from '@adhdev/mesh-shared';
import type { PeerHandle, Row, Subscription } from 'seqscribe';
import type {
    FleetStatusPeerEntry,
    FleetStatusPeerView,
    FleetStatusPeerViewDiagnostics,
} from '../shared-types.js';
import { projectFleetStatusEntry, type FleetStatusEntry } from '../status/reporter.js';
import { FLEET_STATUS_ENTRY_KIND } from './fleet-status-shadow.js';
import type { SeqscribeNodeHandle } from './node.js';
import { FLEET_STATUS_TOPIC } from './topics.js';

export const FLEET_STATUS_SUB_VIEW = 'tail';

interface EntryOrder {
    hlcL: number;
    hlcC: number;
    writer: string;
    seq: number;
}

interface ReceivedEntry {
    entry: FleetStatusEntry;
    order: EntryOrder;
}

interface ActivePeerSubscription {
    generation: number;
    subscription: Subscription;
    unsubscribeSnapshot: () => void;
    unsubscribeDelta: () => void;
}

function emptyDiagnostics(): Omit<FleetStatusPeerViewDiagnostics, 'subscribedPeers'> {
    return {
        receivedEntries: 0,
        comparedEntries: 0,
        matchedEntries: 0,
        mismatchedEntries: 0,
        invalidEntries: 0,
        viewReplacements: 0,
    };
}

function finiteInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function compareOrder(a: EntryOrder, b: EntryOrder): number {
    if (a.hlcL !== b.hlcL) return a.hlcL - b.hlcL;
    if (a.hlcC !== b.hlcC) return a.hlcC - b.hlcC;
    if (a.writer !== b.writer) return a.writer < b.writer ? -1 : 1;
    return a.seq - b.seq;
}

function cloneEntry(entry: FleetStatusEntry): FleetStatusPeerEntry {
    return {
        daemonId: entry.daemonId,
        at: entry.at,
        onlineState: entry.onlineState,
        p2pActive: entry.p2pActive,
        sessionCounts: { ...entry.sessionCounts },
        ...(entry.seqscribe ? { seqscribe: { ...entry.seqscribe } } : {}),
    };
}

function parseTailRow(row: Row): ReceivedEntry | null {
    if (row.kind !== FLEET_STATUS_ENTRY_KIND || typeof row.payload !== 'string') return null;
    const hlcL = finiteInteger(row.hlc_l);
    const hlcC = finiteInteger(row.hlc_c);
    const seq = finiteInteger(row.seq);
    if (hlcL === null || hlcC === null || seq === null || typeof row.writer !== 'string') return null;

    let raw: unknown;
    try {
        raw = JSON.parse(row.payload);
    } catch {
        return null;
    }
    const entry = projectFleetStatusEntry(raw);
    if (!entry) return null;
    return { entry, order: { hlcL, hlcC, writer: row.writer, seq } };
}

export interface FleetStatusPeerViewConsumer {
    /** Attach the ring-tail SUB after the peer reaches READY. Never throws. */
    attachPeer(peerId: string, peer: PeerHandle): boolean;
    /** Close one connection-scoped SUB and remove its live view slot. */
    detachPeer(peerId: string): void;
    /** Pure in-memory read for rich P2P status and get_status_metadata. */
    snapshot(): FleetStatusPeerView;
    /** Close every SUB and clear the process-local view. */
    stop(): void;
}

/** Create one receive-side view owner for one daemon-owned seqscribe node. */
export function createFleetStatusPeerViewConsumer(
    handle: SeqscribeNodeHandle,
): FleetStatusPeerViewConsumer {
    const active = new Map<string, ActivePeerSubscription>();
    const latest = new Map<string, ReceivedEntry>();
    const diagnostics = emptyDiagnostics();
    let nextGeneration = 1;
    let stopped = false;

    const closeSubscription = (peerId: string, removeView: boolean): void => {
        const current = active.get(peerId);
        if (current) {
            active.delete(peerId);
            try { current.unsubscribeSnapshot(); } catch { /* noop */ }
            try { current.unsubscribeDelta(); } catch { /* noop */ }
            try { current.subscription.close(); } catch { /* peer may already be closed */ }
        }
        if (removeView) latest.delete(peerId);
    };

    const acceptRows = (
        peerId: string,
        generation: number,
        rows: Row[],
        replaceSnapshot: boolean,
    ): void => {
        if (stopped || active.get(peerId)?.generation !== generation) return;
        let newest: ReceivedEntry | null = null;

        for (const row of rows) {
            diagnostics.receivedEntries++;
            const parsed = parseTailRow(row);
            if (!parsed) {
                diagnostics.invalidEntries++;
                continue;
            }
            diagnostics.comparedEntries++;
            if (!daemonIdsEquivalent(parsed.entry.daemonId, peerId)) {
                diagnostics.mismatchedEntries++;
                continue;
            }
            diagnostics.matchedEntries++;
            if (!newest || compareOrder(parsed.order, newest.order) > 0) newest = parsed;
        }

        if (replaceSnapshot) {
            // SNAP is authoritative for this connection's retained ring tail.
            // An empty/invalid tail clears the slot rather than laundering an
            // older connection's value into the new epoch.
            if (!newest) {
                latest.delete(peerId);
                return;
            }
            latest.set(peerId, newest);
            diagnostics.viewReplacements++;
            return;
        }

        if (!newest) return;
        const current = latest.get(peerId);
        if (!current || compareOrder(newest.order, current.order) > 0) {
            latest.set(peerId, newest);
            diagnostics.viewReplacements++;
        }
    };

    return {
        attachPeer(peerId, peer): boolean {
            if (stopped || !peerId || peer.state() !== 'ready') return false;
            closeSubscription(peerId, true);
            const generation = nextGeneration++;
            let subscription: Subscription | null = null;
            let unsubscribeSnapshot: (() => void) | null = null;
            let unsubscribeDelta: (() => void) | null = null;
            try {
                // ★ The only legal ring read. onEntry is ERR_MISUSE here.
                subscription = handle.node.subscribe(peer, {
                    view: FLEET_STATUS_SUB_VIEW,
                    params: { topic: FLEET_STATUS_TOPIC },
                });
                unsubscribeSnapshot = subscription.onSnapshot((rows) => {
                    acceptRows(peerId, generation, rows, true);
                });
                unsubscribeDelta = subscription.onDelta((changes) => {
                    acceptRows(peerId, generation, changes.upserts, false);
                });
                active.set(peerId, {
                    generation,
                    subscription,
                    unsubscribeSnapshot,
                    unsubscribeDelta,
                });
                return true;
            } catch {
                try { unsubscribeSnapshot?.(); } catch { /* noop */ }
                try { unsubscribeDelta?.(); } catch { /* noop */ }
                try { subscription?.close(); } catch { /* noop */ }
                latest.delete(peerId);
                return false;
            }
        },

        detachPeer(peerId): void {
            closeSubscription(peerId, true);
        },

        snapshot(): FleetStatusPeerView {
            const peers = Array.from(latest.values())
                .map(({ entry }) => cloneEntry(entry))
                .sort((a, b) => a.daemonId.localeCompare(b.daemonId));
            return {
                peers,
                diagnostics: {
                    subscribedPeers: active.size,
                    ...diagnostics,
                },
            };
        },

        stop(): void {
            if (stopped) return;
            stopped = true;
            for (const peerId of Array.from(active.keys())) closeSubscription(peerId, true);
            latest.clear();
        },
    };
}
