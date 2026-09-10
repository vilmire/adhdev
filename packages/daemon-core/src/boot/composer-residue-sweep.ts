/**
 * ENTER-LOSS layer ③ — boot-time composer-residue detection & recovery.
 *
 * 2026-09-10 incident: a worker-completion notification (10,937 chars) was
 * written into the coordinator's PTY composer, the daemon restarted (upgrade)
 * before the delayed submit CR fired, and the new daemon never noticed — the
 * pending-event ledger had marked the event drained BEFORE the PTY write
 * (consume-before-submit ordering, mesh-events-pending.ts), so no redelivery
 * happened. The body sat in the session-host composer for 1h42m and was then
 * merge-submitted together with the owner's next input.
 *
 * Layer ① (cliManager.drainInFlightSubmits, run by shutdownDaemonComponents)
 * closes the GRACEFUL shutdown path. This sweep is the backstop for every path
 * ① cannot reach — SIGKILL, crash, power loss, or a ① timeout — by checking,
 * once per boot after restored sessions have settled, whether any idle
 * session's composer still holds the body of a recently-drained notification.
 *
 * Behaviour (owner decision, 2026-09-10):
 *  - DEFAULT = detect + log + expose findings. NO auto-submit: if the daemon
 *    died MID-write the residue is a TRUNCATED body, and submitting it would
 *    inject a corrupted message as a real turn.
 *  - Recovery (pressing Enter) happens ONLY when BOTH hold:
 *      (a) env ADHDEV_COMPOSER_RESIDUE_AUTOSUBMIT is '1'/'true', AND
 *      (b) integrity === 'full': the ENTIRE ledger original — head through tail,
 *          whitespace-collapsed — is present in the session's scrollback-
 *          inclusive screen text AND its tail is on the visible viewport.
 *          Prefix/partial presence is never enough.
 *  - Residue that matches NO ledger candidate is still logged (content-free):
 *    it is the observation point for unexplained composer text.
 *
 * All logs here are CONTENT-FREE by construction: ids, lengths and match
 * verdicts only — composer text and notification bodies are user/agent data.
 */
'use strict';

import { LOG } from '../logging/logger.js';
import { normalizeForEcho } from '../providers/spec/fsm-driver.js';
import { MeshRuntimeStore } from '../mesh/mesh-runtime-store.js';
import type { CliAdapter } from '../cli-adapter-types.js';

/** Probe length (normalized chars) for the head/tail presence checks — wider
 *  than the echo-gate's 16 to keep the false-positive rate down on a whole-
 *  ledger scan (the echo-gate compares one known body; this compares many). */
const RESIDUE_PROBE_CHARS = 24;
/** Bodies shorter than this are not residue-matched: short generic strings
 *  ("done", "ok, proceeding") appear all over a terminal screen and would make
 *  every match ambiguous. The incident class is long notifications anyway —
 *  the split-CR window only opens at VERIFIED_SUBMIT_MIN_CHARS (512). */
const RESIDUE_MIN_BODY_CHARS = 64;
/** How far back drained ledger rows are considered. Bounded so a months-old
 *  drained row can never be "identified" as today's residue. */
const RESIDUE_LOOKBACK_MS = 24 * 60 * 60_000;
/** Delay before the one-shot sweep: restored session-host sessions must have
 *  re-attached and replayed their screens, and the FSM must have settled out of
 *  'starting'. Both daemons call restoreHostedSessions right after init, so
 *  this comfortably follows it. Overridable for tests. */
const DEFAULT_SWEEP_DELAY_MS = 45_000;

export const COMPOSER_RESIDUE_AUTOSUBMIT_ENV = 'ADHDEV_COMPOSER_RESIDUE_AUTOSUBMIT';

export interface ResidueSweepSession {
    /** Adapter key (session/runtime id) — safe to log. */
    key: string;
    cliType: string;
    /** Adapter coarse status; only 'idle' sessions are swept. */
    status: string | undefined;
    /** Visible viewport text (raw terminal — never log). */
    viewportText: string;
    /** Scrollback-inclusive text (raw terminal — never log). */
    scrollbackText: string;
    /** Presses the submit key (a single CR) on this session's composer. */
    submitComposer?: () => void;
}

export interface ResidueSweepCandidate {
    rowId: string;
    meshId: string;
    event: string;
    eventId: string | null;
    taskId: string | null;
    drainedAt: number;
    /** The exact text injected into the coordinator PTY (ledger original). */
    coordinatorMessage: string;
}

export interface ResidueSweepDeps {
    sessions: ResidueSweepSession[];
    candidates: ResidueSweepCandidate[];
    /** true only when the env flag opts in — see module doc. */
    autoRecoverEnabled: boolean;
}

export interface ResidueFinding {
    sessionKey: string;
    cliType: string;
    kind: 'identified' | 'unidentified';
    /** Present for kind='identified'. */
    candidate?: {
        meshId: string;
        event: string;
        eventId: string | null;
        taskId: string | null;
        drainedAt: number;
        bodyLength: number;
    };
    /** 'full' = entire ledger original present (recovery-eligible);
     *  'partial' = probes matched but the whole body is NOT fully present —
     *  the truncated-write signature; NEVER recovered. */
    integrity?: 'full' | 'partial';
    /** True when this sweep actually pressed Enter for the finding. */
    recovered: boolean;
    /** Composer-line content length for kind='unidentified' (content-free). */
    residueLength?: number;
}

/** Prompt markers the unidentified-residue heuristic recognizes at the start of
 *  a composer line. Conservative: markers used by the shipped TUI composers. */
const COMPOSER_PROMPT_MARKERS = ['❯', '›', '>'];

/**
 * Heuristic: does the tail of the viewport show a non-empty composer line?
 * Returns the residual text length (0 = none). Only the LAST few non-empty
 * lines are considered — a prompt-marker line mid-screen is ordinary output.
 */
function detectNonEmptyComposerTail(viewportText: string): number {
    const lines = viewportText.split('\n').map(l => l.trimEnd());
    const tail = lines.filter(l => l.trim().length > 0).slice(-6);
    for (const line of tail) {
        const trimmed = line.trimStart();
        for (const marker of COMPOSER_PROMPT_MARKERS) {
            if (!trimmed.startsWith(marker)) continue;
            const content = trimmed.slice(marker.length).trim();
            if (content.length >= 8) return content.length;
        }
    }
    return 0;
}

/**
 * Match verdict of one candidate body against one session's screen text.
 *  - null: not present (no residue of this candidate).
 *  - 'partial': head+tail probes present but the full body is not — either a
 *    truncated write or heavy composer re-rendering; never recovery-eligible.
 *  - 'full': the entire normalized body is present in the scrollback-inclusive
 *    text and its tail is on the visible viewport (the strict recovery gate).
 */
function matchCandidate(
    session: { viewportText: string; scrollbackText: string },
    body: string,
): 'full' | 'partial' | null {
    const norm = normalizeForEcho(body);
    if (norm.length === 0) return null;
    const head = norm.slice(0, RESIDUE_PROBE_CHARS);
    const tail = norm.slice(-RESIDUE_PROBE_CHARS);
    const viewport = normalizeForEcho(session.viewportText);
    if (!viewport.includes(tail)) return null;
    const full = normalizeForEcho(session.scrollbackText);
    if (!full.includes(head)) return null;
    return full.includes(norm) ? 'full' : 'partial';
}

/**
 * Pure sweep core (unit-testable). Scans idle sessions for residue of drained
 * notification bodies; logs every finding (content-free); presses Enter only
 * under the strict recovery gate described in the module doc.
 */
export function runComposerResidueSweep(deps: ResidueSweepDeps): ResidueFinding[] {
    const findings: ResidueFinding[] = [];
    const candidates = deps.candidates.filter(
        c => typeof c.coordinatorMessage === 'string' && c.coordinatorMessage.length >= RESIDUE_MIN_BODY_CHARS,
    );

    for (const session of deps.sessions) {
        if (session.status !== 'idle') continue;

        // Best match wins: prefer 'full' over 'partial', then the longest body
        // (a longer exact-present body subsumes a shorter one's probes).
        let best: { candidate: ResidueSweepCandidate; integrity: 'full' | 'partial' } | null = null;
        for (const candidate of candidates) {
            const verdict = matchCandidate(session, candidate.coordinatorMessage);
            if (!verdict) continue;
            if (
                !best
                || (verdict === 'full' && best.integrity === 'partial')
                || (verdict === best.integrity
                    && candidate.coordinatorMessage.length > best.candidate.coordinatorMessage.length)
            ) {
                best = { candidate, integrity: verdict };
            }
        }

        if (best) {
            const { candidate, integrity } = best;
            const recoverable = integrity === 'full';
            let recovered = false;
            if (recoverable && deps.autoRecoverEnabled && typeof session.submitComposer === 'function') {
                try {
                    session.submitComposer();
                    recovered = true;
                } catch (e: any) {
                    LOG.warn('ComposerResidue', `Recovery submit failed for session ${session.key}: ${e?.message || e}`);
                }
            }
            // WARN either way: an unsubmitted notification body in a composer is
            // the incident state and must be operator-visible. Content-free.
            LOG.warn(
                'ComposerResidue',
                `COMPOSER RESIDUE detected on idle session ${session.key} (${session.cliType}): matches drained ${candidate.event} `
                + `mesh=${candidate.meshId} eventId=${candidate.eventId ?? 'n/a'} taskId=${candidate.taskId ?? 'n/a'} `
                + `drainedAt=${new Date(candidate.drainedAt).toISOString()} bodyLen=${candidate.coordinatorMessage.length} integrity=${integrity}. `
                + (recovered
                    ? `Auto-recovery pressed Enter (${COMPOSER_RESIDUE_AUTOSUBMIT_ENV} enabled, full-body match).`
                    : recoverable
                        ? `NOT auto-submitted (default OFF — set ${COMPOSER_RESIDUE_AUTOSUBMIT_ENV}=1 to enable full-match recovery). The body remains in the composer.`
                        : 'NOT recoverable: the full body is NOT present (possible truncated write) — submitting would inject a corrupted message. Manual review required.'),
            );
            findings.push({
                sessionKey: session.key,
                cliType: session.cliType,
                kind: 'identified',
                candidate: {
                    meshId: candidate.meshId,
                    event: candidate.event,
                    eventId: candidate.eventId,
                    taskId: candidate.taskId,
                    drainedAt: candidate.drainedAt,
                    bodyLength: candidate.coordinatorMessage.length,
                },
                integrity,
                recovered,
            });
            continue;
        }

        // No ledger match — still surface obviously non-empty composers so
        // unexplained residue (e.g. a source this sweep does not model) has an
        // observation point. Content-free: length only.
        const residueLength = detectNonEmptyComposerTail(session.viewportText);
        if (residueLength > 0) {
            LOG.warn(
                'ComposerResidue',
                `Unidentified composer residue on idle session ${session.key} (${session.cliType}): ~${residueLength} chars on the composer line, `
                + 'matching no recently-drained notification. Origin unknown — left untouched.',
            );
            findings.push({
                sessionKey: session.key,
                cliType: session.cliType,
                kind: 'unidentified',
                recovered: false,
                residueLength,
            });
        }
    }
    return findings;
}

export interface ComposerResidueSweepHandle {
    stop(): void;
}

/** Minimal view of DaemonComponents the schedule needs (avoids an import cycle
 *  with daemon-lifecycle, which imports this module). */
interface SweepComponents {
    cliManager: { adapters: ReadonlyMap<string, CliAdapter> };
}

function readAutoRecoverEnabled(env: NodeJS.ProcessEnv): boolean {
    const v = (env[COMPOSER_RESIDUE_AUTOSUBMIT_ENV] ?? '').trim().toLowerCase();
    return v === '1' || v === 'true';
}

/** Builds sweep sessions from the live adapter map. Only adapters exposing the
 *  scrollback surface (the spec/FSM path) participate. */
function collectSweepSessions(components: SweepComponents): ResidueSweepSession[] {
    const sessions: ResidueSweepSession[] = [];
    for (const [key, adapter] of components.cliManager.adapters) {
        if (typeof adapter.getScrollbackText !== 'function') continue;
        let status: string | undefined;
        try { status = adapter.getStatus()?.status; } catch { status = undefined; }
        let viewportText = '';
        try { viewportText = adapter.getTerminalScreenSnapshot?.()?.text ?? ''; } catch { viewportText = ''; }
        let scrollbackText = '';
        try { scrollbackText = adapter.getScrollbackText() || viewportText; } catch { scrollbackText = viewportText; }
        sessions.push({
            key,
            cliType: adapter.cliType,
            status,
            viewportText,
            scrollbackText,
            ...(typeof adapter.writeRaw === 'function'
                ? { submitComposer: () => adapter.writeRaw!('\r') }
                : {}),
        });
    }
    return sessions;
}

/** Reads recently-drained notification bodies from the pending-event ledger. */
function collectSweepCandidates(now: number): ResidueSweepCandidate[] {
    let rows: ReturnType<MeshRuntimeStore['recentDrainedPendingEventPayloads']>;
    try {
        rows = MeshRuntimeStore.getInstance().recentDrainedPendingEventPayloads(now - RESIDUE_LOOKBACK_MS);
    } catch (e: any) {
        LOG.debug('ComposerResidue', `Ledger unavailable — sweep skipped: ${e?.message || e}`);
        return [];
    }
    const candidates: ResidueSweepCandidate[] = [];
    for (const row of rows) {
        const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;
        const coordinatorMessage = typeof payload.coordinatorMessage === 'string' ? payload.coordinatorMessage : '';
        if (coordinatorMessage.length < RESIDUE_MIN_BODY_CHARS) continue;
        const metadataEvent = (payload.metadataEvent && typeof payload.metadataEvent === 'object'
            ? payload.metadataEvent
            : {}) as Record<string, unknown>;
        candidates.push({
            rowId: row.id,
            meshId: row.meshId,
            event: row.event,
            eventId: typeof payload.eventId === 'string' ? payload.eventId : null,
            taskId: typeof metadataEvent.taskId === 'string' ? metadataEvent.taskId : null,
            drainedAt: row.drainedAt,
            coordinatorMessage,
        });
    }
    return candidates;
}

/**
 * Schedule the one-shot boot sweep. Called from initDaemonComponents; the
 * returned handle is stopped by shutdownDaemonComponents so a sweep can never
 * fire into a tearing-down daemon.
 */
export function scheduleComposerResidueSweep(
    components: SweepComponents,
    opts: { delayMs?: number; env?: NodeJS.ProcessEnv } = {},
): ComposerResidueSweepHandle {
    const env = opts.env ?? process.env;
    const delayMs = opts.delayMs ?? DEFAULT_SWEEP_DELAY_MS;
    const timer = setTimeout(() => {
        try {
            const now = Date.now();
            const candidates = collectSweepCandidates(now);
            const sessions = collectSweepSessions(components);
            if (sessions.length === 0) return;
            const findings = runComposerResidueSweep({
                sessions,
                candidates,
                autoRecoverEnabled: readAutoRecoverEnabled(env),
            });
            if (findings.length === 0) {
                LOG.debug('ComposerResidue', `Boot sweep clean: ${sessions.length} idle-checked session(s), ${candidates.length} drained candidate(s)`);
            }
        } catch (e: any) {
            LOG.warn('ComposerResidue', `Boot sweep failed: ${e?.message || e}`);
        }
    }, delayMs);
    timer.unref?.();
    return { stop: () => clearTimeout(timer) };
}
