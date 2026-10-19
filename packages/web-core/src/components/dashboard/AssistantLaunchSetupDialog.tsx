import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DaemonData } from '../../types'
import LaunchDefaultsCard from '../../pages/machine/LaunchDefaultsCard'
import type { LaunchDefaultSelectionView } from '../../pages/machine/launchDefaults'
import Dialog from '../ui/Dialog'
import type { AssistantLaunchTarget } from './assistant-session'

/** First launch after upgrading: let the owner explicitly save the new default. */
export default function AssistantLaunchSetupDialog({ machine, sendDaemonCommand, onClose, onStart }: {
    machine: DaemonData
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onClose: () => void
    onStart: (target: AssistantLaunchTarget) => void
}) {
    const { t } = useTranslation('common')
    const [saved, setSaved] = useState<LaunchDefaultSelectionView | null>(null)
    return (
        <Dialog open onClose={onClose} size="lg" title={t('machine.launchDefaults.setupTitle')}
            footer={<button type="button" className="btn btn-primary" disabled={!saved}
                onClick={() => {
                    if (saved) onStart({ machineId: machine.id, cliType: saved.provider,
                        ...(saved.model ? { model: saved.model } : {}),
                        ...(saved.thinkingLevel ? { thinkingLevel: saved.thinkingLevel } : {}) })
                }}>{t('dashboard.assistant.start')}</button>}>
            <LaunchDefaultsCard machineId={machine.id} providers={machine.availableProviders || []}
                role="assistant" sendDaemonCommand={sendDaemonCommand}
                onSaved={(_role, selection) => setSaved(selection)} />
        </Dialog>
    )
}
