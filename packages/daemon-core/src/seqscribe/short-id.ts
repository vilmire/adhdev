/** Truncate an id for log lines, keeping the first 12 characters. */
export function shortId(id: string): string {
    return id.length <= 12 ? id : `${id.slice(0, 12)}…`;
}
