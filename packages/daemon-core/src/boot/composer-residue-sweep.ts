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
 * Behaviour:
 *  - DETECTION is always on: every residue finding is logged (content-free).
 *  - UNDRAIN RECOVERY (default ON, kill-switch ADHDEV_COMPOSER_RESIDUE_RECOVERY
 *    = '0'/'false') — the durable-undrain promotion of this sweep: for a
 *    full-integrity match whose ledger row was drained BEFORE this process
 *    booted, the sweep clears the composer (bounded backspaces) and flips the
 *    drained row back to drained=0 IN PLACE (the same undrain semantic as the
 *    strict-route hold / modal-park requeue — never a re-insert, so the UNIQUE
 *    fingerprint stays occupied and no duplicate row can exist). The normal
 *    redelivery path (reconcile drain → inject → echo-gated verified submit)
 *    then delivers the body into the now-clean composer. Guards, all required:
 *      (a) integrity === 'full' — a truncated body is NEVER recovered;
 *      (b) drainedAt < process boot — a row drained by THIS process is live
 *          delivery machinery, not residue, and is never touched;
 *      (c) two-pass stability — the sweep snapshots the viewport, waits
 *          STABILITY_CONFIRM_DELAY_MS, and recovers only when the session is
 *          still idle with an UNCHANGED viewport (an actively-typing user or
 *          an in-flight injection changes the screen and aborts recovery);
 *      (d) no in-flight submit on the adapter.
 *    Ordering is CLEAR → UNDRAIN: while the row is still drained=1 nothing can
 *    redeliver it (in-process or cross-process — the MCP pull drainer reads the
 *    same SQLite), so no drainer can inject into the still-dirty composer; once
 *    the undrain commits, any drainer that picks the row up finds the composer
 *    already cleared. The reverse order would let a cross-process drain race
 *    the clear and merge the redelivered body into the residue.
 *  - LEGACY AUTOSUBMIT (pressing Enter in place) remains the opt-in fallback
 *    (env ADHDEV_COMPOSER_RESIDUE_AUTOSUBMIT + integrity === 'full') and fires
 *    only when undrain recovery did not run for the finding. It never fires
 *    after a clear (an emptied composer has nothing to submit).
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
/** Two-pass stability window: the gap between the observe pass (viewport
 *  snapshot) and the recovery pass. A user actively typing into the composer —
 *  or a delivery mid-write — changes the viewport across this window and
 *  aborts recovery for that session. Overridable for tests. */
const DEFAULT_STABILITY_CONFIRM_DELAY_MS = 5_000;
/** Extra backspaces beyond the matched body length when clearing a composer.
 *  Backspace on an empty composer is a no-op everywhere, so overshoot is safe;
 *  the slack absorbs whitespace the normalized match cannot count exactly. */
const CLEAR_BACKSPACE_SLACK = 256;

export const COMPOSER_RESIDUE_AUTOSUBMIT_ENV = 'ADHDEV_COMPOSER_RESIDUE_AUTOSUBMIT';
/** Kill-switch for undrain recovery (default ON — set '0'/'false' to disable).
 *  Deliberately a separate axis from AUTOSUBMIT_ENV: autosubmit presses Enter
 *  on the residue in place (risking a merged/truncated turn — default OFF);
 *  undrain recovery clears the composer and rides the normal redelivery path
 *  (default ON). */
export const COMPOSER_RESIDUE_RECOVERY_ENV = 'ADHDEV_COMPOSER_RESIDUE_RECOVERY';

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
    /** Clears the composer by sending `count` backspaces (no-op past empty). */
    clearComposer?: (count: number) => void;
    /** True when the adapter reports a submit currently in flight — recovery
     *  must never clear a composer a live submit is using. */
    submitInFlight?: boolean;
    /** Two-pass stability verdict: true only when the integration layer
     *  re-sampled the viewport after STABILITY_CONFIRM_DELAY_MS and found it
     *  unchanged (and the session still idle). Recovery requires an explicit
     *  `true` — absent/false means unknown/unstable and blocks recovery only,
     *  never detection. */
    stable?: boolean;
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
    /** Legacy autosubmit (press Enter in place) — true only when
     *  COMPOSER_RESIDUE_AUTOSUBMIT_ENV opts in. See module doc. */
    autoRecoverEnabled: boolean;
    /** Undrain recovery (clear composer + return the drained row to the queue).
     *  Default ON at the integration layer; COMPOSER_RESIDUE_RECOVERY_ENV is
     *  the kill-switch. */
    recoveryEnabled?: boolean;
    /** Durable undrain of the candidate's ledger row (drained=1 → drained=0 in
     *  place). Returns true when the row was returned to the queue. */
    undrainRow?: (candidate: ResidueSweepCandidate) => boolean;
    /** Process boot wall-clock (ms). Rows drained AT/AFTER this instant were
     *  consumed by THIS process's live delivery machinery and are never
     *  recovery-eligible; residue is by definition a pre-boot drain. */
    bootAt?: number;
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
    /** True when this sweep took a recovery action for the finding. */
    recovered: boolean;
    /** Which recovery acted: 'undrain' = composer cleared + ledger row returned
     *  to the queue for normal redelivery; 'autosubmit' = legacy Enter press. */
    recoveredBy?: 'undrain' | 'autosubmit';
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
            let recoveredBy: 'undrain' | 'autosubmit' | undefined;
            let recoveryNote = '';

            // ── Undrain recovery (primary): clear the composer, then return the
            //    drained row to the queue for normal redelivery. Every guard from
            //    the module doc must hold; a failed guard degrades to detection
            //    (and possibly legacy autosubmit), never to a partial action.
            const preBootDrain = typeof deps.bootAt !== 'number' || candidate.drainedAt < deps.bootAt;
            const undrainEligible = recoverable
                && deps.recoveryEnabled === true
                && preBootDrain
                && session.stable === true
                && session.submitInFlight !== true
                && typeof session.clearComposer === 'function'
                && typeof deps.undrainRow === 'function';
            if (undrainEligible) {
                try {
                    // CLEAR FIRST: the row is still drained=1, so no drainer (in-
                    // process or cross-process) can redeliver it into the composer
                    // we are about to empty. Only after the clear does the undrain
                    // make the row visible to the delivery path again.
                    session.clearComposer!(candidate.coordinatorMessage.length + CLEAR_BACKSPACE_SLACK);
                    if (deps.undrainRow!(candidate)) {
                        recovered = true;
                        recoveredBy = 'undrain';
                    } else {
                        // Composer already cleared but the row did not flip (gone /
                        // already undrained / store error swallowed by the callback).
                        // The body still lives in the ledger row's payload — name the
                        // rowId so it is manually requeueable.
                        LOG.error(
                            'ComposerResidue',
                            `Undrain FAILED for row ${candidate.rowId} (mesh=${candidate.meshId}) after the composer was cleared — `
                            + 'the notification was NOT returned to the queue. Requeue it manually from the pending-event ledger.',
                        );
                        recoveryNote = ' Undrain recovery FAILED after clear — see error above.';
                    }
                } catch (e: any) {
                    LOG.error('ComposerResidue', `Undrain recovery failed for session ${session.key}: ${e?.message || e}`);
                    recoveryNote = ' Undrain recovery threw — see error above.';
                }
            } else if (recoverable && deps.recoveryEnabled === true && !preBootDrain) {
                // A post-boot drain is live delivery machinery, not residue.
                recoveryNote = ' Not undrained: row was drained after this process booted (live delivery, not residue).';
            } else if (recoverable && deps.recoveryEnabled === true && session.stable !== true) {
                recoveryNote = ' Not undrained: viewport not confirmed stable (possible active typing / in-flight write).';
            }

            // ── Legacy autosubmit (opt-in fallback): only when undrain recovery
            //    did not RUN for this finding — after a clear (even a failed
            //    undrain) the composer is empty and an Enter would submit nothing.
            const undrainRan = undrainEligible;
            if (!undrainRan && recoverable && deps.autoRecoverEnabled && typeof session.submitComposer === 'function') {
                try {
                    session.submitComposer();
                    recovered = true;
                    recoveredBy = 'autosubmit';
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
                + (recoveredBy === 'undrain'
                    ? 'Recovered: composer cleared and the drained row returned to the queue — normal redelivery will re-deliver it.'
                    : recoveredBy === 'autosubmit'
                        ? `Auto-recovery pressed Enter (${COMPOSER_RESIDUE_AUTOSUBMIT_ENV} enabled, full-body match).`
                        : recoverable
                            ? `NOT recovered.${recoveryNote || ` Undrain recovery inactive (set ${COMPOSER_RESIDUE_RECOVERY_ENV}=1/unset to enable) and autosubmit is opt-in (${COMPOSER_RESIDUE_AUTOSUBMIT_ENV}).`} The body remains in the composer.`
                            : 'NOT recoverable: the full body is NOT present (possible truncated write) — recovering would propagate a corrupted state. Manual review required.'),
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
                ...(recoveredBy ? { recoveredBy } : {}),
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

/** Undrain recovery is ON unless explicitly killed ('0'/'false'). */
function readRecoveryEnabled(env: NodeJS.ProcessEnv): boolean {
    const v = (env[COMPOSER_RESIDUE_RECOVERY_ENV] ?? '').trim().toLowerCase();
    return v !== '0' && v !== 'false';
}

/** Builds sweep sessions from the live adapter map. Only adapters exposing the
 *  scrollback surface (the spec/FSM path) participate. `priorViewports` is the
 *  observe-pass snapshot (key → viewport text): a session is `stable` only when
 *  its viewport is byte-identical across the two passes. */
function collectSweepSessions(
    components: SweepComponents,
    priorViewports?: ReadonlyMap<string, string>,
): ResidueSweepSession[] {
    const sessions: ResidueSweepSession[] = [];
    for (const [key, adapter] of components.cliManager.adapters) {
        if (typeof adapter.getScrollbackText !== 'function') continue;
        let status: string | undefined;
        try { status = adapter.getStatus()?.status; } catch { status = undefined; }
        let viewportText = '';
        try { viewportText = adapter.getTerminalScreenSnapshot?.()?.text ?? ''; } catch { viewportText = ''; }
        let scrollbackText = '';
        try { scrollbackText = adapter.getScrollbackText() || viewportText; } catch { scrollbackText = viewportText; }
        let submitInFlight = false;
        try { submitInFlight = adapter.hasInFlightSubmit?.() === true; } catch { submitInFlight = true; }
        sessions.push({
            key,
            cliType: adapter.cliType,
            status,
            viewportText,
            scrollbackText,
            submitInFlight,
            stable: priorViewports ? priorViewports.get(key) === viewportText : false,
            ...(typeof adapter.writeRaw === 'function'
                ? {
                    submitComposer: () => adapter.writeRaw!('\r'),
                    // \x7f (DEL/backspace) is a no-op past an empty composer in
                    // every shipped TUI, so overshoot is safe and the clear needs
                    // no per-provider keymap.
                    clearComposer: (count: number) => adapter.writeRaw!('\x7f'.repeat(Math.max(0, count))),
                }
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
 *
 * Two passes: at `delayMs` an OBSERVE pass snapshots each session's viewport
 * (no findings, no actions); `stabilityDelayMs` later the real sweep runs with
 * per-session `stable` = "viewport unchanged since the observe pass". Findings
 * are produced exactly once (by the second pass), so logging is not doubled.
 */
export function scheduleComposerResidueSweep(
    components: SweepComponents,
    opts: { delayMs?: number; stabilityDelayMs?: number; env?: NodeJS.ProcessEnv } = {},
): ComposerResidueSweepHandle {
    const env = opts.env ?? process.env;
    const delayMs = opts.delayMs ?? DEFAULT_SWEEP_DELAY_MS;
    const stabilityDelayMs = opts.stabilityDelayMs ?? DEFAULT_STABILITY_CONFIRM_DELAY_MS;
    // Captured at schedule time (initDaemonComponents = boot): ledger rows
    // drained at/after this instant belong to THIS process's live delivery.
    const bootAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const runSweepPass = (priorViewports: ReadonlyMap<string, string>): void => {
        try {
            const now = Date.now();
            const candidates = collectSweepCandidates(now);
            const sessions = collectSweepSessions(components, priorViewports);
            if (sessions.length === 0) return;
            const findings = runComposerResidueSweep({
                sessions,
                candidates,
                autoRecoverEnabled: readAutoRecoverEnabled(env),
                recoveryEnabled: readRecoveryEnabled(env),
                bootAt,
                undrainRow: (candidate) => {
                    try {
                        return MeshRuntimeStore.getInstance().requeueDrainedPendingEventById(candidate.rowId);
                    } catch (e: any) {
                        LOG.error('ComposerResidue', `Undrain store call failed for row ${candidate.rowId}: ${e?.message || e}`);
                        return false;
                    }
                },
            });
            if (findings.length === 0) {
                LOG.debug('ComposerResidue', `Boot sweep clean: ${sessions.length} idle-checked session(s), ${candidates.length} drained candidate(s)`);
            }
        } catch (e: any) {
            LOG.warn('ComposerResidue', `Boot sweep failed: ${e?.message || e}`);
        }
    };

    timer = setTimeout(() => {
        // Observe pass: viewport snapshots only.
        let priorViewports = new Map<string, string>();
        try {
            priorViewports = new Map(collectSweepSessions(components).map(s => [s.key, s.viewportText]));
        } catch { /* an empty prior map just means no session can be 'stable' */ }
        timer = setTimeout(() => { timer = null; runSweepPass(priorViewports); }, stabilityDelayMs);
        timer.unref?.();
    }, delayMs);
    timer.unref?.();
    return { stop: () => { if (timer) { clearTimeout(timer); timer = null; } } };
}
