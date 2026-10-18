/**
 * Bound on "generating only because a background-job marker is on screen".
 *
 * Specs for CLIs that keep running a job after the model's turn ends (agy,
 * claude, codex) hold the session in a generating state for as long as the
 * job's marker is drawn (`1 shell still running`, `N background terminal(s)
 * running`, `● [hh:mm:ss] … running`). A worker that deliberately leaves a dev
 * server or watcher up therefore never reaches an idle edge, no turn end is
 * ever observed, and the mesh turn-end backstop (which only runs AFTER a turn
 * end) never engages — the task sits assigned/generating until the 90-minute
 * hard ceiling and the session cannot take other work.
 *
 * This module is the generic, spec-declared half of the fix. A spec lists the
 * marker patterns once under `background_marker.patterns[]`; the driver then
 *
 *  1. SCANS each frame for them (`scan`) and keeps an episode identity — the
 *     set of matched marker texts. A different set is a different episode.
 *  2. PROBES, while generating with a marker on screen, whether the FSM would
 *     leave generating for idle if the marker text were blanked (`maskLines`).
 *     That reuses the spec's own notion of "no spinner / working indicator"
 *     (its `not <spinner>` guards), so there is no per-provider heuristic here.
 *     A modal or approval is not a probe hit — it moves the FSM elsewhere,
 *     which resets the clock. The spec's bounded busy→idle fallback arms ignore
 *     plain output, so "no new output" is checked separately and directly: the
 *     marker-blanked screen must be unchanged from the previous frame.
 *  3. COUNTS how long that has continuously held (`update`). Any frame where it
 *     does not — fresh output, a spinner, a modal — resets the counter.
 *  4. At `BACKGROUND_MARKER_NOTICE_MS` emits ONE coordinator notice for the
 *     episode; at `BACKGROUND_MARKER_RELEASE_MS` RELEASES: the driver evaluates
 *     the FSM on the masked frame from then on, so the ordinary busy→idle edge
 *     fires and the normal turn-end path (including the mesh background-work
 *     backstop) decides. The release is latched until the marker disappears or
 *     changes, so a stale dev-server marker cannot re-hold the next turn.
 *
 * Pure state + pure functions: the driver owns the clock and passes `now`.
 *
 * Thresholds mirror DEFAULT_BACKGROUND_WORK_TIMEOUT_MS / _RELEASE_MS in
 * mesh/turn-ledger/background-work-guard.ts. They are restated rather than
 * imported because `providers/**` may not value-import `mesh/**`
 * (scripts/check-import-boundaries.mjs). The two bounds are chained, not
 * summed: this one releases the screen hold, the mesh one then bounds the
 * turn-end hold with its own clock.
 */
'use strict';

import { LOG } from '../../logging/logger.js';
import { isBacktrackingSafeRegexSource } from '../../shared/regex-safety.js';
import type { ResolvedSection } from './evaluator.js';
import { sanitizeSignalParamValue, type SignalDetection } from './signal-rules.js';

/** Marker-only for this long ⇒ one coordinator notice (mesh: DEFAULT_BACKGROUND_WORK_TIMEOUT_MS). */
export const BACKGROUND_MARKER_NOTICE_MS = 120_000;
/** Marker-only for this long ⇒ treat the screen as idle (mesh: DEFAULT_BACKGROUND_WORK_RELEASE_MS). */
export const BACKGROUND_MARKER_RELEASE_MS = 600_000;
/** Re-probe interval while a marker is up but the probe has not (yet) said marker-only. */
export const BACKGROUND_MARKER_POLL_MS = 5_000;
/** Rule id carried by the notice's `signal_detected` event. */
export const BACKGROUND_MARKER_RULE_ID = 'background_marker_only';

const MAX_PATTERN_LENGTH = 300;
const MAX_PATTERNS = 8;
const ALLOWED_FLAGS = new Set(['i']);

/** One entry of the spec's `background_marker.patterns[]`. Matched PER LINE. */
export interface BackgroundMarkerPattern {
    regex: string;
    flags?: string;
    /** Restrict to this spec section's lines; omitted = every line of the frame. */
    section?: string;
}

/** The spec's `background_marker` block. */
export interface BackgroundMarkerDecl {
    patterns: BackgroundMarkerPattern[];
}

export interface CompiledMarker {
    re: RegExp;
    section?: string;
}

interface MarkerHit {
    line: number;
    start: number;
    end: number;
}

export interface MarkerScan {
    /** Sorted, de-duplicated matched texts; '' = no marker on screen. */
    signature: string;
    /** First matched text, whitespace-collapsed (for the notice). */
    sample: string;
    hits: MarkerHit[];
}

/**
 * Compile the declaration once per spec load. Invalid or backtracking-prone
 * patterns are dropped (fail-closed: no pattern ⇒ no bound ⇒ today's behaviour),
 * the same stance signal_rules take for untrusted channel-bundle specs.
 */
export function compileBackgroundMarkers(raw: unknown, specTag: string): CompiledMarker[] {
    if (raw === undefined || raw === null) return [];
    const patterns = (raw as { patterns?: unknown }).patterns;
    if (!Array.isArray(patterns)) {
        LOG.warn('FsmDriver', `[${specTag}] background_marker.patterns must be an array — bound disabled`);
        return [];
    }
    const out: CompiledMarker[] = [];
    for (const [i, p] of patterns.slice(0, MAX_PATTERNS).entries()) {
        const rec = (p && typeof p === 'object' ? p : {}) as Partial<BackgroundMarkerPattern>;
        const warn = (why: string) => LOG.warn('FsmDriver', `[${specTag}] background_marker.patterns[${i}] ${why} — pattern dropped`);
        if (typeof rec.regex !== 'string' || !rec.regex) { warn('has no regex'); continue; }
        if (rec.regex.length > MAX_PATTERN_LENGTH) { warn('is too long'); continue; }
        if (!isBacktrackingSafeRegexSource(rec.regex)) { warn('failed the backtracking screen'); continue; }
        const flags = typeof rec.flags === 'string' ? rec.flags : 'i';
        if ([...flags].some(f => !ALLOWED_FLAGS.has(f))) { warn(`has unsupported flags ${JSON.stringify(flags)}`); continue; }
        try {
            out.push({ re: new RegExp(rec.regex, `${flags}g`), ...(typeof rec.section === 'string' && rec.section ? { section: rec.section } : {}) });
        } catch {
            warn('does not compile');
        }
    }
    return out;
}

function collapse(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** Scan a frame. `sections` must be resolved from the SAME `lines`. */
export function scanBackgroundMarkers(markers: readonly CompiledMarker[], lines: readonly string[], sections: readonly ResolvedSection[]): MarkerScan {
    const hits: MarkerHit[] = [];
    const texts = new Set<string>();
    let sample = '';
    for (const m of markers) {
        let from = 0;
        let to = lines.length;
        if (m.section) {
            const sec = sections.find(s => s.id === m.section);
            if (!sec) continue; // section absent on this frame ⇒ the spec's own scoped guard would not match either
            from = Math.max(0, sec.fromLine);
            to = Math.min(lines.length, sec.toLine);
        }
        for (let i = from; i < to; i++) {
            const line = lines[i];
            m.re.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = m.re.exec(line)) !== null) {
                if (match[0].length === 0) { m.re.lastIndex++; continue; }
                hits.push({ line: i, start: match.index, end: match.index + match[0].length });
                const text = collapse(match[0]);
                texts.add(text);
                if (!sample) sample = text;
            }
        }
    }
    return { signature: [...texts].sort().join('\n'), sample, hits };
}

/** Blank every hit with spaces — line count, widths and cursor rows are preserved. */
export function maskLines(lines: readonly string[], scan: MarkerScan): string[] {
    const out = lines.slice();
    for (const h of scan.hits) {
        const line = out[h.line];
        out[h.line] = line.slice(0, h.start) + ' '.repeat(h.end - h.start) + line.slice(h.end);
    }
    return out;
}

/** A guard frame whose marker text is blanked (line count and cursor rows unchanged). */
export function maskGuard<G extends { screen: string; lines: string[] }>(guard: G, scan: MarkerScan): G {
    const lines = maskLines(guard.lines, scan);
    return { ...guard, lines, screen: lines.join('\n') };
}

export interface BackgroundMarkerUpdate {
    /** Set exactly once per episode, on the frame the notice threshold is crossed. */
    notice: SignalDetection | null;
    /** True on the frame the release latches. */
    released: boolean;
}

/** Per-session bound state. */
export class BackgroundMarkerBound {
    private signature = '';
    /** Marker-blanked screen of the previous frame, and whether this frame differs from it. */
    private prevMasked = '';
    private frameChanged = true;
    private markerOnlySince: number | null = null;
    private noticed = false;
    private latched = false;

    constructor(
        private readonly markers: readonly CompiledMarker[],
        private readonly noticeMs = BACKGROUND_MARKER_NOTICE_MS,
        private readonly releaseMs = Math.max(BACKGROUND_MARKER_RELEASE_MS, noticeMs),
    ) {}

    get enabled(): boolean { return this.markers.length > 0; }

    /** True once the hold has been released for the current marker episode. */
    get released(): boolean { return this.latched; }

    /** Scan a frame and track episode identity. A new/changed/vanished marker starts a fresh episode. */
    observe(lines: readonly string[], sections: readonly ResolvedSection[]): MarkerScan {
        const scan = scanBackgroundMarkers(this.markers, lines, sections);
        const masked = scan.signature === '' ? '' : maskLines(lines, scan).join('\n');
        this.frameChanged = masked !== this.prevMasked;
        this.prevMasked = masked;
        if (scan.signature !== this.signature) {
            this.signature = scan.signature;
            this.markerOnlySince = null;
            this.noticed = false;
            this.latched = false;
        }
        return scan;
    }

    /** The frame to evaluate: with the marker text blanked once the hold was released, else untouched. */
    frame<G extends { screen: string; lines: string[] }>(guard: G, scan: MarkerScan | null): G {
        return this.latched && scan ? maskGuard(guard, scan) : guard;
    }

    /** Read-only `frame` for debug surfaces: re-scans without touching episode state. */
    peekFrame<G extends { screen: string; lines: string[] }>(guard: G, sections: readonly ResolvedSection[]): G {
        return this.latched ? maskGuard(guard, scanBackgroundMarkers(this.markers, guard.lines, sections)) : guard;
    }

    /**
     * Fold one probe verdict in. `markerOnly` = generating, a marker is up, and
     * the FSM would be idle with the marker blanked; the frame must also be
     * unchanged apart from the marker. Any other frame resets the counter; the
     * notice stays spent for the episode and the latch is untouched.
     */
    update(now: number, markerOnly: boolean, sample: string): BackgroundMarkerUpdate {
        if (this.latched || this.signature === '') return { notice: null, released: false };
        if (!markerOnly || this.frameChanged) {
            this.markerOnlySince = null;
            return { notice: null, released: false };
        }
        this.markerOnlySince ??= now;
        const held = now - this.markerOnlySince;
        let notice: SignalDetection | null = null;
        if (!this.noticed && held >= this.noticeMs) {
            this.noticed = true;
            notice = {
                ruleId: BACKGROUND_MARKER_RULE_ID,
                kind: 'background_hold',
                params: {
                    held_s: String(Math.round(held / 1000)),
                    release_s: String(Math.round(this.releaseMs / 1000)),
                    marker: sanitizeSignalParamValue(sample),
                },
                detectedAt: now,
            };
        }
        if (held >= this.releaseMs) {
            this.latched = true;
            return { notice, released: true };
        }
        return { notice, released: false };
    }

    /** Ms until the driver must re-evaluate with no new PTY frame; null = nothing pending. */
    nextWakeMs(now: number): number | null {
        if (this.latched || this.signature === '') return null;
        if (this.markerOnlySince === null) return BACKGROUND_MARKER_POLL_MS;
        const held = now - this.markerOnlySince;
        const next = this.noticed ? this.releaseMs : this.noticeMs;
        return Math.max(50, next - held);
    }
}
