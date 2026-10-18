/**
 * injected-text — recognise text the daemon typed into a session's PTY.
 *
 * A PTY-hosted agent records everything that reaches its input as a USER turn,
 * so daemon-authored input (mesh `[System]` events, assistant relays and
 * one-line project notices, the idle review prompt) arrives in the transcript
 * looking like the owner talking. This table is the one place that tells them
 * apart. Detection is decided by the FIRST line only; a new injected format is
 * one more row in `INJECTED_HEADERS` (design 2026-10-07-chat-row-model.md §2.2).
 *
 * Formats mirrored (daemon-core, read-only from here — web-core must not take a
 * value dependency on it):
 *  - `[System] …`                                   mesh event formatters
 *  - `[ADHDev relay · project <slug> · <outcome>]` … `[/relay]`
 *                                                   assistant/assistant-relay-format.ts
 *  - `[project <slug>] …`                           same file, one-line signals
 *  - `[ADHDev review] …`                            assistant/assistant-review.ts
 *  - `[ADHDev <words>] …`                          any other daemon notice to the
 *                                                   assistant (restart, first run,
 *                                                   relay gap, report references, …)
 *
 * Claude Code records a long pasted input inside a `<pasted_content id="…">`
 * envelope. The daemon's deliveries are long, so the envelope is unwrapped
 * before the first line is read (`unwrapPastedEnvelope`).
 *
 * One delivered input can combine several of these: the relay joins every ready
 * part with a blank line (`parts.join('\n\n')`), so a single user turn may hold
 * two relays and a signal. `parseInjectedDelivery` splits it back into segments.
 *
 * Pure: no React, no i18n.
 */

export type InjectedSource = 'system' | 'relay' | 'signal' | 'review' | 'notice';

export interface InjectedSegment {
    source: InjectedSource | 'text';
    /** Relay / signal project slug. */
    project?: string;
    /** Relay turn outcome (`completed` | `failed` | `cancelled` | …). */
    outcome?: string;
    /** Relay: the thread closed with this relay (`[idle]` marker). */
    idle?: boolean;
    /** Notice: the header words, e.g. `relay gap` for `[ADHDev relay gap]`. */
    noticeKind?: string;
    /** Relay: the coordinator's report did not come through (only references). */
    reportMissing?: boolean;
    /** Relay: the report may be cut short (native transcript not captured). */
    reportTruncated?: boolean;
    /** One-line summary shown while collapsed / in a chip. */
    preview: string;
    /** Display body — the envelope lines (header, disclaimer, markers, close) removed. */
    body: string;
}

export interface InjectedDetection {
    /** Source of the first segment — what decided the row is injected. */
    source: InjectedSource;
    segments: InjectedSegment[];
}

/** Mesh events typed into a coordinator's PTY. Whole-text test, as before. */
const SYSTEM_RE = /^\s*\[System\]\s/;
const RELAY_HEADER_RE = /^\s*\[ADHDev relay · project (\S+) · (\w+)\]\s*$/;
const RELAY_CLOSE_RE = /^\s*\[\/relay\]\s*$/;
const RELAY_DISCLAIMER_RE = /^Untrusted agent output from the \S+ project follows\./;
const RELAY_IDLE_RE = /^\s*\[idle\]\s*$/;
/** Daemon bookkeeping inside a relay for the assistant (report references, capture warnings). */
const RELAY_REFERENCES_RE = /^\s*\[ADHDev report references\]/;
const RELAY_UNAVAILABLE_RE = /^\s*\[ADHDev original report unavailable\]/;
const RELAY_TRUNCATED_RE = /^\s*\[ADHDev relay\] This report may be truncated/;
const RELAY_NO_BODY_RE = /^\s*\(no coordinator message found — use project_read\)\s*$/;

interface HeaderRule {
    source: Exclude<InjectedSource, 'system'>;
    re: RegExp;
}

/**
 * First-line headers of PTY-injected formats other than `[System]` (which keeps
 * its whole-text test). Order matters only where patterns could overlap; they
 * do not today.
 */
const INJECTED_HEADERS: readonly HeaderRule[] = [
    { source: 'relay', re: RELAY_HEADER_RE },
    { source: 'signal', re: /^\s*\[project ([^\]\s]+)\]\s+(.*)$/ },
    { source: 'review', re: /^\s*\[ADHDev review\]\s+(.*)$/ },
    // Any other `[ADHDev <lowercase words>]` header. The relay header carries
    // ` · ` and never matches this character class; review is matched above.
    { source: 'notice', re: /^\s*\[ADHDev ([a-z][a-z ]*)\]\s+(.*)$/ },
];

const PREVIEW_MAX_CHARS = 160;

const PASTED_OPEN_RE = /^\s*<pasted_content(?:\s+id="[^"]*")?\s*>\s*$/;
const PASTED_CLOSE_RE = /^\s*<\/pasted_content(?:\s+id="[^"]*")?\s*>\s*$/;

/**
 * Drop the `<pasted_content>` envelope lines Claude Code wraps around a pasted
 * input. Only a text that OPENS with the envelope is touched; anything else is
 * returned unchanged.
 */
export function unwrapPastedEnvelope(text: string): string {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const first = lines.findIndex((line) => line.trim());
    if (first < 0 || !PASTED_OPEN_RE.test(lines[first])) return text;
    return lines.filter((line) => !PASTED_OPEN_RE.test(line) && !PASTED_CLOSE_RE.test(line)).join('\n');
}

export function isMeshInjectedSystemText(text: string): boolean {
    return SYSTEM_RE.test(text);
}

function matchHeader(line: string): { rule: HeaderRule; match: RegExpExecArray } | null {
    for (const rule of INJECTED_HEADERS) {
        const match = rule.re.exec(line);
        if (match) return { rule, match };
    }
    return null;
}

function firstNonEmptyLine(text: string): string {
    for (const line of text.split('\n')) {
        if (line.trim()) return line;
    }
    return '';
}

function clip(text: string): string {
    const line = text.trim();
    return line.length > PREVIEW_MAX_CHARS ? `${line.slice(0, PREVIEW_MAX_CHARS - 1)}…` : line;
}

function trimBlankEdges(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && !lines[start].trim()) start++;
    while (end > start && !lines[end - 1].trim()) end--;
    return lines.slice(start, end);
}

function buildRelaySegment(project: string, outcome: string, inner: string[]): InjectedSegment {
    let idle = false;
    let reportMissing = false;
    let reportTruncated = false;
    const kept = inner.filter((line) => {
        if (RELAY_DISCLAIMER_RE.test(line.trim())) return false;
        if (RELAY_IDLE_RE.test(line)) { idle = true; return false; }
        // Lines the daemon writes for the assistant, not the owner (2026-10-18:
        // the card's preview showed a raw "[ADHDev report references] {…}").
        if (RELAY_REFERENCES_RE.test(line)) return false;
        if (RELAY_UNAVAILABLE_RE.test(line) || RELAY_NO_BODY_RE.test(line)) { reportMissing = true; return false; }
        if (RELAY_TRUNCATED_RE.test(line)) { reportTruncated = true; return false; }
        return true;
    });
    const body = trimBlankEdges(kept).join('\n');
    return {
        source: 'relay', project, outcome, idle, preview: clip(firstNonEmptyLine(body)), body,
        ...(reportMissing ? { reportMissing } : {}),
        ...(reportTruncated ? { reportTruncated } : {}),
    };
}

/**
 * Split a delivered input into its segments. Relays run to their own
 * `[/relay]` line (or to the end when the close is missing — a truncated
 * transcript); one-line notices run to the next blank line; anything else
 * becomes a plain `text` segment so nothing the agent received is hidden.
 */
export function parseInjectedDelivery(text: string): InjectedSegment[] {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const segments: InjectedSegment[] = [];
    let loose: string[] = [];
    const flushLoose = () => {
        const kept = trimBlankEdges(loose);
        loose = [];
        if (!kept.length) return;
        const body = kept.join('\n');
        segments.push({ source: 'text', preview: clip(firstNonEmptyLine(body)), body });
    };

    let i = 0;
    while (i < lines.length) {
        const header = matchHeader(lines[i]);
        if (!header) {
            loose.push(lines[i]);
            i++;
            continue;
        }
        flushLoose();
        if (header.rule.source === 'relay') {
            const inner: string[] = [];
            i++;
            while (i < lines.length && !RELAY_CLOSE_RE.test(lines[i])) inner.push(lines[i++]);
            i++; // the close line (or past the end)
            segments.push(buildRelaySegment(header.match[1], header.match[2], inner));
            continue;
        }
        const bodyGroup = header.rule.source === 'signal' || header.rule.source === 'notice' ? 2 : 1;
        const chip: string[] = [header.match[bodyGroup] ?? ''];
        i++;
        while (i < lines.length && lines[i].trim() && !matchHeader(lines[i])) chip.push(lines[i++]);
        const body = chip.join('\n').trim();
        segments.push({
            source: header.rule.source,
            ...(header.rule.source === 'signal' ? { project: header.match[1] } : {}),
            ...(header.rule.source === 'notice' ? { noticeKind: header.match[1] } : {}),
            preview: clip(firstNonEmptyLine(body)),
            body,
        });
    }
    flushLoose();
    return segments;
}

/**
 * Whether a user-role text is daemon-injected, and how to show it. Only the
 * first line decides; a message that merely mentions a marker later on is the
 * owner's own words and stays a user bubble.
 */
export function detectInjectedText(raw: string): InjectedDetection | null {
    if (!raw) return null;
    const text = unwrapPastedEnvelope(raw);
    if (SYSTEM_RE.test(text)) {
        return { source: 'system', segments: [{ source: 'system', preview: clip(firstNonEmptyLine(text)), body: text }] };
    }
    const header = matchHeader(firstNonEmptyLine(text));
    if (!header) return null;
    return { source: header.rule.source, segments: parseInjectedDelivery(text) };
}
