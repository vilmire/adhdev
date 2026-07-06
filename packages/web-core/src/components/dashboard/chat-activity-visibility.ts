import type { ChatMessage } from '../../types'

export const CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY = 'adhdev_chat_activity_visible'

export type ChatTranscriptSurface = 'chat' | 'activity' | 'internal'

export interface ChatVisibilityClassification {
    surface: ChatTranscriptSurface
    isUserFacing: boolean
    isActivityFacing: boolean
    isInternal: boolean
    role: string
    kind: string
    label: string
}

const EXPLICIT_HIDDEN_VISIBILITIES = new Set(['hidden', 'debug', 'internal'])
const EXPLICIT_VISIBLE_VISIBILITIES = new Set(['visible', 'user', 'chat'])
const HIDDEN_AUDIENCES = new Set(['debug', 'trace', 'internal'])
const ACTIVITY_SOURCES = new Set(['tool_call', 'terminal_command', 'runtime_activity'])
const INTERNAL_SOURCES = new Set(['runtime_status', 'provider_chrome', 'control'])
const ACTIVITY_KINDS = new Set(['thought', 'tool', 'terminal'])

function readMeta(message: ChatMessage): Record<string, unknown> | null {
    const meta = message.meta
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : null
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function readField(message: ChatMessage, meta: Record<string, unknown> | null, key: string): unknown {
    return (message as ChatMessage & Record<string, unknown>)[key] ?? meta?.[key]
}

function hasBooleanMarker(message: ChatMessage, meta: Record<string, unknown> | null, keys: string[]): boolean {
    const record = message as ChatMessage & Record<string, unknown>
    return keys.some((key) => record[key] === true || meta?.[key] === true)
}

function getKind(message: ChatMessage, role: string): string {
    const rawKind = readString((message as ChatMessage & { kind?: unknown }).kind)
    if (rawKind) return rawKind
    return role === 'tool' ? 'tool' : 'standard'
}

function getActivityLabel(message: ChatMessage, kind: string, source: string): string {
    const meta = readMeta(message)
    const explicit = typeof meta?.label === 'string' ? meta.label.trim() : ''
    if (explicit) return explicit
    if (kind === 'terminal' || source === 'terminal_command') return 'Terminal'
    if (kind === 'tool' || source === 'tool_call') return 'Tool'
    if (kind === 'thought') return 'Thought'
    if (source === 'runtime_activity') return 'Runtime'
    return 'Activity'
}

function hasStructuredDisplayContent(message: ChatMessage): boolean {
    const content = (message as ChatMessage & { content?: unknown }).content
    return Array.isArray(content) && content.some((part) => !!part && typeof part === 'object' && (part as { type?: unknown }).type !== 'text')
}

export function classifyChatMessageForDisplay(message: ChatMessage | null | undefined): ChatVisibilityClassification {
    if (!message) {
        return { surface: 'internal', isUserFacing: false, isActivityFacing: false, isInternal: true, role: '', kind: 'standard', label: 'Internal' }
    }
    const meta = readMeta(message)
    const role = readString(message.role)
    const kind = getKind(message, role)
    const visibility = readString(readField(message, meta, 'visibility'))
    const transcriptVisibility = readString((message as ChatMessage & Record<string, unknown>).transcriptVisibility ?? meta?.transcriptVisibility ?? visibility)
    const audience = readString(readField(message, meta, 'audience'))
    const source = readString(readField(message, meta, 'source'))
    const explicitHidden = EXPLICIT_HIDDEN_VISIBILITIES.has(visibility)
        || EXPLICIT_HIDDEN_VISIBILITIES.has(transcriptVisibility)
        || HIDDEN_AUDIENCES.has(audience)
        || hasBooleanMarker(message, meta, ['internal', 'isInternal', 'debug', 'statusOnly', 'controlOnly'])
    const explicitUserFacing = EXPLICIT_VISIBLE_VISIBILITIES.has(visibility)
        || EXPLICIT_VISIBLE_VISIBILITIES.has(transcriptVisibility)
        || audience === 'chat'
        || hasBooleanMarker(message, meta, ['userFacing'])
    const activityLike = ACTIVITY_KINDS.has(kind) || ACTIVITY_SOURCES.has(source)

    if (explicitHidden) {
        return {
            surface: activityLike ? 'activity' : 'internal',
            isUserFacing: false,
            isActivityFacing: activityLike,
            isInternal: !activityLike,
            role,
            kind,
            label: getActivityLabel(message, kind, source),
        }
    }
    if (explicitUserFacing) {
        return { surface: 'chat', isUserFacing: true, isActivityFacing: false, isInternal: false, role, kind, label: getActivityLabel(message, kind, source) }
    }
    if ((role === 'system' || kind === 'system') && hasStructuredDisplayContent(message)) {
        return { surface: 'chat', isUserFacing: true, isActivityFacing: false, isInternal: false, role, kind, label: 'Chat' }
    }
    if (INTERNAL_SOURCES.has(source) || role === 'system' || kind === 'system') {
        return { surface: 'internal', isUserFacing: false, isActivityFacing: false, isInternal: true, role, kind, label: 'Internal' }
    }
    if (activityLike) {
        return { surface: 'activity', isUserFacing: false, isActivityFacing: true, isInternal: false, role, kind, label: getActivityLabel(message, kind, source) }
    }
    const isUserFacing = (role === 'user' || role === 'human' || role === 'assistant') && (kind === 'standard' || kind === '')
    return { surface: isUserFacing ? 'chat' : 'internal', isUserFacing, isActivityFacing: false, isInternal: !isUserFacing, role, kind, label: isUserFacing ? 'Chat' : 'Internal' }
}

export function filterChatMessagesForDefaultTranscript<T extends ChatMessage>(messages: T[] | null | undefined): T[] {
    return (Array.isArray(messages) ? messages : []).filter((message) => classifyChatMessageForDisplay(message).isUserFacing)
}

export function filterChatActivityMessages<T extends ChatMessage>(messages: T[] | null | undefined): T[] {
    return (Array.isArray(messages) ? messages : []).filter((message) => classifyChatMessageForDisplay(message).isActivityFacing)
}

function chatBubbleText(message: ChatMessage): string {
    const content = (message as { content?: unknown }).content
    return typeof content === 'string' ? content : (() => { try { return JSON.stringify(content ?? '') } catch { return String(content ?? '') } })()
}

function chatBubbleContentSignature(message: ChatMessage): string {
    const role = String((message as { role?: unknown }).role || '')
    return `${role}::${chatBubbleText(message)}`
}

/**
 * Collapse ADJACENT bubbles that carry the identical role+content. This is NOT a
 * global transcript dedup (the history↔live seam intentionally preserves
 * non-adjacent overlap — see chat-pane-history-dedupe-truncation.test.ts): it only
 * removes back-to-back visual duplicates that appear when the paged history tail
 * and the live tail carry the same finalized assistant bubble at the seam, or when
 * a native transcript replays the same finalized turn. Mirrors the daemon's
 * isAdjacentHistoryDuplicate so the rendered transcript never shows a bubble twice
 * in a row. (ANTIGRAVITY-REPLICA-DUP)
 */
export function collapseAdjacentDuplicateChatMessages<T extends ChatMessage>(messages: T[]): T[] {
    if (messages.length < 2) return messages
    const out: T[] = []
    let prevSig = ''
    for (const message of messages) {
        const sig = chatBubbleContentSignature(message)
        // Never collapse empty-content bubbles into each other (distinct activity
        // placeholders can legitimately repeat); only collapse substantive dupes.
        const hasBody = chatBubbleText(message).trim().length > 0
        if (hasBody && sig === prevSig) continue
        out.push(message)
        prevSig = sig
    }
    return out
}

export function mergeChatAndActivityMessages<T extends ChatMessage>(messages: T[], activityMessages: T[], showActivity: boolean): T[] {
    if (!showActivity || activityMessages.length === 0) return messages
    return [...messages, ...activityMessages].sort((left, right) => {
        const leftTime = Number(left.receivedAt ?? left.timestamp ?? 0) || 0
        const rightTime = Number(right.receivedAt ?? right.timestamp ?? 0) || 0
        if (leftTime !== rightTime) return leftTime - rightTime
        const leftIndex = Number(left.index ?? 0) || 0
        const rightIndex = Number(right.index ?? 0) || 0
        return leftIndex - rightIndex
    })
}

export function readChatActivityVisiblePreference(storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined): boolean {
    try {
        return storage?.getItem(CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY) === '1'
    } catch {
        return false
    }
}

export function writeChatActivityVisiblePreference(value: boolean, storage: Pick<Storage, 'setItem'> | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined): void {
    try {
        storage?.setItem(CHAT_ACTIVITY_VISIBILITY_STORAGE_KEY, value ? '1' : '0')
    } catch {}
}
