/**
 * SlotsStep — the setup wizard's per-node capability-slots step (repeatable:
 * one NodeSlotEditor per attached node).
 *
 * Reuses NodeSlotEditor unchanged. Its onSave does not write to the daemon —
 * it STAGES the slots into the wizard draft; the shell applies all staged
 * nodes at final commit (update_mesh_node, wizardCommit.ts). Skipping the step
 * leaves every node's existing slots (or the legacy-routing fallback) intact.
 */
import { useTranslation } from 'react-i18next'
import type { NodeCapabilitySlot } from '@adhdev/mesh-shared'
import NodeSlotEditor from '../../pages/repo-mesh/NodeSlotEditor'
import type { MeshNode } from '../../pages/repo-mesh/types'
import type { AvailableCliProviderOption } from '../../utils/provider-priority'

export interface SlotsStepProps {
    /** Nodes of the wizard's target mesh (post step-1 attach). */
    nodes: MeshNode[]
    /** Detected CLI providers per node id (node's own daemon inventory). */
    providersByNodeId: Record<string, AvailableCliProviderOption[]>
    /** Staged slots per node id (edited in this session, not yet committed). */
    stagedSlots: Record<string, NodeCapabilitySlot[]>
    /** Stage a node's slots into the wizard draft. */
    onStageSlots: (nodeId: string, slots: NodeCapabilitySlot[]) => void
    /** Display label per node id (machine nickname/host fallback). */
    nodeLabel: (node: MeshNode) => string
}

export default function SlotsStep({ nodes, providersByNodeId, stagedSlots, onStageSlots, nodeLabel }: SlotsStepProps) {
    const { t } = useTranslation('common')

    if (nodes.length === 0) {
        return (
            <div className="flex flex-col gap-3">
                <div>
                    <h3 className="text-sm font-semibold text-text-primary">{t('setupWizard.slots.title')}</h3>
                    <p className="mt-1 text-2xs leading-relaxed text-text-muted">
                        {t('setupWizard.slots.description')}
                    </p>
                </div>
                <p className="text-2xs text-text-muted">{t('setupWizard.slots.empty')}</p>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-3">
            <div>
                <h3 className="text-sm font-semibold text-text-primary">{t('setupWizard.slots.title')}</h3>
                <p className="mt-1 text-2xs leading-relaxed text-text-muted">
                    {t('setupWizard.slots.description')}
                </p>
            </div>

            {nodes.map(node => {
                const staged = stagedSlots[node.id]
                return (
                    <div key={node.id} className="rounded-lg border border-border-subtle bg-bg-secondary/40 px-3 py-2.5">
                        <div className="mb-2 flex items-center gap-2">
                            <span className="text-[13px] font-medium text-text-primary">{nodeLabel(node)}</span>
                            <span className="truncate text-2xs text-text-muted">{node.workspace}</span>
                            {staged && (
                                <span className="ml-auto rounded-full border border-accent-primary/40 bg-accent-primary/10 px-1.5 py-0.5 text-3xs font-medium text-accent-primary">
                                    {t('setupWizard.staged')}
                                </span>
                            )}
                        </div>
                        <NodeSlotEditor
                            slots={staged ?? node.policy?.slots ?? []}
                            availableProviders={providersByNodeId[node.id] || []}
                            onSave={slots => onStageSlots(node.id, slots)}
                        />
                    </div>
                )
            })}

            <p className="text-3xs leading-relaxed text-text-muted">
                {t('setupWizard.stagedNote')}
            </p>
        </div>
    )
}
