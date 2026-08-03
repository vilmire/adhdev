/**
 * RF-ROUTER LOW family — diagnostics read commands.
 *
 * Extracted verbatim from DaemonCommandRouter.executeDaemonCommand. Both handlers
 * read only process-global logging buffers (ring buffer + file fallback + debug
 * trace) — no router instance state — and return the same CommandRouterResult the
 * inlined cases did.
 */
import * as fs from 'fs';
import { getRecentLogs, getCurrentDaemonLogPath } from '../../logging/logger.js';
import { getRecentDebugTrace } from '../../logging/debug-trace.js';
import type { LowFamilyContext, LowFamilyHandler } from './types.js';

export const diagnosticsHandlers: Record<string, LowFamilyHandler> = {
    get_logs: async (_ctx: LowFamilyContext, args: any) => {
        const count = parseInt(args?.count) || parseInt(args?.lines) || 100;
        const minLevel = args?.minLevel || 'info';
        const sinceTs = args?.since || 0;

        try {
            // Priority 1: ring buffer (fast and structured)
            let logs = getRecentLogs(count, minLevel);
            if (sinceTs > 0) {
                logs = logs.filter((l: any) => l.ts > sinceTs);
            }
            if (logs.length > 0) {
                return { success: true, logs, totalBuffered: logs.length };
            }
            // Incremental polling must not fall back to unfiltered file text: the file
            // format is not timestamp-filterable, and returning its tail makes the UI
            // replace structured logs with old raw fallback lines when nothing new exists.
            if (sinceTs > 0) {
                return { success: true, logs: [], totalBuffered: 0 };
            }
            // Priority 2: file fallback
            // Resolved per call: the active log file changes on date rollover
            // (and with ADHDEV_CONFIG_DIR), so a snapshotted path would serve
            // yesterday's file to the dashboard.
            const logPath = getCurrentDaemonLogPath();
            if (fs.existsSync(logPath)) {
                const content = fs.readFileSync(logPath, 'utf-8');
                const allLines = content.split('\n');
                const recent = allLines.slice(-count).join('\n');
                return { success: true, logs: recent, totalLines: allLines.length };
            }
            return { success: true, logs: [], totalBuffered: 0 };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    },

    get_debug_trace: async (_ctx: LowFamilyContext, args: any) => {
        const count = parseInt(args?.count) || parseInt(args?.limit) || 100;
        const sinceTs = Number(args?.since) || 0;
        const interactionId = typeof args?.interactionId === 'string' ? args.interactionId : undefined;
        const category = typeof args?.category === 'string' ? args.category : undefined;
        const trace = getRecentDebugTrace({ interactionId, category, limit: count })
            .filter((entry) => !sinceTs || entry.ts > sinceTs);
        return { success: true, trace, count: trace.length };
    },
};
