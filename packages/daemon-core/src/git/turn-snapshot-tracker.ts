/**
 * Tracks agent session status transitions and fires snapshot callbacks on turn completion.
 * "Busy" = streaming | waiting_approval
 * "Completed" = idle | error (transition from busy)
 */

export type TurnCompletedCallback = (params: { sessionId: string; workspace: string }) => void

const BUSY_STATUSES = new Set(['streaming', 'waiting_approval'])
const TERMINAL_STATUSES = new Set(['idle', 'error'])

export class TurnSnapshotTracker {
  private lastStatus = new Map<string, string>()
  private onTurnCompleted: TurnCompletedCallback

  constructor(onTurnCompleted: TurnCompletedCallback) {
    this.onTurnCompleted = onTurnCompleted
  }

  record(sessionId: string, status: string, workspace: string | null | undefined): void {
    const prev = this.lastStatus.get(sessionId)
    this.lastStatus.set(sessionId, status)
    if (workspace && prev && BUSY_STATUSES.has(prev) && TERMINAL_STATUSES.has(status)) {
      this.onTurnCompleted({ sessionId, workspace })
    }
  }

  forget(sessionId: string): void {
    this.lastStatus.delete(sessionId)
  }
}
