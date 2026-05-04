export type MessageLike = {
    receivedAt?: number | string
    timestamp?: number
}

export function getMessageTimestamp(message: Pick<MessageLike, 'receivedAt' | 'timestamp'> | null | undefined): number {
    const ts = Number(message?.receivedAt || message?.timestamp || 0)
    return Number.isFinite(ts) ? ts : 0
}
