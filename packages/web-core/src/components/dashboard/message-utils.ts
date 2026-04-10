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
    if (!contentA || contentA !== contentB) return false

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

export function choosePreferredMessage<T extends MessageLike>(existing: T, incoming: T): T {
    const existingScore = getMessagePreferenceScore(existing)
    const incomingScore = getMessagePreferenceScore(incoming)
    if (incomingScore !== existingScore) return incomingScore > existingScore ? incoming : existing
    return normalizeTextContent(incoming.content).length >= normalizeTextContent(existing.content).length
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
    const liveHashes = new Set(liveMessages.map((message) => getMessagePreviewHash(message)))
    return historyMessages.filter((message) => !liveHashes.has(getMessagePreviewHash(message)))
}
