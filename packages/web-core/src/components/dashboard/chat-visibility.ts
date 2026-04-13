export const DEFAULT_VISIBLE_STANDARD_MESSAGES = 60
export const DEFAULT_VISIBLE_CLI_MESSAGES = 200

export function getDefaultVisibleLiveMessages(options: { isCliLike?: boolean } = {}): number {
    return options.isCliLike ? DEFAULT_VISIBLE_CLI_MESSAGES : DEFAULT_VISIBLE_STANDARD_MESSAGES
}
