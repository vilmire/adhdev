export const DEFAULT_VISIBLE_STANDARD_MESSAGES = 60
export const DEFAULT_VISIBLE_CLI_MESSAGES = 1000

export function getDefaultVisibleLiveMessages(options: { isCliLike?: boolean } = {}): number {
    return options.isCliLike ? DEFAULT_VISIBLE_CLI_MESSAGES : DEFAULT_VISIBLE_STANDARD_MESSAGES
}

export function getDefaultChatTailHydrateLimit(options: { isCliLike?: boolean } = {}): number {
    return getDefaultVisibleLiveMessages(options)
}
