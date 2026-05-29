import type { DaemonData } from '../types'
import { getDaemonUpdateChannel, getDaemonUpdateTargetVersion } from './daemon-update-policy'
import { isVersionMismatch, isVersionUpdateRequired } from './version-update'

export interface DaemonUpdateStatusView {
    visible: boolean
    showButton: boolean
    title: string
    description: string
    buttonLabel: string
    targetVersion: string | null
    channel: 'stable' | 'preview' | null
    required: boolean
    tone: 'warn' | 'good' | 'info'
}

export function buildDaemonUpdateStatusView(daemon: DaemonData, fallbackVersion: string | null): DaemonUpdateStatusView {
    const channel = getDaemonUpdateChannel(daemon)
    const targetVersion = getDaemonUpdateTargetVersion(daemon, fallbackVersion)
    const mismatch = isVersionMismatch(daemon, targetVersion)
    const required = isVersionUpdateRequired(daemon, targetVersion)
    const buttonLabel = channel === 'preview' ? 'Update to preview' : 'Update daemon'

    if (mismatch) {
        return {
            visible: true,
            showButton: true,
            title: required ? 'Daemon update required' : 'Version mismatch detected',
            description: required
                ? 'This machine is on an incompatible daemon version. Update it before starting more sessions.'
                : channel === 'preview'
                    ? 'This machine can be upgraded to the current preview daemon without opening a remote shell.'
                    : 'This machine is running a different daemon version than the current app. Update it before starting more sessions.',
            buttonLabel,
            targetVersion,
            channel,
            required,
            tone: 'warn',
        }
    }

    if (channel === 'preview') {
        return {
            visible: true,
            showButton: false,
            title: targetVersion ? 'Preview daemon is up to date' : 'Preview update status unknown',
            description: targetVersion
                ? 'This machine is already on the current preview daemon target.'
                : 'The app is connected to preview, but the server did not report a preview target version yet.',
            buttonLabel,
            targetVersion,
            channel,
            required: false,
            tone: targetVersion ? 'good' : 'info',
        }
    }

    return {
        visible: false,
        showButton: false,
        title: '',
        description: '',
        buttonLabel,
        targetVersion,
        channel,
        required: false,
        tone: 'info',
    }
}
