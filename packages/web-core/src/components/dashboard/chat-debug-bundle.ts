import type { ActiveConversation } from './types'

export interface ControlsToggleDebugGestureState {
    count: number
    firstAt: number
}

export interface ControlsToggleDebugGestureResult {
    state: ControlsToggleDebugGestureState
    shouldCollect: boolean
}

const GESTURE_TOGGLE_COUNT = 10
const GESTURE_WINDOW_MS = 8_000
const SECRET_KEY_PATTERN = /(?:token|secret|password|passwd|authorization|cookie|api[_-]?key|access[_-]?key|refresh[_-]?token|client[_-]?secret|private[_-]?key)/i

function redactDebugString(value: string): string {
    return value
        .replace(/(Authorization\s*:\s*Bearer\s+)[^\s'"`]+/gi, '$1[REDACTED:bearer]')
        .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}=*/gi, '$1[REDACTED:bearer]')
        .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED:github-token]')
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED:api-key]')
        .replace(/\b(?:adk|adm)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED:adhdev-token]')
        .replace(/((?:api[_-]?key|token|secret|password|passwd|client[_-]?secret)\s*[:=]\s*)[^\s,'"`}&]+/gi, '$1[REDACTED:secret]')
        .replace(/([?&](?:api[_-]?key|token|secret|password|client_secret)=)[^&#\s]+/gi, '$1[REDACTED:secret]')
}

function sanitizeFrontendDebugValue(value: unknown, keyHint = '', depth = 0): unknown {
    if (value === null || value === undefined) return value
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value === 'string') {
        if (SECRET_KEY_PATTERN.test(keyHint) && value.trim()) return '[REDACTED:secret-field]'
        const redacted = redactDebugString(value)
        return redacted.length > 8_000 ? `${redacted.slice(0, 8_000)}…[truncated ${redacted.length - 8_000} chars]` : redacted
    }
    if (typeof value !== 'object') return String(value)
    if (depth >= 6) return '[MaxDepth]'
    if (Array.isArray(value)) {
        const tail = value.slice(-20).map((item) => sanitizeFrontendDebugValue(item, keyHint, depth + 1))
        return value.length > 20 ? [{ truncatedBefore: value.length - 20 }, ...tail] : tail
    }
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .slice(0, 80)
            .map(([key, nested]) => [key, sanitizeFrontendDebugValue(nested, key, depth + 1)]),
    )
}

function tail<T>(items: readonly T[] | undefined, limit: number): T[] {
    return Array.isArray(items) ? items.slice(-limit) : []
}

export function recordControlsToggleDebugGesture(
    previous: ControlsToggleDebugGestureState | undefined,
    now = Date.now(),
): ControlsToggleDebugGestureResult {
    const withinWindow = previous && (now - previous.firstAt) <= GESTURE_WINDOW_MS
    const nextCount = withinWindow ? previous.count + 1 : 1
    if (nextCount >= GESTURE_TOGGLE_COUNT) {
        return { state: { count: 0, firstAt: now }, shouldCollect: true }
    }
    return {
        state: { count: nextCount, firstAt: withinWindow ? previous.firstAt : now },
        shouldCollect: false,
    }
}

export interface BuildChatFrontendDebugSnapshotOptions {
    activeConv: ActiveConversation
    visibleMessages: readonly unknown[]
    actionLogs: readonly { routeId: string; text: string; timestamp: number }[]
    controls?: readonly unknown[]
    controlValues?: Record<string, unknown>
    visibleBarControlCount: number
    chatTailState: {
        hasMoreHistory?: boolean
        historyError?: string | null
        historyMessages?: readonly unknown[]
    }
    ui: {
        controlsVisible: boolean
        visibleLiveCount: number
        hiddenLiveCount: number
        isInputActive: boolean
        isVisible: boolean
    }
    now?: number
    locationHref?: string
}

export function buildChatFrontendDebugSnapshot(options: BuildChatFrontendDebugSnapshotOptions): Record<string, unknown> {
    const { activeConv } = options
    const snapshot = {
        version: 1,
        createdAt: new Date(options.now ?? Date.now()).toISOString(),
        url: options.locationHref ?? (typeof window !== 'undefined' ? window.location.href : undefined),
        activeConversation: {
            routeId: activeConv.routeId,
            tabKey: activeConv.tabKey,
            sessionId: activeConv.sessionId,
            providerSessionId: activeConv.providerSessionId,
            transport: activeConv.transport,
            agentName: activeConv.agentName,
            agentType: activeConv.agentType,
            hostIdeType: activeConv.hostIdeType,
            status: activeConv.status,
            connectionState: activeConv.connectionState,
            title: activeConv.title,
            workspaceName: activeConv.workspaceName,
            displayPrimary: activeConv.displayPrimary,
            displaySecondary: activeConv.displaySecondary,
            streamSource: activeConv.streamSource,
            lastMessageHash: activeConv.lastMessageHash,
        },
        messageCounts: {
            live: activeConv.messages.length,
            visible: options.visibleMessages.length,
            history: options.chatTailState.historyMessages?.length || 0,
            hiddenLive: options.ui.hiddenLiveCount,
        },
        liveMessagesTail: tail(activeConv.messages, 10),
        visibleMessagesTail: tail(options.visibleMessages, 5),
        historyMessagesTail: tail(options.chatTailState.historyMessages, 5),
        actionLogsTail: tail(options.actionLogs.filter((entry) => entry.routeId === activeConv.tabKey), 20),
        controls: {
            visibleBarControlCount: options.visibleBarControlCount,
            definitions: options.controls || [],
            values: options.controlValues || {},
            visible: options.ui.controlsVisible,
        },
        chatTail: {
            hasMoreHistory: !!options.chatTailState.hasMoreHistory,
            historyError: options.chatTailState.historyError || null,
        },
        ui: options.ui,
        browser: typeof navigator !== 'undefined' ? {
            userAgent: navigator.userAgent,
            language: navigator.language,
            online: navigator.onLine,
        } : null,
    }
    return sanitizeFrontendDebugValue(snapshot) as Record<string, unknown>
}

export function buildChatDebugBundleClipboardText(result: unknown): string {
    const body = result && typeof result === 'object' ? result as Record<string, unknown> : {}
    if (typeof body.text === 'string') return body.text
    if (body.bundle && typeof body.bundle === 'object') {
        return `# ADHDev Chat Debug Bundle\n\n\`\`\`json\n${JSON.stringify(body.bundle, null, 2)}\n\`\`\``
    }
    return `# ADHDev Chat Debug Bundle\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\``
}
