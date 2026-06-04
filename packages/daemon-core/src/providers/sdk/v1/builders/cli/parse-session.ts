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
const OSC_RE = /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\|(?=\n|$))/g

function stripAnsi(text: string): string {
    return String(text || '')
        .replace(/\x1b\[(\d*)C/g, (_m, n) => ' '.repeat(Math.max(1, Number(n) || 1)))
        .replace(/\x1b\[\d*D/g, '')
        .replace(ANSI_RE, '')
        .replace(OSC_RE, '')
        .replace(/\x1b[P^_X][\s\S]*?(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b(?:[@-Z\\-_])/g, '')
}

function splitLines(text: string): string[] {
    return stripAnsi(text)
        .replace(//g, '')
        .split(/\r?\n/)
        .map(l => l.replace(/\s+$/, ''))
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
    return list.map((message, index) => {
        const role = message?.role || 'assistant'
        const kind = message?.kind || 'standard'
        const content = typeof message?.content === 'string' ? message.content : ''
        if (role === 'user' || turnIndex < 0) turnIndex += 1
        const seed = [role, kind, '', index, content].join('\n')
        const providerUnitKey = `v2-pty:${role}:${kind}:${index}:${stableHash(seed)}`
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
        const lines = splitLines(text)

        const messages: SynthesizedMessage[] = []
        let seenFirstRoleLine = !stripLeadingChrome

        for (const raw of lines) {
            const line = raw
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
