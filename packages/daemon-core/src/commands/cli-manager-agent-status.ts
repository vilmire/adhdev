/**
 * CLI launch-command probing and workspace-path comparison for DaemonCliManager.
 *
 * Pure move out of cli-manager.ts (file-size gate headroom). The send-status
 * predicates that used to live here (`BUSY_AGENT_STATUSES`,
 * `getEffectiveAgentSendStatus`, `waitForZeroMessageStartingLaunch`) fed only
 * the mesh send path's PRE-send status guess and were deleted with it
 * (wiring-unification D2/D3): the send outcome now comes from
 * `SessionInputService.submit` — the driver's real disposition — and the busy
 * decision from the A1 status class.
 */

import * as os from 'os';
import * as path from 'path';
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';

function isExplicitCommand(command: string): boolean {
    const trimmed = command.trim();
    return path.isAbsolute(trimmed) || trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('~');
}

function expandExecutable(command: string): string {
    const trimmed = command.trim();
    return trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
}

export function commandExists(command: string): boolean {
    const trimmed = command.trim();
    if (!trimmed) return false;
    if (isExplicitCommand(trimmed)) {
        return existsSync(expandExecutable(trimmed));
    }
    try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [trimmed], {
            stdio: 'ignore',
            ...(process.platform === 'win32' ? { windowsHide: true } : {}),
        });
        return true;
    } catch {
        return false;
    }
}

/**
 * WTCLAIM (B): compare two workspace paths for node scoping. Normalizes separator
 * style, trailing slashes, and case (Windows paths are case-insensitive; the
 * coordinator-supplied node.workspace and the adapter's launch workingDir can
 * differ only in those) so a base node and a worktree clone are still told apart
 * by their distinct workspace roots.
 */
export function normalizeDirForCompare(dir?: string): string {
    if (typeof dir !== 'string') return '';
    return dir.trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}
