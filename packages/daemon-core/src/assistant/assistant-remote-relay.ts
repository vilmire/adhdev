/**
 * Result path for remote-hosted projects (owner decision 2026-10-08, design
 * 2026-10-07-assistant-layer.md §4.3 "수신").
 *
 * A local project's relay fires on the coordinator's `turn{committed}` on this
 * daemon's bus. A remote-hosted project's coordinator commits on its HOST's
 * bus, and nothing of it reaches this daemon on its own: a coordinator's turns
 * are PLAIN attempts with no mesh id (turn-ledger `isPublishableAttempt`), so
 * they never enter the replicated `mesh.<id>.events` topic — and that topic is
 * content-free anyway, so it could not carry the reply. This module therefore
 * polls the host while the project's thread is open:
 *
 *   `assistant_remote_project {op:'poll', afterAttemptId}` → the host's ledger
 *   answers which coordinator turns committed after the cursor (each with its
 *   age on the HOST's clock, so no cross-machine clock skew enters), the
 *   coordinator's latest reply (read by the host with the same read_chat
 *   projection a local relay uses), whether a turn is open or parked on a
 *   modal, and the content-free work counts / `[Mesh]` line.
 *
 * Commits go into `AssistantRelay.onRemoteCommitted` — the same batching,
 * per-attempt dedupe (the relay store row), envelope and delivery as a local
 * relay. The host decides "done" (its ledger); this module never judges it.
 *
 * Without a usable cursor (this daemon restarted, or the coordinator session
 * changed) only commits younger than the thread's last send are relayed — the
 * ages make that comparison skew-free — so a turn from before the send is
 * never relayed as its answer.
 *
 * Failure is never silent: after `UNREACHABLE_AFTER_FAILURES` consecutive
 * failed polls the open thread gets one `unreachable` relay card, polls back
 * off to `POLL_BACKOFF_MS`, and the first successful poll resumes normal
 * cadence (a commit made meanwhile is relayed then).
 */

import type { TurnOutcome } from '@adhdev/mesh-shared';
import type { AssistantRelay, MeshWorkCounts } from './assistant-relay.js';
import type { RemoteCallOutcome, RemoteHostView } from './assistant-remote-host.js';

export const REMOTE_POLL_MS = 10_000;
export const POLL_BACKOFF_MS = 60_000;
export const UNREACHABLE_AFTER_FAILURES = 3;
/** Slack on the commit-age vs. last-send comparison (round-trip latency). */
export const COMMIT_AGE_SLACK_MS = 5_000;

export interface RemoteRelayPollerPorts {
    /** Open assistant threads (relay store rows). */
    openThreads(): Array<{ meshId: string; lastSendAt: number }>;
    /** The host of a remote-hosted mesh; null when this daemon hosts it (or it is gone). */
    remoteTarget(meshId: string): RemoteHostView | null;
    poll(target: RemoteHostView, args: { afterAttemptId?: string }): Promise<RemoteCallOutcome>;
    relay: Pick<AssistantRelay, 'onRemoteCommitted' | 'observeRemote' | 'remoteUnreachable'>;
    now?(): number;
}

interface MeshPollState {
    cursor: string | null;
    failures: number;
    signaled: boolean;
    nextAt: number;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function workOf(v: unknown): MeshWorkCounts | null {
    const w = v && typeof v === 'object' ? v as Record<string, unknown> : null;
    if (!w) return null;
    const n = (k: string) => (typeof w[k] === 'number' && Number.isFinite(w[k]) ? w[k] as number : 0);
    return { activeMissions: n('activeMissions'), pending: n('pending'), assigned: n('assigned') };
}

export class AssistantRemoteRelayPoller {
    private readonly state = new Map<string, MeshPollState>();
    private running: Promise<void> | null = null;

    constructor(private readonly ports: RemoteRelayPollerPorts) {}

    private now(): number {
        return this.ports.now ? this.ports.now() : Date.now();
    }

    /** `project_send` was accepted by the host: poll from `cursor` (the host's newest commit before the send). */
    noteSent(meshId: string, cursor: string | null): void {
        const prev = this.state.get(meshId);
        this.state.set(meshId, { cursor: cursor ?? prev?.cursor ?? null, failures: 0, signaled: prev?.signaled ?? false, nextAt: 0 });
    }

    /** One pass over the open remote threads that are due. Overlapping calls share the pass. */
    tick(): Promise<void> {
        if (!this.running) {
            this.running = this.pass().finally(() => { this.running = null; });
        }
        return this.running;
    }

    private async pass(): Promise<void> {
        const threads = this.ports.openThreads();
        const open = new Set(threads.map((t) => t.meshId));
        for (const meshId of [...this.state.keys()]) if (!open.has(meshId)) this.state.delete(meshId);
        const now = this.now();
        for (const { meshId, lastSendAt } of threads) {
            let target: RemoteHostView | null = null;
            try { target = this.ports.remoteTarget(meshId); } catch { target = null; }
            if (!target) continue;
            const st = this.state.get(meshId) ?? { cursor: null, failures: 0, signaled: false, nextAt: 0 };
            this.state.set(meshId, st);
            if (st.nextAt > now) continue;
            await this.pollOne(meshId, target, st, lastSendAt);
        }
    }

    private async pollOne(meshId: string, target: RemoteHostView, st: MeshPollState, lastSendAt: number): Promise<void> {
        let out: RemoteCallOutcome;
        if (!target.reachable) {
            out = { ok: false, kind: 'unreachable', code: 'project_unreachable', reason: target.reason ?? 'relay_failed', error: 'host unreachable' };
        } else {
            try {
                out = await this.ports.poll(target, st.cursor ? { afterAttemptId: st.cursor } : {});
            } catch (e) {
                out = { ok: false, kind: 'unreachable', code: 'project_unreachable', reason: 'relay_failed', error: e instanceof Error ? e.message : String(e) };
            }
        }
        if (!out.ok) {
            st.failures += 1;
            if (st.failures >= UNREACHABLE_AFTER_FAILURES) {
                if (!st.signaled) {
                    st.signaled = true;
                    const reason = out.kind === 'unreachable' ? out.reason : out.code === 'host_unsupported' ? 'host_unsupported' : 'host_refused';
                    this.ports.relay.remoteUnreachable(meshId, target.label, reason);
                }
                st.nextAt = this.now() + POLL_BACKOFF_MS;
            }
            return;
        }
        st.failures = 0;
        st.signaled = false;
        st.nextAt = 0;
        const r = out.result;
        const sessionId = str(r.coordinatorSessionId);
        const commits = Array.isArray(r.commits) ? r.commits : [];
        // No usable cursor → only what committed after the last send (host-clock ages).
        const ageLimit = !st.cursor || r.cursorFound !== true ? this.now() - lastSendAt + COMMIT_AGE_SLACK_MS : null;
        const valid = commits
            .map((c: any) => ({
                attemptId: str(c?.attemptId),
                outcome: (str(c?.outcome) || 'completed') as TurnOutcome,
                ageMs: typeof c?.ageMs === 'number' && Number.isFinite(c.ageMs) ? c.ageMs as number : null,
            }))
            .filter((c) => c.attemptId && (ageLimit === null || (c.ageMs !== null && c.ageMs <= ageLimit)));
        valid.forEach((c, i) => {
            this.ports.relay.onRemoteCommitted(meshId, {
                attemptId: c.attemptId,
                coordinatorSessionId: sessionId,
                outcome: c.outcome,
                body: i === valid.length - 1 && typeof r.body === 'string' ? r.body : null,
            });
        });
        // The host's newest commit becomes the cursor whether or not it was relayed.
        if (str(r.cursor)) st.cursor = str(r.cursor);
        else if (valid.length) st.cursor = valid[valid.length - 1]!.attemptId;
        this.ports.relay.observeRemote(meshId, {
            open: r.open === true,
            modal: r.modal === true,
            work: workOf(r.work),
            statusLine: typeof r.statusLine === 'string' ? r.statusLine : null,
        });
    }
}
