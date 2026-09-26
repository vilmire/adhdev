/**
 * useBlueprintGateCommands — the D5 gate verbs (Release / Abandon / Extend
 * 24h) shared by the Blueprint LIST rows and the Blueprint GRAPH gate panel.
 * One implementation, so both surfaces send the same daemon commands
 * (mesh_graph_gate_release / abandon / extend) with the same payloads
 * (blueprintViewModel builders), the same Extend confirm dialog, and the same
 * no-optimistic-UI refresh contract (onGatesChanged after every attempt).
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { unwrapDaemonCommandBody } from '../../utils/daemon-command-envelope'
import { buildGateAbandonArgs, buildGateExtendArgs, buildGateReleaseArgs } from './blueprintViewModel'
import type { GateActionHandlers } from './MeshBlueprintRow'

export interface BlueprintGateCommandOptions {
    daemonId?: string | null
    meshId?: string
    sendDaemonCommand?: ((id: string, type: string, data?: Record<string, unknown>) => Promise<any>) | null
    /** Called after a gate command RESOLVES (success or failure attempted). */
    onGatesChanged?: () => void
}

export function useBlueprintGateCommands({ daemonId, meshId, sendDaemonCommand, onGatesChanged }: BlueprintGateCommandOptions) {
    const { t } = useTranslation('common')
    /** Gate (by caller key) with a command in flight — disables its buttons only. */
    const [busyGateKey, setBusyGateKey] = useState<string | null>(null)
    const { confirm, confirmDialog } = useConfirmDialog()
    const canCommand = Boolean(daemonId && meshId && sendDaemonCommand)

    /**
     * Send one gate command and refresh the graph list afterward. A
     * non-success envelope throws so GateActionsPanel shows it inline.
     */
    const sendGateCommand = useCallback(async (gateKey: string, commandType: string, args: Record<string, unknown>): Promise<void> => {
        if (!daemonId || !sendDaemonCommand) throw new Error(t('mesh.blueprint.gate.commandUnavailable'))
        setBusyGateKey(gateKey)
        try {
            const raw = await sendDaemonCommand(daemonId, commandType, args)
            const body = unwrapDaemonCommandBody<{ success?: boolean; error?: string }>(raw)
            if (!body || body.success === false) throw new Error(body?.error || `${commandType} failed`)
        } finally {
            setBusyGateKey(current => (current === gateKey ? null : current))
            onGatesChanged?.()
        }
    }, [daemonId, onGatesChanged, sendDaemonCommand, t])

    /** Handlers for one gate, or undefined when this surface cannot command. */
    const handlersFor = useCallback((gateKey: string, gateId: string | undefined, ref: string): GateActionHandlers | undefined => {
        if (!canCommand || !gateId) return undefined
        return {
            onRelease: (outcome, evidence) => sendGateCommand(gateKey, 'mesh_graph_gate_release', buildGateReleaseArgs(meshId!, gateId, outcome, evidence)),
            onAbandon: (reason) => sendGateCommand(gateKey, 'mesh_graph_gate_abandon', buildGateAbandonArgs(meshId!, gateId, reason)),
            onExtend: async () => {
                const ok = await confirm({
                    title: t('mesh.blueprint.gate.extendConfirmTitle', { ref }),
                    confirmLabel: t('mesh.blueprint.gate.extend24h'),
                })
                if (!ok) return
                await sendGateCommand(gateKey, 'mesh_graph_gate_extend', buildGateExtendArgs(meshId!, gateId))
            },
        }
    }, [canCommand, confirm, meshId, sendGateCommand, t])

    return { busyGateKey, confirmDialog, handlersFor, canCommand }
}
