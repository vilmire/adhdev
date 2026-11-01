/**
 * Neutral registry of "what does the provider's own turn lifecycle say right now".
 *
 * A provider adapter (providers/spec/native-turn-hold.ts, Codex rollout) registers a peek
 * function per session; mesh health consumers (mesh/**, which may not value-import providers/**)
 * read it here. 'unknown' = no evidence (no registration, unmapped transcript, stale transcript).
 */
export type NativeTurnState = 'open' | 'closed' | 'unknown';
const peeks = new Map<string, () => NativeTurnState>();

export function registerNativeTurnPeek(sessionId: string, peek: () => NativeTurnState): void {
    peeks.set(sessionId, peek);
    if (peeks.size > 200) peeks.delete(peeks.keys().next().value!);
}
export function unregisterNativeTurnPeek(sessionId: string): void { peeks.delete(sessionId); }

/** Fresh native evidence for a session; never throws. */
export function nativeTurnStateFor(sessionId: string | undefined): NativeTurnState {
    if (!sessionId) return 'unknown';
    try { return peeks.get(sessionId)?.() ?? 'unknown'; } catch { return 'unknown'; }
}
