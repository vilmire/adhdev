/**
 * Stage 1 convergence probe — makes "two machines are converging" OBSERVABLE.
 *
 * Phase 2 Stage 1 of the seqscribe integration
 * (docs/design/2026-08-26-seqscribe-integration-plan.md).
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 * Stage 0 landed the whole apparatus — topics, authority, fleet secret,
 * RTCDataChannel attach — and it runs live. But nothing CALLS it: there is no
 * producer and no consumer in the daemon, so a fleet can be perfectly wired
 * and perfectly silent, and an operator has no way to tell that state apart
 * from a fleet that is broken. This module appends a small record and logs the
 * records other daemons wrote, so one grep answers "did convergence happen?".
 *
 * ── Why `assistant.journal` and not a new topic ────────────────────────────
 * A new topic is not free: `kind`, conflict policy and `finalityAuthority` are
 * inside `topicSchemaHash`, so introducing one is a COORDINATED FLEET UPGRADE
 * (host-guide §6) — every peer refuses the topic until all daemons carry it.
 * That is a real cost to pay for a diagnostic. `assistant.journal` already
 * fits without any of it:
 *
 *   - `full-sync` + `append`, so entries converge on mutual attach with no
 *     served view or subscription machinery (the ring topics `fleet.status`
 *     and `session.*.transcript` are `subscribe-only`, which needs both).
 *   - it is the Phase 1 GREENFIELD topic with an official producer/consumer
 *     pair (journal.ts) — exactly the calls a real consumer will make.
 *   - it has no legacy consumer to disturb: the assistant feature is unbuilt,
 *     so a probe entry cannot be mistaken for production data by anything.
 *
 * The cost is that `assistant.journal` is CONTENT class, so the probe is
 * silent without the fleet secret (node.ts defines no content topics in
 * provisional mode). That is the honest behaviour: with no secret there is no
 * finality and nothing to observe converging in the sense we care about.
 *
 * ── §6.1 payload boundary ──────────────────────────────────────────────────
 * The payload is `{ writerId, daemonId, version, bootId, at }` and MUST stay
 * that shape: identifiers, a version string, a timestamp. No secret, no
 * config, no user- or agent-authored text. `assistant.journal` replicates to
 * every daemon in the fleet, so anything added here is published fleet-wide.
 * The fleet secret in particular never appears in a payload — see
 * fleet-secret.ts and the design's §6.1 canary tests.
 *
 * ── This is a probe, not Stage 2 ───────────────────────────────────────────
 * Deliberately NOT a mesh-event dual-write. It carries no mesh event, feeds no
 * derived state, and nothing downstream may consume it — it exists to be seen
 * in a log. Stage 2 (mesh.events dual-write) is a separate, flagged cutover.
 */

import { LOG } from '../logging/logger.js';
import { appendAssistantJournal, consumeAssistantJournal } from './journal.js';
import type { SeqscribeNodeHandle } from './node.js';
import { ASSISTANT_JOURNAL_TOPIC } from './topics.js';

/** Entry `kind` for probe records. Namespaced so a real consumer can skip them. */
export const PROBE_ENTRY_KIND = 'adhdev.probe.heartbeat';

/**
 * Durable consumer name for the probe tail.
 *
 * The cursor is persisted in `sq_cursors` under this exact string (journal.ts),
 * so renaming it replays the whole retained log once. Treat it as an identity.
 */
export const PROBE_CONSUMER = 'stage1-convergence-probe';

/**
 * Probe cadence. Long on purpose: one record per daemon per interval is enough
 * to prove liveness, while `assistant.journal` keeps FULL retention until
 * finality archives it — a chatty probe would grow the log of every daemon in
 * the fleet for no extra signal.
 */
export const PROBE_INTERVAL_MS = 30 * 60 * 1000;

/** §6.1: identifiers, a version, a timestamp. Never widen to free text. */
export interface ProbePayload {
    writerId: string;
    daemonId: string | null;
    version: string;
    bootId: string;
    at: number;
}

export interface ProbeOptions {
    /** Daemon build version, for correlating a converging pair across a rollout. */
    version?: string;
    /** Per-process boot id — distinguishes a restart from a still-running daemon. */
    bootId?: string;
    /** Cadence override. TESTS ONLY; production uses PROBE_INTERVAL_MS. */
    intervalMs?: number;
    /**
     * Emit only the boot record and never arm the interval. TESTS ONLY — an
     * armed timer would outlive the assertion and keep the loop alive.
     */
    once?: boolean;
}

export interface ProbeHandle {
    stop(): void;
    /** Probe records observed from OTHER writers. Exposed for tests. */
    remoteSeen(): number;
}

/**
 * Shorten an id for logs. Full writerIds are 8 random bytes plus a prefix and
 * add nothing to a log line; the head is enough to tell two writers apart.
 */
function shortId(id: string): string {
    return id.length <= 12 ? id : `${id.slice(0, 12)}…`;
}

/**
 * Start the probe: append one record now, log every record another writer
 * appended, and repeat on a slow cadence.
 *
 * Returns null when `assistant.journal` is not defined on this node — the
 * provisional (no fleet secret) mode. That is a supported state, not an error,
 * so the caller treats null as "nothing to observe" and carries on.
 *
 * Never throws: this is diagnostics, and a probe failure must not take a
 * daemon boot with it.
 */
export function startConvergenceProbe(
    handle: SeqscribeNodeHandle,
    opts: ProbeOptions = {},
): ProbeHandle | null {
    if (!handle.topics.some((d) => d.topic === ASSISTANT_JOURNAL_TOPIC)) {
        LOG.info(
            'Seqscribe',
            'convergence probe idle — assistant.journal is not defined on this node ' +
                '(no fleet secret; metadata-topics-only mode)',
        );
        return null;
    }

    const version = opts.version ?? 'unknown';
    const bootId = opts.bootId ?? 'unknown';
    let remoteSeen = 0;
    let stopped = false;

    // Register the consumer BEFORE the first append so a peer's backlog that is
    // already converged is reported on this boot rather than silently skipped.
    let unsub: (() => void) | null = null;
    try {
        unsub = consumeAssistantJournal(handle, PROBE_CONSUMER, (entry) => {
            if (entry.kind !== PROBE_ENTRY_KIND) return;
            // Our own records come back through the same cursor. Only a REMOTE
            // writer is evidence of convergence — logging our own would make an
            // isolated daemon look healthy.
            if (entry.writer === handle.writerId) return;
            remoteSeen++;
            const payload = entry.payload as Partial<ProbePayload> | null;
            const version = typeof payload?.version === 'string' ? payload.version : 'unknown';
            LOG.info(
                'Seqscribe',
                `converge writer=${shortId(entry.writer)} seq=${entry.seq} version=${version} total=${remoteSeen}`,
            );
        });
    } catch (err) {
        LOG.warn(
            'Seqscribe',
            `convergence probe consumer failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
    }

    const emit = (reason: 'boot' | 'tick'): void => {
        if (stopped) return;
        const payload: ProbePayload = {
            writerId: handle.writerId,
            daemonId: handle.daemonId,
            version,
            bootId,
            at: Date.now(),
        };
        void appendAssistantJournal(handle, PROBE_ENTRY_KIND, { ...payload }).then(
            () => {
                if (reason === 'boot') {
                    LOG.info(
                        'Seqscribe',
                        `convergence probe armed writer=${shortId(handle.writerId)} topic=${ASSISTANT_JOURNAL_TOPIC}`,
                    );
                }
            },
            (err: unknown) => {
                LOG.warn(
                    'Seqscribe',
                    `convergence probe append failed (${reason}): ${err instanceof Error ? err.message : String(err)}`,
                );
            },
        );
    };

    emit('boot');

    let timer: ReturnType<typeof setInterval> | null = null;
    if (!opts.once) {
        timer = setInterval(() => emit('tick'), opts.intervalMs ?? PROBE_INTERVAL_MS);
        // The probe must never be the reason a process stays alive.
        timer.unref?.();
    }

    return {
        stop(): void {
            if (stopped) return;
            stopped = true;
            if (timer) clearInterval(timer);
            try {
                unsub?.();
            } catch {
                /* already gone */
            }
        },
        remoteSeen: () => remoteSeen,
    };
}
