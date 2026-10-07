/**
 * "Start assistant" (design 2026-10-07-assistant-layer.md §4.7): offered while
 * no assistant session exists and some machine can host one. Sends
 * `launch_assistant {cliType}` through the dashboard's normal command transport
 * (standalone REST/WS, cloud P2P) — the daemon is idempotent, so a double click
 * or a race with another dashboard returns the live session instead of a second one.
 *
 * The main click launches the default target (the remembered choice when still
 * eligible, else claude-cli, else the first eligible CLI); `start(target)` from
 * the dropdown launches that CLI/machine and remembers it (localStorage).
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { DaemonData } from '../types'
import type { ActiveConversation } from '../components/dashboard/types'
import {
    LAUNCH_ASSISTANT_COMMAND,
    readAssistantLaunchChoice,
    resolveAssistantLaunchOptions,
    shouldOfferStartAssistant,
    writeAssistantLaunchChoice,
    type AssistantLaunchTarget,
    type AssistantMachineOption,
} from '../components/dashboard/assistant-session'

interface UseStartAssistantOptions {
    machineEntries: DaemonData[]
    conversations: ReadonlyArray<ActiveConversation>
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
}

export interface StartAssistantState {
    visible: boolean
    pending: boolean
    error: string | null
    /** What the main click launches. */
    defaultTarget: AssistantLaunchTarget | null
    /** Machines and their CLIs for the dropdown (ineligible CLIs included, flagged). */
    machines: AssistantMachineOption[]
    /** Launch `target` (a dropdown choice, remembered) or the default target. */
    start: (target?: AssistantLaunchTarget) => Promise<void>
}

export function useStartAssistant({ machineEntries, conversations, sendDaemonCommand }: UseStartAssistantOptions): StartAssistantState {
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [choice, setChoice] = useState(() => readAssistantLaunchChoice())
    const inFlight = useRef(false)
    const options = useMemo(() => resolveAssistantLaunchOptions(machineEntries, choice), [machineEntries, choice])
    const defaultTarget = options.defaultTarget
    const visible = shouldOfferStartAssistant(conversations, defaultTarget)

    const start = useCallback(async (picked?: AssistantLaunchTarget) => {
        const target = picked || defaultTarget
        if (!target || inFlight.current) return
        if (picked) {
            writeAssistantLaunchChoice(picked)
            setChoice({ machineId: picked.machineId, cliType: picked.cliType })
        }
        inFlight.current = true
        setPending(true)
        setError(null)
        try {
            const res: any = await sendDaemonCommand(target.machineId, LAUNCH_ASSISTANT_COMMAND, { cliType: target.cliType })
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
