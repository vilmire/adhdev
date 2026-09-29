// Dialog props, launch-kind availability, remembered-choice scopes and Phase E launch
// provenance helpers for the New Session dialog.
import type { DaemonData } from '../../types'
import type { LaunchResult, MeshLaunchOption } from '../../hooks/useDashboardCommandActions'
import type { BrowseDirectoryResult } from '../machine/workspaceBrowse'
import { isLaunchableMachineProvider } from '../../utils/provider-activation'

export type LaunchKind = 'ide' | 'cli'
export type WorkspaceLaunchMode = 'workspace' | 'mesh'

export function isLaunchKindAvailable(machine: DaemonData | undefined, kind: LaunchKind): boolean {
    if (!machine) return false
    if (kind === 'ide') return (machine.detectedIdes?.length || 0) > 0
    return (machine.availableProviders || []).some(provider => isLaunchableMachineProvider(provider, kind))
}

export function getDefaultLaunchKind(machine: DaemonData | undefined) {
    if (!machine) return null
    if (isLaunchKindAvailable(machine, 'cli')) return 'cli' as const
    if (isLaunchKindAvailable(machine, 'ide')) return 'ide' as const
    return null
}

// Remembered-choice scopes (localStorage, see utils/remembered-choice.ts).
// Written on a successful launch; read once per dialog open and applied only
// where the stored value still exists in the current option lists (fail-open).
export const REMEMBER_SCOPE_DIALOG = 'new-session-dialog'
export const REMEMBER_SCOPE_WORKSPACE = 'new-session-workspace'
export const REMEMBER_SCOPE_MESH = 'new-session-mesh'

/**
 * Phase E launch provenance for the model / thinking-level fields: where the
 * value in the field came from. Sent to the daemon as `modelSource` /
 * `thinkingLevelSource` (mesh-shared `ModelAxisSource` members), only alongside
 * a non-empty value — an empty field means "provider default", which the daemon
 * resolves and labels itself.
 */
export type LaunchValueSource = 'user' | 'remembered'

export interface LaunchValueChoice {
    value: string
    source: LaunchValueSource | null
}

export const EMPTY_LAUNCH_VALUE_CHOICE: LaunchValueChoice = { value: '', source: null }

export function toLaunchValueChoice(value: string, source: LaunchValueSource): LaunchValueChoice {
    return value ? { value, source } : EMPTY_LAUNCH_VALUE_CHOICE
}

export function launchValueSources(
    model: LaunchValueChoice,
    thinking: LaunchValueChoice,
): { modelSource?: LaunchValueSource; thinkingLevelSource?: LaunchValueSource } {
    return {
        ...(model.value.trim() && model.source ? { modelSource: model.source } : {}),
        ...(thinking.value.trim() && thinking.source ? { thinkingLevelSource: thinking.source } : {}),
    }
}

export function isRememberedLaunchKind(value: string | undefined): value is LaunchKind {
    return value === 'cli' || value === 'ide'
}

export function normalizePath(path: string | null | undefined) {
    return String(path || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+$/, '')
        .toLowerCase()
}

export interface SavedSessionOption {
    id: string
    providerSessionId: string
    providerType: string
    providerName: string
    kind: 'cli'
    title: string
    workspace?: string | null
    summaryMetadata?: DaemonData['summaryMetadata']
    preview?: string
    messageCount: number
    firstMessageAt: number
    lastMessageAt: number
    canResume: boolean
}

export interface DashboardNewSessionDialogProps {
    machines: DaemonData[]
    ides: DaemonData[]
    onClose: () => void
    onBrowseDirectory: (machineId: string, path: string) => Promise<BrowseDirectoryResult>
    onSaveWorkspace: (machineId: string, path: string) => Promise<{ ok: boolean; error?: string }>
    onLaunchIde: (machineId: string, ideType: string, opts?: { workspacePath?: string | null }) => Promise<{ ok: boolean; error?: string; code?: string }>
    onLaunchProvider: (
        machineId: string,
        kind: 'cli',
        providerType: string,
        opts?: {
            workspaceId?: string | null
            workspacePath?: string | null
            useHome?: boolean
            resumeSessionId?: string | null
            cliArgs?: string[]
            initialModel?: string | null
            initialThinkingLevel?: string | null
            /** Phase E: where initialModel came from (sent only with a value). */
            modelSource?: LaunchValueSource
            /** Phase E: where initialThinkingLevel came from (sent only with a value). */
            thinkingLevelSource?: LaunchValueSource
            settings?: {
                autoApprove?: boolean
                autoApproveMode?: string
            }
        },
    ) => Promise<{ ok: boolean; error?: string; code?: string }>
    onListMeshes: (machineId: string) => Promise<MeshLaunchOption[]>
    onLaunchMeshCoordinator: (
        machineId: string,
        meshId: string,
        cliType: string,
        opts?: {
            initialModel?: string | null
            initialThinkingLevel?: string | null
            modelSource?: LaunchValueSource
            thinkingLevelSource?: LaunchValueSource
            settings?: { autoApprove?: boolean; autoApproveMode?: string }
        },
    ) => Promise<LaunchResult>
    onListSavedSessions: (machineId: string, providerType: string) => Promise<SavedSessionOption[]>
    // Preselect target when the dialog is opened from somewhere that already
    // knows the machine/workspace (e.g. the machine page's workspace list).
    // The workspace id is applied once, as soon as the machine's workspace rows
    // are available — manual machine switches afterwards drop it.
    initialMachineId?: string | null
    initialWorkspaceId?: string | null
    // 'mesh' opens the dialog in coordinator mode; initialMeshWorkspacePath is
    // then matched (once, by normalized path) against the loaded mesh options
    // to preselect the mesh rooted at that workspace.
    initialLaunchMode?: WorkspaceLaunchMode | null
    initialMeshWorkspacePath?: string | null
}
