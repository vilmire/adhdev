import type { DaemonData } from '../types'
import { buildDaemonUpgradePayload } from './daemon-update-policy'

export const DAEMON_UPGRADE_POLICY_UNAVAILABLE_MESSAGE =
    'Cannot update: node update policy unavailable; refresh and try again'

export interface DaemonUpgradeCommandResult {
    state: 'done' | 'error'
    message: string
}

type SendDaemonCommand = (id: string, type: string, data?: Record<string, unknown>) => Promise<any>

/**
 * Send a `daemon_upgrade` command for a machine, failing closed when the node's
 * server-pushed update policy doesn't resolve to an explicit channel: an empty
 * payload makes the daemon fall back to its saved config or 'stable', which can
 * silently downgrade the node and retarget it to another channel. Shared by the
 * mobile machine screen and the settings connected-machines section.
 */
export async function runDaemonUpgradeCommand(
    sendDaemonCommand: SendDaemonCommand,
    machineId: string,
    machineEntry: DaemonData | null | undefined,
): Promise<DaemonUpgradeCommandResult> {
    const payload = buildDaemonUpgradePayload(machineEntry)
    if (!payload) {
        return { state: 'error', message: DAEMON_UPGRADE_POLICY_UNAVAILABLE_MESSAGE }
    }
    try {
        const res: any = await sendDaemonCommand(machineId, 'daemon_upgrade', payload)
        if (res?.result?.alreadyLatest) {
            return { state: 'done', message: `Already on v${res?.result?.version || 'latest'}.` }
        }
        if (res?.result?.upgraded || res?.result?.success) {
            return { state: 'done', message: `Upgrade to v${res?.result?.version || 'latest'} started. Daemon is restarting…` }
        }
        return { state: 'error', message: res?.result?.error || 'Upgrade failed' }
    } catch (error) {
        return { state: 'error', message: error instanceof Error ? error.message : 'Upgrade failed' }
    }
}
