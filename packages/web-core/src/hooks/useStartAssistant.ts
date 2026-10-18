import { removeRetiredRoleLaunchMemory } from '../utils/retired-role-launch-memory'
/** Assistant host selection and launch. The main click sends no role axes;
 * the daemon resolves its saved default. Explicit picks affect one launch only. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DaemonData } from '../types'
import type { ActiveConversation } from '../components/dashboard/types'
import type { MeshEntry } from '../pages/repo-mesh/types'
import type { RepoMeshDaemonEntry } from '../context/RepoMeshContext'
import { mergeMeshListAnswers } from '../pages/repo-mesh/useMeshList'
import { resolveMeshHostDaemonId } from '../pages/repo-mesh/host-seed'
import {
    LAUNCH_ASSISTANT_COMMAND,
    assistantLaunchArgs,
    countHostedProjectsByMachine,
    hasAssistantConversation,
    resolveAssistantLaunchOptions,
    shouldOfferStartAssistant,
    type AssistantHostedProjectCounts,
    type AssistantLaunchTarget,
    type AssistantMachineOption,
} from '../components/dashboard/assistant-session'

type SendDaemonCommand = (id: string, type: string, data?: Record<string, unknown>) => Promise<any>

function isOnline(machine: DaemonData): boolean {
    const status = String(machine.status || '').toLowerCase()
    return status !== 'offline' && status !== 'disconnected'
}

/**
 * Hosted-project counts per machine: ask every online machine for `list_meshes`,
 * merge the answers host-first (one record per mesh, as the mesh page does) and
 * resolve each mesh's host daemon from its authoritative host pin. A machine
 * that fails to answer contributes nothing; an unresolved host counts nowhere.
 */
export async function fetchHostedProjectCounts(
    machines: ReadonlyArray<DaemonData>,
    sendDaemonCommand: SendDaemonCommand,
): Promise<Record<string, number>> {
    const daemons = machines.filter(m => !!m?.id) as unknown as RepoMeshDaemonEntry[]
    const online = machines.filter(m => !!m?.id && isOnline(m))
    const answers = await Promise.all(online.map(async machine => {
        try {
            const res: any = await sendDaemonCommand(machine.id, 'list_meshes', {})
            const result = res?.result && typeof res.result === 'object' && !Array.isArray(res.result) ? res.result : res
            if (result?.success === false) return null
            const meshes = (Array.isArray(result?.meshes) ? result.meshes : []).filter((m: any) => m && typeof m.id === 'string' && m.id)
            return { daemonId: machine.id, meshes: meshes as MeshEntry[] }
        } catch {
            return null
        }
    }))
    const merged = mergeMeshListAnswers(answers.filter((a): a is { daemonId: string; meshes: MeshEntry[] } => !!a), daemons)
    return countHostedProjectsByMachine(merged.map(mesh => resolveMeshHostDaemonId(mesh as any, daemons)), machines)
}

/** Fetch hosted-project counts once per online-machine set, only while `enabled`. */
function useHostedProjectCounts(
    machineEntries: DaemonData[],
    sendDaemonCommand: SendDaemonCommand,
    enabled: boolean,
): AssistantHostedProjectCounts | null {
    const [counts, setCounts] = useState<{ key: string; counts: Record<string, number> } | null>(null)
    const key = useMemo(
        () => machineEntries.filter(m => !!m?.id && isOnline(m)).map(m => m.id).sort().join('|'),
        [machineEntries],
    )
    const machinesRef = useRef(machineEntries)
    machinesRef.current = machineEntries
    const sendRef = useRef(sendDaemonCommand)
    sendRef.current = sendDaemonCommand
    useEffect(() => {
        if (!enabled || !key || counts?.key === key) return
        let cancelled = false
        void fetchHostedProjectCounts(machinesRef.current, sendRef.current).then(next => {
            if (!cancelled) setCounts({ key, counts: next })
        })
        return () => { cancelled = true }
    }, [enabled, key, counts?.key])
    return counts?.counts ?? null
}

interface UseStartAssistantOptions {
    machineEntries: DaemonData[]
    conversations: ReadonlyArray<ActiveConversation>
    sendDaemonCommand: SendDaemonCommand
}

export interface StartAssistantState {
    visible: boolean
    pending: boolean
    error: string | null
    /** What the main click launches. */
    defaultTarget: AssistantLaunchTarget | null
    /** Machines and their CLIs for the dropdown (ineligible CLIs included, flagged). */
    machines: AssistantMachineOption[]
    /** Launch an explicit dropdown choice or ask the daemon for its default. */
    start: (target?: AssistantLaunchTarget) => Promise<void>
}

export function useStartAssistant({ machineEntries, conversations, sendDaemonCommand }: UseStartAssistantOptions): StartAssistantState {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const inFlight = useRef(false)
    useEffect(() => { removeRetiredRoleLaunchMemory() }, [])
    const hostedCounts = useHostedProjectCounts(machineEntries, sendDaemonCommand, !hasAssistantConversation(conversations))
    const options = useMemo(
        () => resolveAssistantLaunchOptions(machineEntries, hostedCounts),
        [machineEntries, hostedCounts],
    )
    // Machine ranking selects only the host. The daemon selects the role's CLI;
    // the display is a read-only snapshot, never a remembered launch preference.
    const [savedTarget, setSavedTarget] = useState<AssistantLaunchTarget | null>(null)
    const defaultMachineId = options.defaultTarget?.machineId
    useEffect(() => {
        setSavedTarget(null)
        if (!defaultMachineId) return
        let cancelled = false
        void sendDaemonCommand(defaultMachineId, 'launch_defaults_get', { role: 'assistant' }).then(raw => {
            const result = raw?.result || raw
            const selection = result?.roles?.assistant?.stored
            if (!cancelled && selection?.provider) setSavedTarget({ machineId: defaultMachineId,
                cliType: selection.provider, model: selection.model, thinkingLevel: selection.thinkingLevel })
        }).catch(() => { /* The launch command surfaces an unavailable store. */ })
        return () => { cancelled = true }
    }, [defaultMachineId, sendDaemonCommand])
    const defaultTarget = savedTarget?.machineId === defaultMachineId ? savedTarget : options.defaultTarget
    const visible = shouldOfferStartAssistant(conversations, defaultTarget)

    const start = useCallback(async (picked?: AssistantLaunchTarget) => {
        const target = picked || defaultTarget
        if (!target || inFlight.current) return
        inFlight.current = true
        setPending(true)
        setError(null)
        try {
            const res: any = await sendDaemonCommand(target.machineId, LAUNCH_ASSISTANT_COMMAND, picked ? assistantLaunchArgs(picked) : {})
            const result = res?.result || res
            if (res?.success === false || result?.success === false) {
                setError(String(result?.error || res?.error || result?.code || 'launch_assistant failed'))
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            inFlight.current = false
            setPending(false)
        }
    }, [sendDaemonCommand, defaultTarget])

    return { visible, pending, error, defaultTarget, machines: options.machines, start }
}
