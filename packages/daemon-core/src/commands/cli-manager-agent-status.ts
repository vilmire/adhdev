/**
 * CLI launch-command probing and agent send-status predicates.
 *
 * Pure move out of cli-manager.ts (file-size gate headroom). Every function
 * below is byte-identical to the text it replaced; no behavior change.
 *
 * Two concerns live here because they share one caller shape — the send guard
 * in DaemonCliManager asks both "can this command be spawned at all?" and "is
 * the adapter actually free to receive input right now?" before it injects.
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

export const BUSY_AGENT_STATUSES = new Set(['generating', 'running', 'streaming', 'starting', 'busy', 'waiting', 'waiting_approval', 'no_progress', 'long_generating']);
const ZERO_MESSAGE_STARTING_SEND_WAIT_MS = 2_000;

function normalizeAgentStatus(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hasNonEmptyModalButtons(activeModal: unknown): boolean {
    const buttons = (activeModal as any)?.buttons;
    return Array.isArray(buttons) && buttons.some((button) => String(button || '').trim().length > 0);
}

function hasAdapterPendingResponse(adapter: any): boolean {
    if (adapter?.isWaitingForResponse === true) return true;
    if (adapter?.currentTurnScope) return true;
    try {
        if (typeof adapter?.isProcessing === 'function' && adapter.isProcessing()) return true;
    } catch { /* defensive: send guard should not fail on diagnostics */ }
    try {
        const partial = typeof adapter?.getPartialResponse === 'function' ? adapter.getPartialResponse() : '';
        if (typeof partial === 'string' && partial.trim()) return true;
    } catch { /* defensive: missing partial means no pending evidence */ }
    return false;
}

function countMessages(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function hasFinalAssistantMessage(value: unknown): boolean {
    const messages = Array.isArray(value) ? value : [];
    const last = messages[messages.length - 1] as any;
    if (!last || last.role !== 'assistant') return false;
    if (last.bubbleState === 'streaming') return false;
    if (last.meta?.streaming === true) return false;
    return typeof last.content === 'string' && last.content.trim().length > 0;
}

function hasZeroMessageStartingLaunch(adapter: any): boolean {
    const adapterStatus = adapter?.getStatus?.({ allowParse: false }) ?? adapter?.getStatus?.() ?? {};
    const parsedStatus = typeof adapter?.getScriptParsedStatus === 'function'
        ? adapter.getScriptParsedStatus()
        : {};
    const adapterRawStatus = normalizeAgentStatus(adapterStatus?.status);
    const parsedRawStatus = normalizeAgentStatus(parsedStatus?.status);
    if (adapterRawStatus !== 'starting') return false;
    if (parsedRawStatus && parsedRawStatus !== 'starting' && parsedRawStatus !== 'generating') return false;
    if (hasNonEmptyModalButtons(adapterStatus?.activeModal ?? adapterStatus?.modal ?? parsedStatus?.activeModal ?? parsedStatus?.modal)) return false;
    if (countMessages(adapterStatus?.messages) > 0 || countMessages(parsedStatus?.messages) > 0) return false;
    return !hasAdapterPendingResponse(adapter);
}

function hasCompletedStartingLaunch(adapter: any): boolean {
    const adapterStatus = adapter?.getStatus?.({ allowParse: false }) ?? adapter?.getStatus?.() ?? {};
    const adapterRawStatus = normalizeAgentStatus(adapterStatus?.status);
    if (adapterRawStatus !== 'starting') return false;
    if (hasAdapterPendingResponse(adapter)) return false;

    const parsedStatus = typeof adapter?.getScriptParsedStatus === 'function'
        ? adapter.getScriptParsedStatus()
        : {};
    const parsedRawStatus = normalizeAgentStatus(parsedStatus?.status);
    if (parsedRawStatus !== 'idle') return false;
    if (hasNonEmptyModalButtons(adapterStatus?.activeModal ?? adapterStatus?.modal ?? parsedStatus?.activeModal ?? parsedStatus?.modal)) return false;
    return hasFinalAssistantMessage(parsedStatus?.messages);
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

function shouldSuppressStaleParsedBusyStatus(adapterStatus: string, parsedStatus: any, adapter: any): boolean {
    const parsedRawStatus = normalizeAgentStatus(parsedStatus?.status);
    if (!BUSY_AGENT_STATUSES.has(parsedRawStatus)) return false;
    if (adapterStatus !== 'idle') return false;
    if (hasNonEmptyModalButtons(parsedStatus?.activeModal ?? parsedStatus?.modal)) return false;
    return !hasAdapterPendingResponse(adapter);
}

export function getEffectiveAgentSendStatus(adapter: any): string {
    const adapterStatus = normalizeAgentStatus(adapter?.getStatus?.({ allowParse: false })?.status ?? adapter?.getStatus?.()?.status);
    if (adapterStatus === 'starting' && hasCompletedStartingLaunch(adapter)) return 'idle';
    if (adapterStatus && adapterStatus !== 'idle') return adapterStatus;
    if (adapterStatus !== 'idle') return adapterStatus;

    if (typeof adapter?.getScriptParsedStatus !== 'function') return adapterStatus;
    try {
        const parsedStatus = adapter.getScriptParsedStatus();
        const parsedRawStatus = normalizeAgentStatus(parsedStatus?.status);
        if (BUSY_AGENT_STATUSES.has(parsedRawStatus) && !shouldSuppressStaleParsedBusyStatus(adapterStatus, parsedStatus, adapter)) {
            return parsedRawStatus;
        }
    } catch {
        return adapterStatus;
    }
    return adapterStatus;
}

export async function waitForZeroMessageStartingLaunch(adapter: any): Promise<boolean> {
    try {
        if (!hasZeroMessageStartingLaunch(adapter)) return false;
    } catch {
        return false;
    }
    await new Promise(resolve => setTimeout(resolve, ZERO_MESSAGE_STARTING_SEND_WAIT_MS));
    try {
        return hasZeroMessageStartingLaunch(adapter);
    } catch {
        return false;
    }
}
