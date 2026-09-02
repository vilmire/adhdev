/**
 * Scope/route decision for the standalone `InteractivePromptGate`.
 *
 * Extracted as a pure function so it is testable without a DOM: the gate itself
 * is a React component wired to the router and the daemon context, and the two
 * live defects it fixes were both decision bugs, not rendering bugs.
 *
 * See the `InteractivePromptGate` doc comment in `App.tsx` for the full history.
 * In short, the gate used to run an UNSCOPED scan on every route:
 *   1. it surfaced whichever session came first in `ides` order — a status-report
 *      merge artifact — rather than the session the user has selected, and
 *   2. because the modal is a `fixed inset-0` overlay, a prompt on any session
 *      covered the tab bar and trapped the user on the current tab, and
 *   3. on /dashboard it stacked on top of the scoped modal `Dashboard` already
 *      renders through `DashboardOverlays`.
 */

/** Route prefix that owns its own scoped interactive-prompt surface. */
const DASHBOARD_ROUTE_PREFIX = '/dashboard'

export interface InteractivePromptGateScope {
  /**
   * When true the gate renders nothing at all — `Dashboard` already renders a
   * scoped `InteractivePromptModal` on this route.
   */
  suppressed: boolean
  /**
   * Session id to scope the prompt lookup to, or null for no selection.
   *
   * This is the `activeTab` search param, which `openDesktopConversation`
   * writes as the conversation's `sessionId` — the same id `Dashboard` passes
   * to `useInteractivePrompt`, so the two surfaces agree instead of racing.
   */
  sessionId: string | null
}

export function resolveInteractivePromptGateScope(
  pathname: string,
  activeTabParam: string | null | undefined,
): InteractivePromptGateScope {
  const trimmed = typeof activeTabParam === 'string' ? activeTabParam.trim() : ''
  return {
    suppressed: pathname.startsWith(DASHBOARD_ROUTE_PREFIX),
    sessionId: trimmed ? trimmed : null,
  }
}
