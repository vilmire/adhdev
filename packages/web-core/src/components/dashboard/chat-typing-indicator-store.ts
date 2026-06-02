/**
 * Single source-of-truth for "agent is generating" across the dashboard UI.
 *
 * The chat-bubble typing indicator (`ChatMessageList`'s `isWorking`) is the
 * authoritative signal: once ChatPane has decided to render the dots, the
 * tab spinner should follow that same decision. Previously each surface
 * derived `isGenerating` independently from `conversation.status` and the
 * surfaces could diverge for several seconds (Playwright reproduction:
 * tab spinner cleared at t=6s while chat typing indicator stayed on until
 * t=30s+).
 *
 * Implementation: an in-memory Map keyed by sessionId, with a tiny
 * subscription model. ChatPane publishes after its render decision;
 * DashboardDockviewTab subscribes and re-renders when the value flips for
 * the session it is rendering.
 */

const typingState = new Map<string, boolean>();
type Listener = (sessionId: string, isTyping: boolean) => void;
const listeners = new Set<Listener>();

export function publishChatTyping(sessionId: string, isTyping: boolean): void {
    if (!sessionId) return;
    const prev = typingState.get(sessionId);
    if (prev === isTyping) return;
    if (isTyping) typingState.set(sessionId, true);
    else typingState.delete(sessionId);
    listeners.forEach((listener) => listener(sessionId, isTyping));
}

export function getChatTyping(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    return typingState.get(sessionId) === true;
}

export function subscribeChatTyping(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Test helper: wipe the store between tests. */
export function clearChatTypingForTests(): void {
    typingState.clear();
    listeners.clear();
}
