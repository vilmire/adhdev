/**
 * Saved-history file layout: `<configDir>/history/{agentType}/YYYY-MM-DD.jsonl`
 * (optionally session-scoped), the dir/segment sanitizers, and the listing +
 * session-id extraction every history reader and the saved-history index share.
 */
import * as path from 'path';
import { getConfigDir } from './config.js';
import * as fs from 'fs';

// Lazy per call: history lives under the instance config dir
// (<configDir>/history/{agentType}/YYYY-MM-DD.jsonl), and this module can be
// imported before the entrypoint pins ADHDEV_CONFIG_DIR.
export function getHistoryDir(): string {
    return path.join(getConfigDir(), 'history');
}

function sanitizeHistoryFileSegment(value?: string): string {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function listHistoryFiles(dir: string, historySessionId?: string): string[] {
    const sanitizedSessionId = historySessionId ? sanitizeHistoryFileSegment(historySessionId) : '';
    return fs.readdirSync(dir)
        .filter((file) => {
            if (!file.endsWith('.jsonl')) return false;
            if (sanitizedSessionId) {
                return file.startsWith(`${sanitizedSessionId}_`);
            }
            return true;
        })
        .sort()
        .reverse();
}

export function normalizeSavedHistorySessionId(historySessionId: string): string {
    return String(historySessionId || '').trim();
}

export function extractSavedHistorySessionIdFromFile(file: string): string {
    const match = file.match(/^([A-Za-z0-9_-]+)_\d{4}-\d{2}-\d{2}\.jsonl$/);
    return normalizeSavedHistorySessionId(match?.[1] || '');
}
