import { normalizeTextContent } from '../../utils/text'

export type LocalUserMessage = {
    role: string
    content: string
    timestamp: number
    _localId: string
}

export type MessageLike = {
    role?: string
    content?: unknown
    id?: string
    _localId?: string
    _turnKey?: string
    receivedAt?: number | string
    timestamp?: number
}

export function getMessageTimestamp(message: Pick<MessageLike, 'receivedAt' | 'timestamp'> | null | undefined): number {
    const ts = Number(message?.receivedAt || message?.timestamp || 0)
    return Number.isFinite(ts) ? ts : 0
}

export function areLikelySameMessages<T extends MessageLike>(
    a: T | null | undefined,
    b: T | null | undefined,
): boolean {
    if (!a || !b) return false
    if (a === b) return true
    if (a.id && b.id && String(a.id) === String(b.id)) return true
    if (a._localId && b._localId && String(a._localId) === String(b._localId)) return true

    const roleA = String(a.role || '').toLowerCase()
    const roleB = String(b.role || '').toLowerCase()
    if (roleA !== roleB) return false

    const contentA = normalizeTextContent(a.content)
    const contentB = normalizeTextContent(b.content)
    if (!contentA || !contentB) return false
    const contentMatches = contentA === contentB
        || isLikelyTruncatedDuplicate(contentA, contentB)
        || isLikelyTruncatedDuplicate(contentB, contentA)
    if (!contentMatches) return false

    const tsA = getMessageTimestamp(a)
    const tsB = getMessageTimestamp(b)
    if (tsA && tsB) return Math.abs(tsA - tsB) <= 15000

    return !!a._localId !== !!b._localId
}

function getMessagePreferenceScore(message: MessageLike | null | undefined): number {
    let score = 0
    if (!message?._localId) score += 4
    if (message?.id) score += 3
    if (message?._turnKey) score += 2
    if (getMessageTimestamp(message)) score += 1
    return score
}

function getNormalizedMessageContent(message: MessageLike | null | undefined): string {
    return normalizeTextContent(message?.content)
}

function isLikelyTruncatedDuplicate(longer: string, shorter: string): boolean {
    if (!longer || !shorter) return false
    if (longer.length <= shorter.length) return false
    const minUsefulLength = Math.max(12, Math.min(80, Math.floor(longer.length * 0.4)))
    if (shorter.length < minUsefulLength) return false
    return longer.startsWith(shorter) || longer.includes(shorter)
}

function preferMoreCompleteMessage<T extends MessageLike>(left: T, right: T): T | null {
    const leftContent = getNormalizedMessageContent(left)
    const rightContent = getNormalizedMessageContent(right)
    if (!leftContent || !rightContent || leftContent === rightContent) return null

    if (isLikelyTruncatedDuplicate(leftContent, rightContent)) return left
    if (isLikelyTruncatedDuplicate(rightContent, leftContent)) return right
    return null
}

export function choosePreferredMessage<T extends MessageLike>(existing: T, incoming: T): T {
    const moreComplete = preferMoreCompleteMessage(existing, incoming)
    if (moreComplete) return moreComplete

    const existingScore = getMessagePreferenceScore(existing)
    const incomingScore = getMessagePreferenceScore(incoming)
    if (incomingScore !== existingScore) return incomingScore > existingScore ? incoming : existing
    return getNormalizedMessageContent(incoming).length >= getNormalizedMessageContent(existing).length
        ? incoming
        : existing
}

export function dedupeOptimisticMessages<T extends MessageLike>(messages: T[]): T[] {
    const result: T[] = []
    for (const message of messages) {
        const duplicateIndex = result.findIndex((existing) => areLikelySameMessages(existing, message))
        if (duplicateIndex >= 0) {
            result.splice(duplicateIndex, 1, choosePreferredMessage(result[duplicateIndex]!, message))
            continue
        }
        result.push(message)
    }
    return result
}

export function mergeLiveChatMessages<T extends MessageLike>(
    cachedLiveMessages: T[] | null | undefined,
    activeConversationMessages: T[] | null | undefined,
): T[] {
    const cached = Array.isArray(cachedLiveMessages) ? cachedLiveMessages : []
    const active = Array.isArray(activeConversationMessages) ? activeConversationMessages : []
    if (cached.length === 0) return active
    if (active.length === 0) return cached
    return dedupeOptimisticMessages([...cached, ...active])
}

export function sortMessagesChronologically<T extends MessageLike>(messages: T[]): T[] {
    return [...messages].sort((left, right) => {
        const leftTs = getMessageTimestamp(left)
        const rightTs = getMessageTimestamp(right)
        if (leftTs && rightTs && leftTs !== rightTs) return leftTs - rightTs
        return 0
    })
}

export function getMessagePreviewHash(message: MessageLike | null | undefined): string {
    return `${String(message?.role || '').toLowerCase()}:${normalizeTextContent(message?.content).slice(0, 100)}`
}

export function filterUnconfirmedLocalMessages(
    serverMessages: MessageLike[],
    localMessages: LocalUserMessage[],
): LocalUserMessage[] {
    const unmatchedServerUsers = serverMessages
        .filter((message) => String(message?.role || '').toLowerCase() === 'user')
        .slice()

    return localMessages.filter((localMessage) => {
        const matchIndex = unmatchedServerUsers.findIndex((serverMessage) => areLikelySameMessages(serverMessage, localMessage))
        if (matchIndex >= 0) {
            unmatchedServerUsers.splice(matchIndex, 1)
            return false
        }
        return true
    })
}

export function excludeMessagesPresentInLiveFeed<T extends MessageLike>(historyMessages: T[], liveMessages: MessageLike[]): T[] {
    return historyMessages.filter((historyMessage) => {
        const historyContent = getNormalizedMessageContent(historyMessage)
        const historyRole = String(historyMessage?.role || '').toLowerCase()
        const historyTs = getMessageTimestamp(historyMessage)

        return !liveMessages.some((liveMessage) => {
            if (areLikelySameMessages(historyMessage, liveMessage)) return true

            const liveRole = String(liveMessage?.role || '').toLowerCase()
            if (!historyContent || !historyRole || historyRole !== liveRole) return false

            const liveContent = getNormalizedMessageContent(liveMessage)
            if (!isLikelyTruncatedDuplicate(liveContent, historyContent) && liveContent !== historyContent) return false

            const liveTs = getMessageTimestamp(liveMessage)
            if (historyTs && liveTs) return Math.abs(historyTs - liveTs) <= 15000
            return true
        })
    })
}
