import { useTranslation } from 'react-i18next'
import { Section } from '../../components/ui/Section'
import MeshCoordinatorManualSetupPanel from '../../components/MeshCoordinatorManualSetupPanel'
import { buildManualCoordinatorSetup } from '../../utils/mesh-coordinator-setup'
import type { AvailableCliAgent } from './types'

export function RepoMeshHermesMcpConfig({ meshId, availableCliAgents }: { meshId: string; availableCliAgents: AvailableCliAgent[] }) {
    const { t } = useTranslation()
    const hermesAgent = availableCliAgents.find(agent => {
        const id = agent.id.toLowerCase()
        return id === 'hermes-cli' || id.includes('hermes') || agent.name.toLowerCase().includes('hermes')
    })
    const manualSetup = buildManualCoordinatorSetup(hermesAgent?.meshCoordinator, { meshId })
    if (!manualSetup) return null
    return (
        <Section title={t('repoMesh.hermesMcp.title')} description={t('repoMesh.hermesMcp.description')}>
            <MeshCoordinatorManualSetupPanel setup={manualSetup} providerName={hermesAgent?.name || t('repoMesh.hermesMcp.fallbackProvider')} />
        </Section>
    )
}
