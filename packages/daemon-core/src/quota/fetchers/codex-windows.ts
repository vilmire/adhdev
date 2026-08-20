/**
 * Window-slot assignment shared by the two Codex quota sources.
 *
 * Both the app-server reply (`./codex.ts`, camelCase) and the rollout log
 * (`./codex-rollout.ts`, snake_case) report the same pair of windows under the
 * same `primary`/`secondary` names, so the rule for sorting them lives here
 * once. Duplicating it would let the two sources disagree about the SAME
 * account's numbers depending on which path answered.
 */
'use strict';

import { SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES, type QuotaWindow } from '../types.js';

/**
 * Sort reported windows into session/weekly by their *duration*, not by their
 * `primary`/`secondary` position.
 *
 * This matters: on a Plus account `primary` is the 7-day window and
 * `secondary` is absent entirely, so treating `primary` as the session window
 * would report weekly consumption as if it were the 5h window. Each window is
 * assigned to whichever slot it is closer to, and a slot already filled by a
 * better-matching window is not overwritten.
 */
export function assignWindows(windows: QuotaWindow[]): {
    session: QuotaWindow | null;
    weekly: QuotaWindow | null;
} {
    let session: QuotaWindow | null = null;
    let weekly: QuotaWindow | null = null;

    for (const window of windows) {
        const toSession = Math.abs(window.windowMinutes - SESSION_WINDOW_MINUTES);
        const toWeekly = Math.abs(window.windowMinutes - WEEKLY_WINDOW_MINUTES);
        if (toSession <= toWeekly) {
            if (session === null || toSession < Math.abs(session.windowMinutes - SESSION_WINDOW_MINUTES)) {
                session = window;
            }
        } else if (weekly === null || toWeekly < Math.abs(weekly.windowMinutes - WEEKLY_WINDOW_MINUTES)) {
            weekly = window;
        }
    }
    return { session, weekly };
}
