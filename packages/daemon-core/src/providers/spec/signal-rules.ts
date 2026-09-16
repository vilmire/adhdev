/**
 * Spec-declared SIGNAL RULES — declarative screen-pattern extraction.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * A spec@4 CLI spec can declare `signal_rules[]`. Each rule names a pattern to
 * look for in the rendered terminal frame and the PARAMETERS to capture out of
 * it. When a rule matches, the driver emits a `signal_detected` event carrying
 * the rule id plus the captured parameters as a STRUCTURED map — never as a
 * sentence. The mesh layer turns that into a coordinator notification.
 *
 * The motivating example is a provider announcing a usage limit
 * ("You've hit your limit until 3:45pm"): the coordinator can only act on that
 * — reschedule, reassign the task to another node — if it receives the RESET
 * TIME as a field, not buried in prose it would have to parse.
 *
 * ★ WIRING ONLY. This module is the mechanism. The shipped rule catalogue is
 * deliberately near-empty: exactly one rule exists, in the claude-cli spec,
 * explicitly marked as an EXAMPLE. Real patterns must be written against a
 * measured corpus of provider output, which does not exist yet (mission
 * M-PTY-ERROR-CLASSIFICATION, owner decision (b)). Do not promote the example
 * to a production pattern by assuming its shape is right.
 *
 * ── Why a new declaration rather than an existing one ───────────────────────
 * Three existing spec constructs were considered and rejected:
 *  - `notifications[]` / `delegate[]` are keyed on `when_state` and carry no
 *    capture. They can say "a modal appeared", never "the limit resets at
 *    15:45". Extending them with captures would overload a state-keyed
 *    construct with a content-keyed one.
 *  - FSM `transitions[]` describe the machine's STATE. A usage limit is an
 *    out-of-band observation that must not silently become a state edge — a
 *    spec author adding a signal should not risk re-wiring idle/busy detection.
 *  - The `signal` leaf (signal-envelope.ts) is a fixed BOOLEAN vocabulary read
 *    FROM the native transcript INTO the FSM. This is the opposite direction
 *    (out of the screen, to the coordinator) and carries values, not booleans.
 * So signal_rules is additive and orthogonal: a spec that declares none behaves
 * exactly as before, and adding a signal type is a spec edit with NO engine
 * change — the flexibility requirement.
 *
 * ── Why regex, and how it is made safe ──────────────────────────────────────
 * Regex with NAMED CAPTURE GROUPS is the right tool here, but only because the
 * three classic objections are each answered by machinery that already exists
 * in this tree:
 *
 *  1. ANSI escapes / chunk-boundary truncation — NOT a concern at this layer.
 *     Rules run against `TerminalAdapter.snapshot()`, the output of a real VT
 *     emulator (cli-adapters/terminal-screen.ts). Escape sequences are already
 *     interpreted, and a sequence split across two PTY reads is reassembled by
 *     the emulator. We match rendered CELLS, never raw bytes. This is exactly
 *     why detection lives here and not on the raw `pty_data` chunk stream.
 *  2. Multi-line — handled by construction: rules are matched per LINE by
 *     default (`multiline: true` opts into whole-section matching). The repo
 *     has a live defect class from `^`/`$` silently spanning a whole frame
 *     because `m` was not set (see FSM spec `matches` — no `m` flag); rules
 *     therefore never inherit ambient flags, and `flags` is validated.
 *  3. ReDoS — a spec arrives from a published provider-channel bundle, not from
 *     hand-audited code, so the pattern is untrusted input applied to every
 *     rendered frame. Every source passes the SAME backtracking screen the mesh
 *     log-grep path uses (shared/regex-safety.ts), which exists because an
 *     unrestricted `(a+)+$` once stalled this daemon's event loop for ~59s. A
 *     rule that fails the screen is DROPPED at compile time with a warning —
 *     fail-closed: an unsafe rule yields no signal rather than a stalled daemon.
 *
 * Compilation happens ONCE per spec load, not per frame, so a malformed or
 * unsafe rule costs nothing at steady state.
 *
 * ── Untrusted-value discipline ──────────────────────────────────────────────
 * Captured text is agent/provider-authored and reaches a coordinator LLM. It is
 * therefore treated as hostile input throughout: every value is length-capped,
 * stripped of control characters and newlines, and delivered in a structured
 * `params` map. Rendering a signal into coordinator-facing prose is the mesh
 * layer's job and is done with a fixed template and quoted values — see
 * mesh/mesh-signal-bridge.ts. Nothing here ever concatenates a captured value
 * into an instruction.
 */
'use strict';

import { LOG } from '../../logging/logger.js';
import { isBacktrackingSafeRegexSource } from '../../shared/regex-safety.js';

/** Max length of a rule's regex source. Mirrors the mesh grep cap. */
export const MAX_SIGNAL_PATTERN_LENGTH = 200;
/** Max length of any single captured parameter value after sanitization. */
export const MAX_SIGNAL_PARAM_LENGTH = 120;
/** Max number of parameters carried by one signal. */
export const MAX_SIGNAL_PARAMS = 8;
/** Flags a rule may declare. `m`/`s`/`u` are rejected deliberately: `i` and `g`
 *  are the only ones whose meaning does not change how the rule's anchors bind
 *  to a line (see the multi-line note above; `g` is stripped before use). */
const ALLOWED_FLAGS = new Set(['i', 'g']);

/**
 * One declared rule. Lives in a spec under `signal_rules[]`.
 *
 * Keep this shape additive: adding a signal TYPE must remain a spec-only edit.
 */
export interface SignalRule {
    /** Stable identifier, e.g. "usage_limit". Reported verbatim to the
     *  coordinator, so it must be an enum-like token, never free text. */
    id: string;
    /**
     * Coarse classification the coordinator routes on. Kept deliberately small;
     * an unknown value is rejected at compile time so a typo cannot silently
     * produce an unroutable signal.
     */
    kind: SignalRuleKind;
    /** Named section to search (from the spec's `sections{}`). Omitted → the
     *  whole rendered frame. */
    section?: string;
    /** Regex source. Named capture groups become the emitted `params`. */
    pattern: string;
    /** Regex flags; only `i` and `g` are permitted. */
    flags?: string;
    /** Match against the whole section text rather than line-by-line. Default
     *  false (per-line) — see the multi-line note in the module header. */
    multiline?: boolean;
    /**
     * Minimum ms between two emissions of this rule for one session. Default
     * DEFAULT_SIGNAL_COOLDOWN_MS. A TUI repaints the same banner on every frame,
     * so without this a single limit notice would page the coordinator dozens of
     * times per second.
     */
    cooldown_ms?: number;
}

export type SignalRuleKind = 'usage_limit' | 'auth_error' | 'rate_limit' | 'service_error' | 'info';

const SIGNAL_RULE_KINDS: ReadonlySet<string> = new Set<SignalRuleKind>([
    'usage_limit', 'auth_error', 'rate_limit', 'service_error', 'info',
]);

/** Default re-emit cooldown. Generous: these signals are advisory, not real-time. */
export const DEFAULT_SIGNAL_COOLDOWN_MS = 60_000;

/** A rule that passed validation and compiled to a safe regex. */
export interface CompiledSignalRule {
    id: string;
    kind: SignalRuleKind;
    section?: string;
    multiline: boolean;
    cooldownMs: number;
    regex: RegExp;
}

/** A rule match, ready to publish. `params` is structured — never a sentence. */
export interface SignalDetection {
    ruleId: string;
    kind: SignalRuleKind;
    /** Named-capture values, sanitized and capped. May be empty (a rule can be
     *  a pure presence signal with no captures). */
    params: Record<string, string>;
    /** Wall-clock ms the frame was evaluated. */
    detectedAt: number;
}

/**
 * Strip a captured value down to something safe to hand a coordinator.
 *
 * Control characters (including newline) are removed rather than escaped: the
 * value lands inside a quoted field in a coordinator message, and a newline is
 * the one character that could let a captured value break out of that framing
 * and read as a separate instruction line. Length is capped so a rule whose
 * pattern over-captures cannot flood the coordinator's context.
 */
export function sanitizeSignalParamValue(raw: string): string {
    // eslint-disable-next-line no-control-regex
    const stripped = String(raw).replace(/[\x00-\x1f\x7f]/g, ' ').trim().replace(/\s{2,}/g, ' ');
    return stripped.length > MAX_SIGNAL_PARAM_LENGTH
        ? stripped.slice(0, MAX_SIGNAL_PARAM_LENGTH)
        : stripped;
}

function isValidRuleId(id: unknown): id is string {
    return typeof id === 'string' && /^[a-z0-9][a-z0-9_]{0,63}$/.test(id);
}

/**
 * ★ EXAMPLE RULE — NOT A PRODUCTION PATTERN. ★
 *
 * The shape a spec author copies to declare their first signal, and the fixture
 * the wiring tests exercise. It is exported (rather than written into a shipped
 * provider spec) on purpose: no published spec declares `signal_rules` yet,
 * because the real patterns must be written against a MEASURED CORPUS of
 * provider output that does not exist yet — mission M-PTY-ERROR-CLASSIFICATION,
 * owner decision (b), which explicitly stopped at the pattern-authoring step.
 *
 * Concretely, this pattern is a guess in at least three ways: real CLIs vary the
 * wording ("usage limit reached", "quota exceeded"), the time format (12h/24h,
 * with or without a zone), and whether a date accompanies the time. Shipping it
 * into a provider bundle would freeze those guesses into a published artifact
 * and a channel digest. Promote a rule to a spec only after observing the real
 * output it must match.
 *
 * To declare one, add to the spec:
 *
 *   "signal_rules": [{
 *     "id": "usage_limit",
 *     "kind": "usage_limit",
 *     "section": "body",
 *     "pattern": "hit your limit until (?<resetsAt>[0-9]{1,2}:[0-9]{2}\\s*[apAP]?[mM]?)",
 *     "flags": "i"
 *   }]
 *
 * Each named capture group becomes one entry in the emitted `params` map, so the
 * coordinator receives `{ resetsAt: "3:45pm" }` as data — never as prose.
 */
export const EXAMPLE_USAGE_LIMIT_RULE: SignalRule = {
    id: 'usage_limit',
    kind: 'usage_limit',
    pattern: 'hit your limit until (?<resetsAt>[0-9]{1,2}:[0-9]{2}\\s*[apAP]?[mM]?)',
    flags: 'i',
};

/**
 * Validate + compile the spec's declared rules. Invalid or unsafe rules are
 * dropped with a warning; the surviving rules are returned. Called once per
 * spec load.
 *
 * Fail-closed by design: every rejection path drops the rule rather than
 * falling back to a looser match. A signal is advisory, so losing one is
 * strictly better than compiling a pattern that can stall the event loop or
 * emit an unroutable kind.
 */
export function compileSignalRules(raw: unknown, specTag: string): CompiledSignalRule[] {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const compiled: CompiledSignalRule[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
        const rule = entry as Partial<SignalRule> | null;
        const warn = (why: string) => LOG.warn(
            'SignalRules',
            `[${specTag}] dropped signal rule ${JSON.stringify(rule?.id ?? '(no id)')}: ${why}`,
        );
        if (!rule || typeof rule !== 'object') { warn('not an object'); continue; }
        if (!isValidRuleId(rule.id)) { warn('id must match /^[a-z0-9][a-z0-9_]{0,63}$/'); continue; }
        if (seen.has(rule.id)) { warn('duplicate id'); continue; }
        if (!SIGNAL_RULE_KINDS.has(rule.kind as string)) {
            warn(`unknown kind ${JSON.stringify(rule.kind)}`); continue;
        }
        if (typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
            warn('pattern must be a non-empty string'); continue;
        }
        if (rule.pattern.length > MAX_SIGNAL_PATTERN_LENGTH) {
            warn(`pattern longer than ${MAX_SIGNAL_PATTERN_LENGTH} chars`); continue;
        }
        // ReDoS: the same screen the mesh log-grep path uses. A spec is a
        // published artifact, not audited source — treat its pattern as hostile.
        if (!isBacktrackingSafeRegexSource(rule.pattern)) {
            warn('pattern rejected by the backtracking-safety screen (see shared/regex-safety.ts)');
            continue;
        }
        const declaredFlags = typeof rule.flags === 'string' ? rule.flags : '';
        const badFlag = [...declaredFlags].find(f => !ALLOWED_FLAGS.has(f));
        if (badFlag !== undefined) {
            warn(`flag ${JSON.stringify(badFlag)} not permitted (only 'i' and 'g')`); continue;
        }
        // `g` is meaningless for us (we take the first match) and carries
        // lastIndex state across calls, which would make a shared RegExp emit
        // intermittently. Strip it rather than reject the rule.
        const flags = declaredFlags.replace(/g/g, '');

        let regex: RegExp;
        try {
            regex = new RegExp(rule.pattern, flags);
        } catch (e: any) {
            warn(`pattern failed to compile: ${e?.message || e}`); continue;
        }

        seen.add(rule.id);
        compiled.push({
            id: rule.id,
            kind: rule.kind as SignalRuleKind,
            ...(typeof rule.section === 'string' && rule.section ? { section: rule.section } : {}),
            multiline: rule.multiline === true,
            cooldownMs: typeof rule.cooldown_ms === 'number' && Number.isFinite(rule.cooldown_ms) && rule.cooldown_ms >= 0
                ? rule.cooldown_ms
                : DEFAULT_SIGNAL_COOLDOWN_MS,
            regex,
        });
    }
    return compiled;
}

/**
 * Run one compiled rule against the text it was scoped to. Returns the captured
 * params, or null when the rule does not match.
 *
 * Per-line by default: each line is tested independently, so `^`/`$` bind to the
 * line the author was looking at rather than to the whole frame. This is the
 * documented failure mode of the FSM `matches` leaf (no `m` flag) and is avoided
 * here structurally instead of by asking spec authors to remember a flag.
 */
export function matchSignalRule(rule: CompiledSignalRule, text: string): Record<string, string> | null {
    const candidates = rule.multiline ? [text] : text.split('\n');
    for (const candidate of candidates) {
        const m = rule.regex.exec(candidate);
        if (!m) continue;
        const params: Record<string, string> = {};
        const groups = m.groups ?? {};
        for (const [key, value] of Object.entries(groups)) {
            if (value === undefined) continue;
            if (Object.keys(params).length >= MAX_SIGNAL_PARAMS) break;
            const clean = sanitizeSignalParamValue(value);
            if (clean) params[key] = clean;
        }
        return params;
    }
    return null;
}

/**
 * Per-session emission gate. A TUI repaints the same banner every frame, so the
 * same rule matches continuously; this collapses that to one emission per
 * cooldown window. Also suppresses a re-emit when the captured params are
 * IDENTICAL to the last emission, so a persistent banner stays quiet even after
 * its cooldown lapses, while a CHANGED value (a new reset time) pages again.
 */
export class SignalEmissionGate {
    private readonly last = new Map<string, { at: number; fingerprint: string }>();

    shouldEmit(rule: CompiledSignalRule, params: Record<string, string>, now: number): boolean {
        const fingerprint = JSON.stringify(Object.entries(params).sort());
        const prev = this.last.get(rule.id);
        if (prev && prev.fingerprint === fingerprint && now - prev.at < rule.cooldownMs) return false;
        if (prev && prev.fingerprint === fingerprint) {
            // Same content, cooldown lapsed: refresh the clock but stay silent.
            // A banner that never changes is not news.
            this.last.set(rule.id, { at: now, fingerprint });
            return false;
        }
        this.last.set(rule.id, { at: now, fingerprint });
        return true;
    }

    reset(): void { this.last.clear(); }
}

/**
 * Evaluate every rule against the frame and return the detections that pass the
 * emission gate. `sectionText` resolves a named section for the current frame;
 * a rule naming a section that does not resolve is skipped (not an error — the
 * section may simply be absent from this frame).
 */
export function evaluateSignalRules(
    rules: readonly CompiledSignalRule[],
    fullScreen: string,
    sectionText: (id: string) => string | null,
    gate: SignalEmissionGate,
    now: number,
): SignalDetection[] {
    if (rules.length === 0) return [];
    const out: SignalDetection[] = [];
    for (const rule of rules) {
        let text: string | null = fullScreen;
        if (rule.section) text = sectionText(rule.section);
        if (!text) continue;
        const params = matchSignalRule(rule, text);
        if (!params) continue;
        if (!gate.shouldEmit(rule, params, now)) continue;
        out.push({ ruleId: rule.id, kind: rule.kind, params, detectedAt: now });
    }
    return out;
}
