/**
 * Durable-consumer registration for the Stage 5a-2 terminal redrive.
 *
 * The POLICY (what a terminal is, what injection to build, how failures count)
 * lives in `mesh/mesh-terminal-redrive.ts`. This file owns only the seqscribe
 * side: which topics to register on, under what consumer name, and how a
 * callback's outcome maps onto the durable cursor.
 *
 * ★ The split is forced by `check:boundaries`: `seqscribe/**` may not import
 * `mesh/**`. Rather than route around that, the handler arrives as a callback —
 * which is also the better shape, since it lets the gate drive the consumer with
 * a stub and assert cursor behaviour without a live pending queue.
 *
 * ── Cursor semantics this file is responsible for ─────────────────────────
 * `onEntry` advances the durable cursor only after the callback's promise
 * resolves; a throw leaves it and retries with backoff (SPEC §9). We deliberately
 * do NOT catch handler errors: not advancing is what preserves the redelivery
 * guarantee this consumer exists to provide. The cost of that choice — a stuck
 * cursor pins the topic's §7.6 archive floor open — is real, and is why §11-3
 * resolved to an auto-resolving quarantine (5a-4) rather than a WARN.
 *
 * ★ Quarantine (5a-4) needs NO changes in this file. It is implemented entirely
 * as a policy decision inside the injected handler (`consumeRedriveEntry`,
 * mesh-terminal-redrive.ts): once a mesh is quarantined, that function returns
 * instead of throwing, so the `await handler(...)` below resolves normally and
 * the cursor advances — exactly the same path a non-terminal skip already
 * takes. This file's only job (advance on resolve, hold on throw) already
 * implements "quarantine releases the archive floor" for free.
 */

import { LOG } from '../logging/logger.js';
import { MESH_EVENT_ENTRY_KIND } from './mesh-event-projection.js';
import { meshEventsTopic, meshIdFromEventsTopic } from './topics.js';
import type { SeqscribeNodeHandle } from './node.js';

/**
 * The projected entry a handler receives, plus the mesh it belongs to.
 * Structurally the `ProjectedMeshEvent` written by the dual-write.
 */
export interface RedriveEntryEnvelope {
    meshId: string;
    entry: {
        id: string;
        ledgerKind: string;
        nodeId?: string | null;
        sessionId?: string | null;
        providerType?: string | null;
        taskId?: string | null;
        payload: Record<string, string | number | boolean>;
    };
}

/** Handler contract. Throwing holds the cursor; returning advances it. */
export type RedriveHandler = (envelope: RedriveEntryEnvelope) => void | Promise<void>;

interface Registration {
    topic: string;
    unsub: () => void;
}

const registrations = new Map<string, Registration>();
let activeNode: SeqscribeNodeHandle | null = null;
let activeHandler: RedriveHandler | null = null;
let activeConsumerName: string | null = null;

/**
 * Attach (or detach with `null`) the redrive consumer.
 *
 * Detaching unsubscribes every per-mesh registration; the durable cursors stay,
 * so a re-attach resumes from where it left off rather than replaying.
 */
export function configureTerminalRedrive(
    node: SeqscribeNodeHandle | null,
    opts?: { consumerName: string; handler: RedriveHandler },
): void {
    for (const registration of registrations.values()) {
        try {
            registration.unsub();
        } catch {
            /* already gone */
        }
    }
    registrations.clear();
    activeNode = node;
    activeHandler = opts?.handler ?? null;
    activeConsumerName = opts?.consumerName ?? null;
}

/**
 * Register the redrive consumer on one mesh's events topic. Idempotent.
 *
 * Returns false when the node is not attached or the topic is not defined on it
 * — the normal state for a mesh that has produced no events yet, and not an
 * error.
 */
export function ensureTerminalRedriveConsumer(meshId: string): boolean {
    const node = activeNode;
    const handler = activeHandler;
    const consumerName = activeConsumerName;
    if (!node || !handler || !consumerName) return false;
    if (registrations.has(meshId)) return true;

    const topic = meshEventsTopic(meshId);
    if (!node.topics.some((d) => d.topic === topic)) return false;

    try {
        const unsub = node.node.onEntry(topic, consumerName, async (entry) => {
            // The topic carries only projected mesh ledger records, but guard the
            // kind anyway — advancing past a foreign entry is correct, injecting
            // one is not.
            if (entry.kind !== MESH_EVENT_ENTRY_KIND) return;
            const projected = entry.payload;
            if (!projected || typeof projected !== 'object') return;
            const record = projected as Record<string, unknown>;
            if (typeof record.id !== 'string' || typeof record.ledgerKind !== 'string') return;
            // ★ Await, so a rejected handler rejects the onEntry callback and the
            // cursor is held. Swallowing here would silently convert a failed
            // redelivery into a delivered one.
            await handler({
                meshId,
                entry: {
                    id: record.id,
                    ledgerKind: record.ledgerKind,
                    nodeId: typeof record.nodeId === 'string' ? record.nodeId : null,
                    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
                    providerType: typeof record.providerType === 'string' ? record.providerType : null,
                    taskId: typeof record.taskId === 'string' ? record.taskId : null,
                    payload: record.payload && typeof record.payload === 'object'
                        ? (record.payload as Record<string, string | number | boolean>)
                        : {},
                },
            });
        });
        registrations.set(meshId, { topic, unsub });
        return true;
    } catch (error) {
        LOG.warn(
            'MeshRedrive',
            `redrive consumer failed to register topic=${topic}: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return false;
    }
}

/**
 * Register on every mesh events topic already defined on this node.
 *
 * ★ Driven by the node's own topic list rather than a mesh roster, for the same
 * boundary reason `pruneStaleConsumersAtBoot` is (seqscribe may not import mesh).
 */
export function ensureTerminalRedriveConsumersAtBoot(): number {
    const node = activeNode;
    if (!node) return 0;
    let registered = 0;
    for (const definition of node.topics) {
        const meshId = meshIdFromEventsTopic(definition.topic);
        if (meshId === null) continue;
        if (ensureTerminalRedriveConsumer(meshId)) registered++;
    }
    return registered;
}

/** Meshes this process currently holds a redrive registration for. TESTS/diagnostics. */
export function registeredRedriveMeshIds(): string[] {
    return [...registrations.keys()].sort();
}

/** Reset all module state. TESTS ONLY. */
export function __resetTerminalRedriveConsumerForTests(): void {
    configureTerminalRedrive(null);
}
