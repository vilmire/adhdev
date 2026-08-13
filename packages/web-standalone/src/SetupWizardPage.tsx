/**
 * SetupWizardPage — standalone host for the shared SetupWizard.
 *
 * Mirrors StandaloneRepoMeshProvider's wiring: sendCommand from
 * TransportContext, the single local daemon from BaseDaemonContext, identity
 * unwrap/normalize. No install/pair surface is injected — standalone always
 * has exactly one local daemon, so the zero-machine state cannot occur here.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    SetupWizard,
    STANDALONE_FEATURES,
    useTransport,
    useBaseDaemons,
    type RepoMeshDaemonEntry,
} from '@adhdev/web-core'

export default function SetupWizardPage() {
    const navigate = useNavigate()
    const { sendCommand } = useTransport()
    const { ides } = useBaseDaemons()

    const daemons: RepoMeshDaemonEntry[] = useMemo(
        () => (ides as any[])
            .filter(d => d.daemonMode || d.type === 'adhdev-daemon')
            .map(d => d as RepoMeshDaemonEntry),
        [ides],
    )

    return (
        <SetupWizard
            daemons={daemons}
            features={STANDALONE_FEATURES}
            sendCommand={sendCommand}
            unwrapResult={(raw: any) => raw}
            normalizeMesh={(raw: any) => raw}
            onClose={() => navigate('/mesh')}
        />
    )
}
