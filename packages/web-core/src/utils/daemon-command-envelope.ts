/**
 * daemon-command-envelope — the ONE place that knows both sendCommand response
 * shapes (fragmentation audit).
 *
 *   standalone — resolves the daemon's raw body
 *   cloud P2P  — wraps it once: `{ success: true, result: <daemon body> }`
 *
 * Every web-core reader of a command response must tolerate both, and the
 * codebase had grown a dozen hand-rolled `raw?.result ?? raw` inlines plus two
 * duplicated helper functions (this one, previously in provider-channel-sync,
 * and ControlsBar's getCommandBody) — the exact drift class that produced the
 * ControlsBar model-selector silent-empty bug (see TransportContext.tsx:11).
 * New code imports from here; inline sites migrate opportunistically.
 */
export function unwrapDaemonCommandBody<T extends Record<string, unknown>>(raw: unknown): T | undefined {
    if (!raw || typeof raw !== 'object') return undefined
    const obj = raw as Record<string, unknown>
    if ('result' in obj && obj.result && typeof obj.result === 'object') {
        return obj.result as T
    }
    return obj as T
}
