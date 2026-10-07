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
 * which sends `launch_assistant` through the normal command transport. Its
 * dropdown lets the person pick the CLI (and machine) plus the model and
 * thinking level the CLI advertises; eligibility per CLI is
 * the daemon's own answer (`availableProviders[].assistant`, computed by the
 * same planner `launch_assistant` runs), so the picker never offers a CLI the
 * verb would refuse.
 */
import { daemonIdsEquivalent } from '@adhdev/mesh-shared'
import type { DaemonData } from '../../types'
import type { ActiveConversation } from './types'
import { isLaunchableMachineProvider } from '../../utils/provider-activation'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import { modelOptionsForProvider, thinkingOptionsForProvider } from '../../utils/provider-priority'

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

/**
 * Per-surface memory for pinning the assistant tab first exactly once (dock
 * panels, pane-group tab order). `fresh` = tab keys this surface opened itself
 * (a tab restored from a stored layout is never fresh, so a stored drag order
 * stands); `pinned` = assistant tabs already moved to the front, after which
 * the person's own drag order wins.
 */
export interface AssistantTabPinState {
    fresh: Set<string>
    pinned: Set<string>
}

export function createAssistantTabPinState(): AssistantTabPinState {
    return { fresh: new Set(), pinned: new Set() }
}

/**
 * Tab keys to move to the front now: fresh tabs identified as the assistant
 * that were not pinned yet — marked pinned on return. A fresh tab stays
 * pinnable until it is identified, because the flag can arrive after the tab:
 * in the cloud the session first lands from the server-WS routing meta, which
 * carries no `assistant` / `settings`, and the P2P daemon.metadata lane brings
 * the flag later.
 */
export function takeAssistantTabsToPin(
    conversations: ReadonlyArray<Pick<ActiveConversation, 'tabKey' | 'assistant' | 'settings'>>,
    state: AssistantTabPinState,
): string[] {
    const out: string[] = []
    for (const conversation of conversations) {
        const key = conversation.tabKey
        if (!state.fresh.has(key) || state.pinned.has(key) || !isAssistantConversation(conversation)) continue
        state.pinned.add(key)
        state.fresh.delete(key)
        out.push(key)
    }
    return out
}

export interface AssistantLaunchTarget {
    machineId: string
    cliType: string
    /** One of the CLI's advertised `modelOptions` (absent = the CLI's own default). */
    model?: string
    /** One of the CLI's advertised `thinkingLevelOptions` (absent = the CLI's own default). */
    thinkingLevel?: string
}

/** One CLI the assistant picker lists for a machine (eligibility from the daemon's `availableProviders[].assistant`). */
export interface AssistantCliOption {
    cliType: string
    label: string
    /** `launch_assistant` would accept it. An older daemon without the field: assumed true (the daemon still decides). */
    supported: boolean
    /** Daemon refusal reason (unsupported only). */
    reason?: string
    /** Tool limit held only by the system prompt (every CLI but claude-cli) — the picker says "no tool lock". */
    promptOnly: boolean
    /** Advisory model list (manifest `modelOptions`); empty = no model picker. */
    modelOptions: string[]
    /**
     * Advisory thinking levels (manifest `thinkingLevelOptions`); empty = no
     * thinking picker. Deliberately NO low/medium/high fallback (unlike the
     * new-session dialog): a manifest lists levels exactly when it declares
     * `thinkingLaunchArgs`, and a level sent to a CLI without them is dropped
     * by the daemon with a warning.
     */
    thinkingLevelOptions: string[]
}

export interface AssistantMachineOption {
    machineId: string
    label: string
    clis: AssistantCliOption[]
    /** Projects (meshes) this machine hosts — the only ones its assistant can route work to. */
    hostedProjects: number
}

/** Hosted-project count per machine id (from {@link countHostedProjectsByMachine}). */
export type AssistantHostedProjectCounts = Readonly<Record<string, number>>

export interface AssistantLaunchOptions {
    machines: AssistantMachineOption[]
    /** What the main "Start assistant" click launches. */
    defaultTarget: AssistantLaunchTarget | null
}

function isMachineOnline(machine: DaemonData): boolean {
    const status = String(machine.status || '').toLowerCase()
    return status !== 'offline' && status !== 'disconnected'
}

function cliOption(provider: NonNullable<DaemonData['availableProviders']>[number]): AssistantCliOption {
    const eligibility = provider.assistant
    return {
        cliType: provider.type,
        label: provider.displayName || provider.name || provider.type,
        supported: eligibility ? eligibility.supported === true : true,
        ...(eligibility && !eligibility.supported && eligibility.reason ? { reason: eligibility.reason } : {}),
        promptOnly: eligibility ? eligibility.toolRestriction === 'prompt_only' : false,
        modelOptions: modelOptionsForProvider([provider], provider.type),
        thinkingLevelOptions: thinkingOptionsForProvider([provider], provider.type),
    }
}

/**
 * The launch target for `cli` on `machineId` with a model / thinking level kept
 * only while the CLI still advertises it (a remembered value from a manifest
 * that has since dropped it falls back to the CLI default).
 */
export function assistantLaunchTargetFor(
    machineId: string,
    cli: Pick<AssistantCliOption, 'cliType' | 'modelOptions' | 'thinkingLevelOptions'>,
    picked?: { model?: string; thinkingLevel?: string } | null,
): AssistantLaunchTarget {
    const model = picked?.model && cli.modelOptions.includes(picked.model) ? picked.model : undefined
    const thinkingLevel = picked?.thinkingLevel && cli.thinkingLevelOptions.includes(picked.thinkingLevel) ? picked.thinkingLevel : undefined
    return { machineId, cliType: cli.cliType, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) }
}

/** `launch_assistant` args for a target (the daemon applies model / thinking at launch). */
export function assistantLaunchArgs(target: AssistantLaunchTarget): Record<string, string> {
    return {
        cliType: target.cliType,
        ...(target.model ? { model: target.model } : {}),
        ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}),
    }
}

/**
 * How many projects (meshes) each machine hosts, keyed by the machine's own id.
 * `hostDaemonIds` holds one resolved host daemon id per mesh ('' = unresolved,
 * skipped); ids are matched with the canonical daemon-id comparison, so the
 * `daemon_mach_` / `mach_` / `standalone_` forms of one machine all count for it.
 */
export function countHostedProjectsByMachine(
    hostDaemonIds: ReadonlyArray<string>,
    machines: ReadonlyArray<Pick<DaemonData, 'id'>>,
): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const hostId of hostDaemonIds) {
        if (!hostId) continue
        const machine = machines.find(m => !!m?.id && daemonIdsEquivalent(m.id, hostId))
        if (machine) counts[machine.id] = (counts[machine.id] || 0) + 1
    }
    return counts
}

/**
 * Every online machine with a launchable (enabled) CLI, each listing its CLIs:
 * eligible ones first (claude-cli leading), then the ineligible ones the picker
 * shows disabled with their reason. Machines are ordered by how many projects
 * they host (most first; ties keep the caller's order) — an assistant can only
 * route work to projects hosted on its own daemon (`project_hosted_elsewhere`).
 */
export function listAssistantLaunchMachines(
    machines: ReadonlyArray<DaemonData>,
    hostedCounts?: AssistantHostedProjectCounts | null,
): AssistantMachineOption[] {
    const out: AssistantMachineOption[] = []
    for (const machine of machines) {
        if (!machine?.id || !isMachineOnline(machine)) continue
        const clis = (machine.availableProviders || [])
            .filter(provider => isLaunchableMachineProvider(provider, 'cli'))
            .map(cliOption)
        if (clis.length === 0) continue
        const rank = (o: AssistantCliOption) => (o.supported ? 0 : 2) + (o.cliType === DEFAULT_ASSISTANT_CLI_TYPE ? 0 : 1)
        clis.sort((a, b) => rank(a) - rank(b))
        out.push({
            machineId: machine.id,
            label: getMachineDisplayName(machine, { fallbackId: machine.id }),
            clis,
            hostedProjects: hostedCounts?.[machine.id] || 0,
        })
    }
    // Array.prototype.sort is stable: equal counts keep the caller's order.
    return out.sort((a, b) => b.hostedProjects - a.hostedProjects)
}

/**
 * Where the main "Start assistant" click launches: the remembered choice when
 * that machine is still listed and the CLI still eligible, else the first
 * machine — the one hosting the most projects, ties in the caller's order —
 * with an eligible CLI: claude-cli when eligible, else its first eligible CLI.
 * Null when no machine can host one — the affordance is then not shown.
 */
export function pickAssistantLaunchTarget(
    machines: ReadonlyArray<DaemonData>,
    preferred?: Partial<AssistantLaunchTarget> | null,
    hostedCounts?: AssistantHostedProjectCounts | null,
): AssistantLaunchTarget | null {
    return resolveAssistantLaunchOptions(machines, preferred, hostedCounts).defaultTarget
}

export function resolveAssistantLaunchOptions(
    machines: ReadonlyArray<DaemonData>,
    preferred?: Partial<AssistantLaunchTarget> | null,
    hostedCounts?: AssistantHostedProjectCounts | null,
): AssistantLaunchOptions {
    const list = listAssistantLaunchMachines(machines, hostedCounts)
    const eligible = (m: AssistantMachineOption, cliType?: string) => m.clis.find(c => c.supported && (!cliType || c.cliType === cliType))
    if (preferred?.cliType) {
        const candidates = preferred.machineId ? list.filter(m => m.machineId === preferred.machineId) : list
        for (const m of candidates) {
            const cli = eligible(m, preferred.cliType)
            if (cli) return { machines: list, defaultTarget: assistantLaunchTargetFor(m.machineId, cli, preferred) }
        }
    }
    for (const m of list) {
        const cli = eligible(m)
        if (cli) return { machines: list, defaultTarget: assistantLaunchTargetFor(m.machineId, cli) }
    }
    return { machines: list, defaultTarget: null }
}

/** localStorage key for the last CLI (and machine, model, thinking level) the picker launched. */
export const ASSISTANT_LAUNCH_CHOICE_STORAGE_KEY = 'adhdev_assistant_launch_choice'

export function readAssistantLaunchChoice(
    storage: Pick<Storage, 'getItem'> | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined,
): Partial<AssistantLaunchTarget> | null {
    try {
        const raw = storage?.getItem(ASSISTANT_LAUNCH_CHOICE_STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.cliType !== 'string' || !parsed.cliType) return null
        const opt = (key: 'machineId' | 'model' | 'thinkingLevel') => (typeof parsed[key] === 'string' && parsed[key] ? { [key]: parsed[key] as string } : {})
        return { cliType: parsed.cliType, ...opt('machineId'), ...opt('model'), ...opt('thinkingLevel') }
    } catch {
        return null
    }
}

export function writeAssistantLaunchChoice(
    target: AssistantLaunchTarget,
    storage: Pick<Storage, 'setItem'> | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined,
): void {
    try {
        storage?.setItem(ASSISTANT_LAUNCH_CHOICE_STORAGE_KEY, JSON.stringify({
            machineId: target.machineId,
            cliType: target.cliType,
            ...(target.model ? { model: target.model } : {}),
            ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}),
        }))
    } catch { /* storage unavailable — the choice is a convenience */ }
}

/** Show "Start assistant" only when no assistant session exists and a machine can host one. */
export function shouldOfferStartAssistant(
    conversations: ReadonlyArray<Pick<ActiveConversation, 'assistant' | 'settings'>>,
    target: AssistantLaunchTarget | null,
): boolean {
    return !!target && !hasAssistantConversation(conversations)
}
