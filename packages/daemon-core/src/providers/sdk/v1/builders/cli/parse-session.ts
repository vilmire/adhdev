/**
 * buildParseSessionFromTui — synthesize a parseSession function from the
 * manifest tui block alone.
 *
 * Composition:
 *   1. detectStatus from tui.spinner/modal/settledPrompt/dispatchOrder
 *      (delegated to buildDetectStatusFromTui)
 *   2. parseApproval from tui.modal (delegated to buildParseApprovalFromTui)
 *   3. message extraction from tui.transcriptPty (this file)
 *
 * The result has the same shape as the legacy parse_output:
 *   { status, messages, activeModal, transcriptAuthority?, coverage?, providerSessionId? }
 *
 * Identity stamping (providerUnitKey, bubbleId, sequence, bubbleState) is
 * applied by the caller, mirroring _shared/parse_session.js. We export the
 * stamper as `normalizeMessageIdentity` for reuse.
 */

import { buildDetectStatusFromTui, type DetectStatusTuiSpec } from './detect-status.js'
import { buildParseApprovalFromTui, type ModalTuiSpec } from './parse-approval.js'
import * as crypto from 'node:crypto'

// ─── Schema types ────────────────────────────────

export interface PrefixSpec {
    regex: string
    flags?: string
}

export interface ToolPrefixSpec extends PrefixSpec {
    skip?: boolean
}

export interface ChromePatternSpec {
    regex: string
    flags?: string
    label?: string
}

export interface TranscriptPtySpec {
    $schema?: 'adhdev:tui/transcript-pty@1'
    assistantPrefix: PrefixSpec
    userPrefix?: PrefixSpec
    toolPrefix?: ToolPrefixSpec
    continuationLine?: { indented?: boolean }
    chromePatterns?: ChromePatternSpec[]
    stripLeadingChrome?: boolean
    scope?: 'screen' | 'buffer' | 'tail'
    /**
     * Optional SGR background-color codes that mark a USER turn. Some TUIs
     * (cursor-agent) render the user's submitted message and the composer echo
     * inside a colored box but render the assistant answer as a plain line with
     * no background. After ANSI stripping both look like bare 2-space lines, so
     * a bg-less assistant answer and a boxed user echo are indistinguishable by
     * text prefix alone — the user echo then leaks into an assistant bubble.
     * When set, a raw line whose ANSI carries any of these background SGRs (e.g.
     * "48;5;233") is classified as a user turn regardless of its stripped text,
     * so the plain assistant answer is the only assistant bubble left. Matched
     * against the raw pre-strip line; the visible text is still ANSI-stripped
     * for the bubble content.
     *
     * Value-agnostic mode: the sentinel "*" (or "48;*" / "bg") matches ANY
     * background-color SGR — 256-color `48;5;<n>` OR truecolor `48;2;<r>;<g>;<b>`
     * — instead of an allowlist of exact color numbers. This is the robust form:
     * the earlier allowlist bug recurred every time a TUI changed its exact box
     * color (cursor `48;5;233` guess, opencode rc.531), because a hard-coded
     * color that no longer matched let the boxed user echo fall through to the
     * permissive assistantPrefix. The sentinel keys off the *presence* of a
     * background-color param group — the structural signal of a boxed turn —
     * so a genuine assistant line (no background SGR) is still classified
     * assistant. Chrome patterns are filtered BEFORE this check, so bg-colored
     * chrome (e.g. the "→ Add a follow-up" composer footer) is already excluded
     * and does not become a spurious user bubble.
     */
    userBackgroundSgr?: string[]
}

export interface SessionIdExtractionSpec {
    $schema?: 'adhdev:tui/session-id-extraction@1'
    regex: string
    flags?: string
    scope?: 'screen' | 'tail' | 'buffer'
    label?: string
}

export interface ParseSessionTuiSpec {
    spinner?: any
    settledPrompt?: any
    modal?: ModalTuiSpec
    dispatchOrder?: any
    transcriptPty: TranscriptPtySpec
    sessionIdExtraction?: SessionIdExtractionSpec
}

// ─── Output shape ────────────────────────────────

export interface SynthesizedMessage {
    role: 'user' | 'assistant'
    kind?: 'standard' | 'tool'
    content: string
    receivedAt?: number
}

export interface SynthesizedSession {
    status: string | null
    messages: SynthesizedMessage[]
    activeModal: { message: string; buttons: string[] } | null
    modal: { message: string; buttons: string[] } | null
    parsedStatus: string | null
    transcriptAuthority?: 'provider' | 'daemon'
    coverage?: 'full' | 'tail' | 'current-turn'
    providerSessionId?: string
}

// ─── ANSI / line helpers ─────────────────────────

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g
const FWD_RE = /\x1b\[(\d*)C/g
// eslint-disable-next-line no-control-regex
const LINE_CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g
const TRAILING_WS_RE = /\s+$/
const BACK_RE = /\x1b\[\d*D/g
// The three non-`ESC[` families fuse into one pass -- all delete-only, all
// matching disjoint prefixes that the CSI rules cannot reach.
const NON_CSI_RE = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\|(?=\n|$))|\x1b[P^_X][\s\S]*?(?:\x07|\x1b\\)|\x1b(?:[@-Z\\-_])/g

/**
 * Strip ANSI escapes, rendering cursor-forward as spaces.
 *
 * Byte-for-byte identical to the previous six-pass chain. Three things keep it
 * that way, each of which a fuzz corpus caught when violated:
 *
 *  1. The `ESC[`-family passes (forward / back / generic CSI) must stay
 *     separate and ordered. Sequential passes each restart their scan, so
 *     deleting an `ESC[<n>D` can leave an earlier dangling `ESC[` adjacent to
 *     new text for the later CSI pass to consume. A fused alternation advances
 *     past that index and never returns:
 *       "x<ESC>[<ESC>[2Db"  ->  sequential "x"   fused "x<ESC>[b"
 *  2. Only the non-`ESC[` families are fused, and they run last, matching the
 *     original relative order.
 *  3. The cursor-forward pass is the one SUBSTITUTING pass, so it needs a
 *     replacer callback. Measured: making the whole thing one alternation with
 *     a callback is ~60% SLOWER than the original six passes -- a function
 *     replacer defeats V8's fast path for `replace(re, '')`. Hence the callback
 *     pass is isolated and guarded by indexOf so it is skipped entirely when no
 *     'C' is present, which is the overwhelmingly common case.
 */
// `stripAnsi` and `splitRawLines` are exported for the equivalence regression
// suite (test/cli/strip-ansi-equivalence.test.ts), which diffs them against
// frozen copies of the original pass chains. Not part of the public surface.
export function stripAnsi(text: string): string {
    const s = String(text || '')
    if (s.indexOf('\x1b') === -1) return s
    const fwd = s.indexOf('C') === -1
        ? s
        : s.replace(FWD_RE, (_m, n) => ' '.repeat(Math.max(1, Number(n) || 1)))
    const back = fwd.indexOf('D') === -1 ? fwd : fwd.replace(BACK_RE, '')
    return back.replace(ANSI_RE, '').replace(NON_CSI_RE, '')
}

function splitLines(text: string): string[] {
    return stripAnsi(text)
        .replace(//g, '')
        .split(/\r?\n/)
        .map(l => l.replace(/\s+$/, ''))
}

/**
 * Split into raw (pre-strip) lines paired with their stripped visible text so
 * per-line ANSI (e.g. a user-turn background SGR) can be inspected before the
 * color is discarded. The stripped column matches splitLines() line for line:
 * same newline split, same trailing-space trim — only the ANSI is retained on
 * the `raw` side. Splitting on newline keeps any leading SGR of a line attached
 * to that line (cursor-agent writes `<bg-sgr> <text>` on one raw line), so a
 * per-line background test is exact.
 */
export function splitRawLines(text: string): Array<{ raw: string; text: string }> {
    const parts = String(text || '').split(/\r?\n/)
    const out: Array<{ raw: string; text: string }> = new Array(parts.length)
    for (let i = 0; i < parts.length; i += 1) {
        const raw = parts[i]
        let visible = stripAnsi(raw)
        // NOTE the control-strip and the trailing-trim must stay two ORDERED
        // passes -- they chain. Removing a trailing control char exposes
        // whitespace that the trim must then take:
        //   "incomplete <ESC>"  ->  "incomplete", not "incomplete ".
        // A fused /[ctrl]|\s+$/ gets this wrong, because the space is not at
        // end-of-string at the moment the trim alternative is tested.
        if (visible.length !== 0) visible = visible.replace(LINE_CTRL_RE, '').replace(TRAILING_WS_RE, '')
        out[i] = { raw, text: visible }
    }
    return out
}

function pickInputText(input: any, scope: TranscriptPtySpec['scope']): string {
    if (!input) return ''
    if (scope === 'screen') return String(input.screenText || input.screen?.text || '')
    if (scope === 'tail') return String(input.tail || input.recentBuffer || input.buffer || '')
    return String(input.buffer || input.rawBuffer || input.screenText || '')
}

// ─── Identity stamping (mirrors _shared/parse_session.js) ─────

function stableHash(value: string): string {
    return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12)
}

export function normalizeMessageIdentity<T extends { role?: string; kind?: string; content?: string }>(
    messages: T[],
    status: string,
): Array<T & {
    providerUnitKey: string
    bubbleId: string
    sequence: number
    _turnKey: string
    bubbleState: 'streaming' | 'final'
}> {
    const list = Array.isArray(messages) ? messages : []
    let turnIndex = -1
    // (CHAT-FLAP-LONG-CONVO root fix) The PTY-parsed providerUnitKey must be
    // position-independent for the same reason as the native-history path: the
    // transcript is re-parsed on every read, so a `index`-embedded key changes
    // for every pre-existing bubble whenever the tail grows, causing web-core to
    // remount the bubble (a visible flash). Identity = (role, kind, content-hash)
    // plus a stable occurrence ordinal that disambiguates identical repeated
    // lines without renumbering earlier occurrences when the tail grows.
    const signatureOccurrences = new Map<string, number>()
    return list.map((message, index) => {
        const role = message?.role || 'assistant'
        const kind = message?.kind || 'standard'
        const content = typeof message?.content === 'string' ? message.content : ''
        if (role === 'user' || turnIndex < 0) turnIndex += 1
        // Seed is position-independent: no array index. The occurrence ordinal is
        // appended separately so identical repeated lines still get distinct keys.
        const seed = [role, kind, '', content].join('\n')
        const contentHash = stableHash(seed)
        const occurrence = signatureOccurrences.get(contentHash) ?? 0
        signatureOccurrences.set(contentHash, occurrence + 1)
        const providerUnitKey = `v2-pty:${role}:${kind}:${contentHash}:#${occurrence}`
        const bubbleId = `bubble:${providerUnitKey}`
        const turnKey = `turn:${turnIndex}`
        const isStreamingTail = status === 'generating' && role === 'assistant' && index === list.length - 1
        return {
            ...message,
            providerUnitKey,
            bubbleId,
            sequence: index,
            _turnKey: turnKey,
            bubbleState: isStreamingTail ? 'streaming' as const : 'final' as const,
        }
    })
}

// ─── Main builder ────────────────────────────────

export function buildParseSessionFromTui(spec: ParseSessionTuiSpec): (input: any) => SynthesizedSession {
    if (!spec.transcriptPty) {
        throw new Error('buildParseSessionFromTui: spec.transcriptPty is required')
    }

    // Compile regexes once
    const assistantRe = new RegExp(spec.transcriptPty.assistantPrefix.regex, spec.transcriptPty.assistantPrefix.flags || '')
    const userRe = spec.transcriptPty.userPrefix
        ? new RegExp(spec.transcriptPty.userPrefix.regex, spec.transcriptPty.userPrefix.flags || '')
        : null
    const toolRe = spec.transcriptPty.toolPrefix
        ? new RegExp(spec.transcriptPty.toolPrefix.regex, spec.transcriptPty.toolPrefix.flags || '')
        : null
    const toolSkip = spec.transcriptPty.toolPrefix?.skip ?? false
    const chromeRes = (spec.transcriptPty.chromePatterns || []).map(p =>
        new RegExp(p.regex, p.flags || ''))
    const requireIndentForContinuation = spec.transcriptPty.continuationLine?.indented ?? false
    const stripLeadingChrome = spec.transcriptPty.stripLeadingChrome ?? true
    const scope = spec.transcriptPty.scope ?? 'buffer'
    // Background-SGR user-turn markers. A raw line whose ANSI carries one of
    // these `48;5;NNN`-style background codes is a user turn even when its
    // stripped text is a bare line the assistantPrefix would otherwise grab.
    const userBgList = Array.isArray(spec.transcriptPty.userBackgroundSgr)
        ? spec.transcriptPty.userBackgroundSgr.map(s => String(s).trim()).filter(Boolean)
        : []
    // Value-agnostic sentinel: "*" / "48;*" / "bg" matches ANY background-color
    // SGR (256-color `48;5;<n>` OR truecolor `48;2;<r>;<g>;<b>`) as the boxed-user
    // signal, instead of an allowlist of exact colors that breaks whenever a TUI
    // changes its box color. The param group must sit inside an SGR run terminated
    // by `m`; 3-digit color indices / channels are matched structurally.
    const ANY_BG_SENTINELS = new Set(['*', '48;*', 'bg', '48'])
    const userBgRes = userBgList.map(code => {
        if (ANY_BG_SENTINELS.has(code.toLowerCase())) {
            return new RegExp('\\x1b\\[[0-9;]*\\b48;(?:5;\\d{1,3}|2;\\d{1,3};\\d{1,3};\\d{1,3})[0-9;]*m')
        }
        // Match the code inside an SGR run: `\x1b[<...>48;5;233<...>m`. The code
        // (e.g. "48;5;233") appears somewhere in the `;`-separated parameter list
        // terminated by `m`. Escape regex-special chars in the code first.
        const esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`\\x1b\\[[0-9;]*${esc}[0-9;]*m`)
    })

    // Compose detect + approval helpers if their inputs are present.
    const detectStatus = (spec.spinner || spec.settledPrompt || spec.modal || spec.dispatchOrder)
        ? buildDetectStatusFromTui({
            spinner: spec.spinner,
            settledPrompt: spec.settledPrompt,
            modal: spec.modal,
            dispatchOrder: spec.dispatchOrder,
        })
        : () => null
    const parseApproval = spec.modal ? buildParseApprovalFromTui(spec.modal) : () => null

    // Optional session-id extraction (tui/session-id-extraction@1). Compile once
    // so each parseSession call is a single regex.exec on the chosen scope.
    const sessionIdRe = spec.sessionIdExtraction
        ? new RegExp(
            spec.sessionIdExtraction.regex,
            spec.sessionIdExtraction.flags ?? 'i',
        )
        : null
    const sessionIdScope: TranscriptPtySpec['scope'] = spec.sessionIdExtraction?.scope ?? 'tail'

    return function parseSession(input: any): SynthesizedSession {
        // status + modal first
        const status = detectStatus(input as any) ?? 'idle'
        const modal = parseApproval(input as any)

        const text = pickInputText(input, scope)
        // When a bg-SGR user marker is configured we need the raw (pre-strip)
        // line to test the background color; otherwise the cheaper stripped
        // split is enough. Both yield the same stripped `text` per line.
        const rawLines = userBgRes.length > 0 ? splitRawLines(text) : splitLines(text).map(t => ({ raw: '', text: t }))

        const messages: SynthesizedMessage[] = []
        let seenFirstRoleLine = !stripLeadingChrome

        for (const entry of rawLines) {
            const line = entry.text
            if (line.trim() === '') {
                // Blank line: ends streaming continuation but doesn't add a message.
                continue
            }

            // Chrome filter
            let isChrome = false
            for (const cre of chromeRes) {
                if (cre.test(line)) { isChrome = true; break }
            }
            if (isChrome) continue

            // Background-SGR user classification. Checked before prefix matching
            // so a user turn rendered as a bg-boxed plain line (no distinctive
            // glyph — cursor-agent) is attributed to the user instead of being
            // grabbed by a permissive assistantPrefix. The visible text is the
            // ANSI-stripped `line`.
            if (userBgRes.length > 0 && entry.raw && userBgRes.some(re => re.test(entry.raw))) {
                seenFirstRoleLine = true
                // Strip a leading composer glyph (e.g. "→ ") the boxed echo may carry.
                const content = line.replace(/^\s*[→>›❯]\s*/, '').trim()
                if (content) messages.push({ role: 'user', kind: 'standard', content })
                continue
            }

            // Role detection
            const userMatch = userRe ? line.match(userRe) : null
            const toolMatch = toolRe ? line.match(toolRe) : null
            const assistMatch = line.match(assistantRe)

            if (userMatch) {
                seenFirstRoleLine = true
                const content = (userMatch[1] ?? userMatch[0]).trim()
                if (content) messages.push({ role: 'user', kind: 'standard', content })
                continue
            }
            if (toolMatch) {
                seenFirstRoleLine = true
                if (toolSkip) continue
                const content = (toolMatch[1] ?? toolMatch[0]).trim()
                if (content) messages.push({ role: 'assistant', kind: 'tool', content })
                continue
            }
            if (assistMatch) {
                seenFirstRoleLine = true
                const content = (assistMatch[1] ?? assistMatch[0]).trim()
                if (content) messages.push({ role: 'assistant', kind: 'standard', content })
                continue
            }

            if (!seenFirstRoleLine) continue

            // Continuation rule
            if (requireIndentForContinuation && !/^\s/.test(line)) continue
            const last = messages[messages.length - 1]
            if (!last) continue
            const cont = line.replace(/^\s+/, '')
            if (cont) last.content = last.content ? `${last.content}\n${cont}` : cont
        }

        const result: SynthesizedSession = {
            status,
            messages,
            activeModal: modal,
            modal,
            parsedStatus: status,
        }

        if (sessionIdRe) {
            const haystack = stripAnsi(pickInputText(input, sessionIdScope))
            const match = haystack.match(sessionIdRe)
            const captured = match?.[1]?.trim()
            if (captured) result.providerSessionId = captured
        }

        return result
    }
}
