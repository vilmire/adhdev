/**
 * Plain-language text for a raw transfer error code. The code itself is never shown as text:
 * callers keep it for a details tooltip only.
 */
type TFn = (key: string, options?: Record<string, unknown>) => string
type I18nLike = { exists: (key: string, options?: Record<string, unknown>) => boolean }

/**
 * Short sentence for `code` (settings.fileTransfer.reasons.*). With `allowLong` an unmapped code may
 * fall back to the longer settings.projectTransfer.errors.* explanation. Returns '' when unmapped.
 */
export function transferReasonText(t: TFn, i18n: I18nLike, code: string, opts: { allowLong?: boolean } = {}): string {
    const short = `settings.fileTransfer.reasons.${code}`
    if (i18n.exists(short, { ns: 'common' })) return t(short)
    if (opts.allowLong) {
        const long = `settings.projectTransfer.errors.${code}`
        if (i18n.exists(long, { ns: 'common' })) return t(long)
    }
    return ''
}

/** How many transfers the history shows before "Show all". */
export const HISTORY_COLLAPSED_COUNT = 3
