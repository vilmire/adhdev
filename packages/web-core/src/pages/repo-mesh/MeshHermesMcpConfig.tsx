import { Section } from '../../components/ui/Section'
import MeshCoordinatorManualSetupPanel from '../../components/MeshCoordinatorManualSetupPanel'
import { buildManualCoordinatorSetup } from '../../utils/mesh-coordinator-setup'
import type { AvailableCliAgent } from './types'

export function RepoMeshHermesMcpConfig({ meshId, availableCliAgents }: { meshId: string; availableCliAgents: AvailableCliAgent[] }) {
    const hermesAgent = availableCliAgents.find(agent => {
        const id = agent.id.toLowerCase()
        return id === 'hermes-cli' || id.includes('hermes') || agent.name.toLowerCase().includes('hermes')
    })
    const manualSetup = buildManualCoordinatorSetup(hermesAgent?.meshCoordinator, { meshId })
    if (!manualSetup) return null
    return (
        <Section title="Hermes MCP Config" description="Hermes does not auto-import repo-local .mcp.json. Add this YAML under mcp_servers in Hermes config, then start a fresh Hermes session.">
            <MeshCoordinatorManualSetupPanel setup={manualSetup} providerName={hermesAgent?.name || 'Hermes CLI'} />
        </Section>
    )
}
