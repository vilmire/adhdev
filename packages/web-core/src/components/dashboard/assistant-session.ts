/**
 * The ONE place that decides "is this the personal assistant?" and how the
 * dashboard pins / starts it (design docs/design/2026-10-07-assistant-layer.md
 * §4.6–§4.7).
 *
 * The assistant is an ordinary CLI session chat — same pane, same transport —
 * marked by the daemon's `assistant` flag on the daemon.metadata lane (P2P /
 * local only), with `settings.assistant` (stamped by `launch_assistant`) as the
 * fallback for an older daemon that only ships settings. It is pinned first in
 * session lists and, when none exists, the dashboard offers "Start assistant",
 * which sends `launch_assistant` through the normal command transport.
 */
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import { isLaunchableMachineProvider } from '../../utils/provider-activation'

/** Brand label used as the assistant conversation's primary label. */
export const ASSISTANT_DISPLAY_LABEL = 'Assistant'
/** The daemon's default (DEFAULT_ASSISTANT_CLI_TYPE in daemon-core assistant-launch-plan.ts). */
export const DEFAULT_ASSISTANT_CLI_TYPE = 'claude-cli'
export const LAUNCH_ASSISTANT_COMMAND = 'launch_assistant'

type AssistantSource = { assistant?: boolean; settings?: Record<string, any> } | null | undefined

/** A daemon/session entry or conversation that is the assistant session. */
export function isAssistantSession(source: AssistantSource): boolean {
    if (!source) return false
    return source.assistant === true || source.settings?.assistant === true
}

export function isAssistantConversation(conversation: Pick<ActiveConversation, 'assistant' | 'settings'> | null | undefined): boolean {
    return isAssistantSession(conversation)
}

/** Sort key: assistant first (−1), everything else keeps its order (0 diff). */
export function compareAssistantFirst(
    left: Pick<ActiveConversation, 'assistant' | 'settings'>,
    right: Pick<ActiveConversation, 'assistant' | 'settings'>,
): number {
    return Number(isAssistantConversation(right)) - Number(isAssistantConversation(left))
}

export function hasAssistantConversation(conversations: ReadonlyArray<Pick<ActiveConversation, 'assistant' | 'settings'>>): boolean {
    return conversations.some(isAssistantConversation)
}

export interface AssistantLaunchTarget {
    machineId: string
    cliType: string
}

function isMachineOnline(machine: DaemonData): boolean {
    const status = String(machine.status || '').toLowerCase()
    return status !== 'offline' && status !== 'disconnected'
}

/**
 * Where "Start assistant" launches: the first online machine (in the caller's
 * order) with a launchable CLI, preferring claude-cli, then a CLI that declares
 * Repo Mesh coordinator (MCP) support, then any launchable CLI. Null when no
 * machine can host one — the affordance is then not shown.
 */
export function pickAssistantLaunchTarget(machines: ReadonlyArray<DaemonData>): AssistantLaunchTarget | null {
    for (const machine of machines) {
        if (!machine?.id || !isMachineOnline(machine)) continue
        const clis = (machine.availableProviders || []).filter(provider => isLaunchableMachineProvider(provider, 'cli'))
        if (clis.length === 0) continue
        const pick = clis.find(provider => provider.type === DEFAULT_ASSISTANT_CLI_TYPE)
            || clis.find(provider => !!provider.meshCoordinator)
            || clis[0]
        return { machineId: machine.id, cliType: pick.type }
    }
    return null
}

/** Show "Start assistant" only when no assistant session exists and a machine can host one. */
export function shouldOfferStartAssistant(
    conversations: ReadonlyArray<Pick<ActiveConversation, 'assistant' | 'settings'>>,
    target: AssistantLaunchTarget | null,
): boolean {
    return !!target && !hasAssistantConversation(conversations)
}
