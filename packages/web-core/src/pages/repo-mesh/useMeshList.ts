/**
 * useMeshList — mesh CRUD state and actions
 *
 * Manages: meshes, selectedMeshId, loading/error, create/delete forms,
 * and daemon-picker state used during mesh creation.
 */
import { useState, useCallback, useMemo, useEffect } from 'react'
import {
    defaultProviderPriorityFromInventory,
    normalizeAvailableCliProviders,
    type AvailableCliProviderOption,
} from '../../utils/provider-priority'
import type { RepoMeshContextValue, RepoMeshDaemonEntry } from '../../context/RepoMeshContext'
import type { MeshEntry } from './types'

// Module-level mesh-list cache, keyed by the sorted daemon-id set the list was
// built from. Survives unmount/remount so re-entering the /mesh route (cloud)
// paints the last list instantly and freshens in the background instead of a
// 'Loading meshes...' cold paint. Mirrors the graph cache in useMeshGraph.ts.
const meshListCache = new Map<string, MeshEntry[]>()

/**
 * Outcome of the mesh-create sequence.
 *
 * `meshCreated` is the load-bearing field: it is true as soon as the daemon has
 * persisted the mesh, INDEPENDENT of whether the follow-up node attach worked. The
 * caller uses it to decide whether to refresh the list and close the form — see
 * runMeshCreateSequence's contract note.
 */
export interface MeshCreateOutcome {
    /** True once `create_mesh` succeeded — the mesh exists on the daemon. */
    meshCreated: boolean
    /** Id of the created mesh, when the daemon returned one. */
    meshId: string
    /** Fatal failure: nothing was created. Mutually exclusive with meshCreated. */
    error: string | null
    /** Non-fatal: mesh created, but attaching its first workspace failed. */
    warning: string | null
    /** The onboarding plan the daemon returned, for the caller to render. */
    plan: any
}

export interface RunMeshCreateSequenceOptions {
    targetDaemonId: string
    name: string
    repoRemoteUrl: string
    repoIdentity: string
    workspace: string
    /** Whether to attach the workspace as the first node after creating. */
    attachWorkspace: boolean
    machineId?: string
    providerPriority: string[]
    meshInventory: unknown
    sendCommand: RepoMeshContextValue['sendCommand']
    unwrapResult: RepoMeshContextValue['unwrapResult']
    /**
     * A plan_mesh_onboarding result already fetched for this exact workspace (the
     * live discovery preview shown while the form is open). When present, the
     * sequence reuses it instead of re-querying the daemon — the workspace/daemon
     * haven't changed since that fetch, so a second round-trip would just repeat
     * the same read-only probe invisibly (no loading indicator shown for it),
     * which is what produced the disorienting "looks good" → surprise error flip
     * when the plan turned out to target an already-existing mesh.
     */
    reusablePlan?: any
}

/**
 * Drive plan → create_mesh → add_mesh_node and report what actually happened.
 *
 * MESH-CREATE-LIST-REFRESH — the two writes have DIFFERENT failure semantics and must
 * not share one all-or-nothing failure path:
 *
 *   `create_mesh` persists the mesh synchronously and unconditionally (daemon-core
 *   mesh-config.ts createMesh → saveMeshConfig, no caching layer). Once it reports
 *   success the mesh EXISTS on the daemon — there is nothing the browser can roll
 *   back, and `list_meshes` reports it on the very next read.
 *
 *   `add_mesh_node` is a SEPARATE write that can legitimately fail against an
 *   already-created mesh: duplicate workspace, the 10-node cap, or the mesh-host
 *   mutation-owner gate (daemon-core commands/med-family/mesh-crud.ts).
 *
 * Treating an add failure as a create failure is what produced the reported bug: the
 * failure aborted the caller before it refreshed the list or closed the create form,
 * so the operator was left in the form looking at an error while the mesh they had
 * just created sat persisted on the daemon and missing from the on-screen list.
 *
 * Contract: whenever `meshCreated` is true the caller MUST refresh its list and close
 * the form, and surface `warning` separately rather than as a create failure. This
 * mirrors the MCP path, which already reports `add_current_error` while keeping the
 * create itself successful (mcp-server/src/tools/mesh-tools-crud.ts).
 */
export async function runMeshCreateSequence(opts: RunMeshCreateSequenceOptions): Promise<MeshCreateOutcome> {
    const { sendCommand, unwrapResult } = opts
    const base: MeshCreateOutcome = { meshCreated: false, meshId: '', error: null, warning: null, plan: null }
    try {
        const plan = opts.reusablePlan ?? unwrapResult(await sendCommand(opts.targetDaemonId, 'plan_mesh_onboarding', {
            workspace: opts.workspace || undefined,
            operation: 'auto',
            meshInventory: opts.meshInventory,
        }))
        base.plan = plan
        if (plan?.success === false) {
            return { ...base, error: `${plan.code || 'onboarding_blocked'}: ${plan.error}${plan.action ? ` ${plan.action}` : ''}` }
        }
        if (plan?.plan?.kind !== 'create_mesh_and_onboard') {
            return { ...base, error: plan?.plan?.summary || 'A compatible mesh already exists; add this workspace to it instead of creating a duplicate mesh.' }
        }
        const payload: any = { name: opts.name.trim() }
        if (opts.repoRemoteUrl || plan?.discovery?.origin?.urls?.[0]) payload.repoRemoteUrl = opts.repoRemoteUrl || plan.discovery.origin.urls[0]
        if (opts.repoIdentity || plan?.discovery?.repoIdentity) payload.repoIdentity = opts.repoIdentity || plan.discovery.repoIdentity
        if (plan?.discovery?.defaultBranch) payload.defaultBranch = plan.discovery.defaultBranch

        const raw = await sendCommand(opts.targetDaemonId, 'create_mesh', payload)
        const result = unwrapResult(raw)
        if (result?.success === false) return { ...base, error: result.error || 'Create failed' }

        // ─── The mesh is persisted from here on. Nothing below may turn this into a
        // failed create; the worst outcome is created-with-warning. ───
        const meshId = typeof result?.mesh?.id === 'string' ? result.mesh.id : ''
        const created: MeshCreateOutcome = { ...base, meshCreated: true, meshId }
        if (!meshId || !opts.attachWorkspace || !opts.workspace) return created

        try {
            const addRaw = await sendCommand(opts.targetDaemonId, 'add_mesh_node', {
                meshId,
                daemonId: opts.targetDaemonId,
                machineId: opts.machineId,
                workspace: plan?.discovery?.repoRoot || opts.workspace,
                repoRoot: plan?.discovery?.repoRoot,
                isLocalWorktree: plan?.discovery?.isLinkedWorktree === true,
                role: 'host',
                providerPriority: opts.providerPriority,
            })
            const addResult = unwrapResult(addRaw)
            if (addResult?.success === false) {
                return { ...created, warning: attachFailureMessage(addResult.error || 'add_mesh_node failed') }
            }
            return created
        } catch (addError: any) {
            return { ...created, warning: attachFailureMessage(addError?.message || 'add_mesh_node failed') }
        }
    } catch (e: any) {
        return { ...base, error: e?.message || 'Create failed' }
    }
}

function attachFailureMessage(detail: string): string {
    return `Mesh created, but attaching the workspace failed: ${detail}. Add the workspace from the mesh's node list.`
}

/**
 * Content equality for two mesh lists, so a reload that returns the same data
 * doesn't hand out a new array reference. `MeshEntry`/`MeshNode` are plain
 * JSON-serializable records straight off the wire (no functions, no cycles),
 * so a stringify compare is a safe deep-equality check here — the same
 * shortcut `daemonArraysEqual` avoids only because daemon entries carry
 * non-serializable fields; meshes don't.
 *
 * Without this, every loadMeshes() call produces a brand-new `meshes` array
 * even when nothing changed, which cascades into anything that takes `meshes`
 * as an effect dependency (e.g. the setup wizard's create-probe) re-running
 * for no reason — the "Checking the workspace..." flicker.
 */
export function meshesEqual(a: MeshEntry[], b: MeshEntry[]): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    return JSON.stringify(a) === JSON.stringify(b)
}

interface UseMeshListOptions {
    /**
     * Modal confirm injected by the page (useConfirmDialog.confirm). The
     * window.confirm this replaces (CONFIRM-MIGRATION leftover, owner repro
     * 2026-08-24: browsers that suppress native dialogs made Delete a silent
     * no-op) stays as the fallback for callers that don't inject one.
     */
    confirmAction?: (request: { title: string; description?: string; confirmLabel: string; cancelLabel?: string; tone?: 'default' | 'danger' }) => Promise<boolean>
    daemons: RepoMeshDaemonEntry[]
    primaryDaemonId: string
    sendCommand: RepoMeshContextValue['sendCommand']
    unwrapResult: RepoMeshContextValue['unwrapResult']
    normalizeMesh: RepoMeshContextValue['normalizeMesh']
    features: {
        createDaemonPicker: boolean
        addNodeDaemonPicker?: boolean
    }
    /**
     * Optional held-first background freshen for a daemon's metadata (workspaces,
     * availableProviders). When the create picker selects a daemon whose entry
     * lacks workspaces/providers, we render whatever is held and call this to
     * freshen in the background — no empty-state stall on the first paint.
     */
    loadDaemonMetadata?: (daemonId: string, opts?: { force?: boolean; minFreshMs?: number }) => void | Promise<unknown>
}

export function useMeshList({
    daemons,
    primaryDaemonId,
    sendCommand,
    unwrapResult,
    normalizeMesh,
    features,
    loadDaemonMetadata,
    confirmAction,
}: UseMeshListOptions) {
    // Cache key = the daemon set this list is scoped to. Computed eagerly so the
    // useState initializers can seed from the module cache on the very first render
    // (route re-entry) — no cold 'Loading meshes...' paint when we already have a
    // last-good list for these daemons.
    const initialDaemonIdsKey = daemons.map(d => d.id).filter(Boolean).sort().join(',')
    const [meshes, setMeshes] = useState<MeshEntry[]>(() => meshListCache.get(initialDaemonIdsKey) ?? [])
    const [selectedMeshId, setSelectedMeshId] = useState<string | null>(null)
    // Only show the blocking spinner when we have nothing cached to paint.
    const [loading, setLoading] = useState(() => !meshListCache.has(initialDaemonIdsKey))
    const [error, setError] = useState<string | null>(null)

    // Create form
    const [showCreate, setShowCreate] = useState(false)
    // In-flight guard for handleCreate. The create flow is a multi-command sequence
    // (plan → create_mesh → add_mesh_node) with awaits between each step, so a
    // double-click would start a SECOND create before the first persisted its mesh —
    // the daemon then holds two meshes for one operator intent, and the second call's
    // "already exists"/duplicate-workspace error is what the user sees.
    const [creating, setCreating] = useState(false)
    // Non-fatal create warning: the mesh WAS created but a follow-up step (attaching
    // the first workspace) failed. Kept separate from `error` so the create is not
    // reported as a failure it wasn't, and so the message is never silently dropped.
    const [createWarning, setCreateWarning] = useState<string | null>(null)
    const [createName, setCreateName] = useState('')
    const [createRepoIdentity, setCreateRepoIdentity] = useState('')
    const [createRepoRemoteUrl, setCreateRepoRemoteUrl] = useState('')

    // Cloud create extras
    const [newMeshDaemonId, setNewMeshDaemonId] = useState('')
    const [newMeshWorkspace, setNewMeshWorkspace] = useState('')
    const [createOnboardingPlan, setCreateOnboardingPlan] = useState<any>(null)
    const [createPlanLoading, setCreatePlanLoading] = useState(false)

    // The daemon the create form targets. Cloud picks one explicitly; standalone has
    // exactly one, so fall back to it — otherwise standalone's workspace picker and
    // discovery probe have no daemon to read from and stay empty.
    const createTargetDaemonId = features.createDaemonPicker ? newMeshDaemonId : primaryDaemonId
    const selectedCreateDaemon = useMemo(
        () => daemons.find(d => d.id === createTargetDaemonId),
        [daemons, createTargetDaemonId],
    )
    const createPickerWorkspaces = selectedCreateDaemon?.workspaces || []
    const createPickerProviders: AvailableCliProviderOption[] = useMemo(
        () => normalizeAvailableCliProviders((selectedCreateDaemon as any)?.availableProviders || []),
        [selectedCreateDaemon],
    )

    // Held-first SWR: as soon as a daemon is picked in the create form, render its
    // held workspaces/providers (which may be empty on first sight) and freshen in
    // the background. This freshen is what populates the picker without blocking —
    // the previous code left the picker empty until an unrelated status snapshot
    // happened to arrive.
    useEffect(() => {
        if (!loadDaemonMetadata) return
        if (!createTargetDaemonId || !selectedCreateDaemon) return
        const missingMetadata = !selectedCreateDaemon.workspaces
            || !(selectedCreateDaemon as any).availableProviders
        if (!missingMetadata) return
        void Promise.resolve(loadDaemonMetadata(createTargetDaemonId, { minFreshMs: 30_000 })).catch(() => {})
    }, [loadDaemonMetadata, createTargetDaemonId, selectedCreateDaemon])

    // Git-aware dry-run preview for the selected workspace. The owning daemon
    // performs all discovery; the browser never tries to infer repository truth.
    useEffect(() => {
        if (!showCreate || !createTargetDaemonId || !newMeshWorkspace) {
            setCreateOnboardingPlan(null)
            // Also drop the loading flag: when the workspace empties while a
            // probe is in flight, the in-flight run's finally is skipped by
            // its `cancelled` guard and THIS branch is the only writer left —
            // without it the form strands on "Checking the workspace…" with
            // Create disabled (planLoading gates isMeshCreateDisabled).
            setCreatePlanLoading(false)
            return
        }
        let cancelled = false
        setCreatePlanLoading(true)
        void sendCommand(createTargetDaemonId, 'plan_mesh_onboarding', {
            workspace: newMeshWorkspace,
            operation: 'auto',
            meshInventory: meshes,
        }).then(raw => {
            if (cancelled) return
            const result = unwrapResult(raw)
            setCreateOnboardingPlan(result)
            if (result?.success) {
                setCreateRepoIdentity(current => current || result.discovery?.repoIdentity || '')
                setCreateRepoRemoteUrl(current => current || result.discovery?.origin?.urls?.[0] || result.discovery?.upstream?.urls?.[0] || '')
                setCreateName(current => current || `${String(result.discovery?.repoIdentity || result.discovery?.repoRoot || '').split(/[\\/]/).filter(Boolean).pop() || 'repo'}-mesh`)
            }
        }).catch(error => {
            if (!cancelled) setCreateOnboardingPlan({ success: false, error: error?.message || 'Git discovery failed' })
        }).finally(() => {
            if (!cancelled) setCreatePlanLoading(false)
        })
        return () => { cancelled = true }
    }, [showCreate, createTargetDaemonId, newMeshWorkspace, meshes, sendCommand, unwrapResult])

    // Stable identity for the daemon set so loadMeshes' useCallback (and the
    // effect that depends on it) is not re-created on every parent re-render just
    // because the `daemons` array reference changed. The list-load only cares about
    // WHICH daemons to query, not the array identity — a sorted id join captures that.
    const daemonIdsKey = useMemo(
        () => daemons.map(d => d.id).filter(Boolean).sort().join(','),
        [daemons],
    )

    // SWR: keep the currently-rendered meshes on screen and freshen in the
    // background — the blocking 'Loading meshes...' state is shown ONLY when we have
    // nothing to display (no cached list for this daemon set and caller didn't ask
    // for a background refresh). A caller passing refresh=true never blocks; a plain
    // load on a route re-entry that already has a cached list also doesn't block
    // (the seeded meshes are already painted). Mirrors useMeshGraph.ts's
    // `setGraphLoading(!refresh && prev===null)`.
    const loadMeshes = useCallback(async (refresh = false) => {
        const hasDisplayable = refresh || meshListCache.has(daemonIdsKey)
        setLoading(prev => (hasDisplayable ? prev : true))
        try {
            if (features.createDaemonPicker) {
                const results = await Promise.allSettled(daemons.map(async daemon => {
                    if (!daemon.id) return []
                    const raw = await sendCommand(daemon.id, 'list_meshes', {})
                    const result = unwrapResult(raw)
                    if (result?.success === false) throw new Error(result.error || 'Failed to load meshes')
                    return (Array.isArray(result?.meshes) ? result.meshes : [])
                        .map((m: any) => normalizeMesh(m, daemon.id))
                        .filter((m: any) => m.id)
                }))
                const byId = new Map<string, MeshEntry>()
                for (const r of results) {
                    if (r.status !== 'fulfilled') continue
                    for (const m of r.value) { if (!byId.has(m.id)) byId.set(m.id, m) }
                }
                const next = Array.from(byId.values())
                setMeshes(prev => (meshesEqual(prev, next) ? prev : next))
                meshListCache.set(daemonIdsKey, next)
                setError(null)
            } else {
                if (!primaryDaemonId) return
                const res: any = await sendCommand(primaryDaemonId, 'list_meshes')
                if (res?.success) {
                    const next = (res.meshes || []).map((m: any) => normalizeMesh(m, primaryDaemonId))
                    setMeshes(prev => (meshesEqual(prev, next) ? prev : next))
                    meshListCache.set(daemonIdsKey, next)
                    setError(null)
                } else {
                    setError(res?.error || 'Failed to load meshes')
                }
            }
        } catch (e: any) {
            setError(e?.message || 'Failed to load meshes')
        } finally {
            setLoading(false)
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [daemonIdsKey, primaryDaemonId, sendCommand, unwrapResult, normalizeMesh, features.createDaemonPicker])

    /**
     * Create a mesh, then attach the picked workspace as its first node.
     *
     * The sequence and its failure semantics live in `runMeshCreateSequence`; this is
     * the state binding. The key rule it enforces: `meshCreated` — not the absence of
     * a warning — decides whether the list refreshes and the form closes.
     */
    async function handleCreate() {
        const targetDaemonId = features.createDaemonPicker ? newMeshDaemonId : primaryDaemonId
        if (!targetDaemonId || !createName.trim()) return
        const remoteUrl = createRepoRemoteUrl.trim()
        const identity = createRepoIdentity.trim()
        const workspace = newMeshWorkspace.trim()
        // Repo identity comes from ONE of two places: git discovery on the picked
        // workspace, or the manual identity/URL fallback. Requiring the typed fields
        // unconditionally (the old rule) rejected the discovery flow the setup wizard
        // has always used, so a mesh creatable from /setup was refused here.
        if (!workspace && !remoteUrl && !identity) return
        // Double-submit guard: a second click must not start a parallel create.
        if (creating) return
        setCreating(true)
        setCreateWarning(null)
        try {
            const outcome = await runMeshCreateSequence({
                targetDaemonId,
                name: createName,
                repoRemoteUrl: remoteUrl,
                repoIdentity: identity,
                workspace,
                // Attach whenever we actually have a workspace to attach. Gating this on
                // the cloud-only daemon picker meant standalone created node-less meshes.
                attachWorkspace: !!workspace,
                machineId: selectedCreateDaemon?.machineId,
                providerPriority: defaultProviderPriorityFromInventory(createPickerProviders),
                meshInventory: meshes,
                sendCommand,
                unwrapResult,
                // Reuse the discovery plan already fetched for this workspace (the live
                // preview effect below) instead of silently re-querying it here — see
                // RunMeshCreateSequenceOptions.reusablePlan.
                reusablePlan: (!createPlanLoading && createOnboardingPlan) ? createOnboardingPlan : undefined,
            })
            if (outcome.plan !== null) setCreateOnboardingPlan(outcome.plan)
            if (outcome.warning) setCreateWarning(outcome.warning)
            if (!outcome.meshCreated) {
                setError(outcome.error || 'Create failed')
                return
            }
            setShowCreate(false)
            setCreateName('')
            setCreateRepoIdentity('')
            setCreateRepoRemoteUrl('')
            setNewMeshWorkspace('')
            await loadMeshes()
            if (outcome.meshId) setSelectedMeshId(outcome.meshId)
        } finally {
            setCreating(false)
        }
    }

    async function handleDelete(meshId: string) {
        const meshName = meshes.find(m => m.id === meshId)?.name || meshId
        const confirmed = confirmAction
            ? await confirmAction({
                title: 'Delete this mesh?',
                description: `"${meshName}" will be removed from this daemon. This cannot be undone.`,
                confirmLabel: 'Delete',
                tone: 'danger',
            })
            : confirm('Delete this mesh? This cannot be undone.')
        if (!confirmed) return
        const targetDaemonId = (meshes.find(m => m.id === meshId) as any)?.__sourceDaemonId || primaryDaemonId
        try {
            const raw = await sendCommand(targetDaemonId, 'delete_mesh', { meshId })
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Failed to delete')
            if (selectedMeshId === meshId) {
                setSelectedMeshId(null)
            }
            await loadMeshes()
        } catch (e: any) { setError(e?.message || 'Delete failed') }
    }

    function cancelCreate() {
        setShowCreate(false)
        setCreateName('')
        setCreateRepoIdentity('')
        setCreateRepoRemoteUrl('')
        setNewMeshWorkspace('')
        setCreateOnboardingPlan(null)
        setCreateWarning(null)
    }

    return {
        // state
        meshes,
        setMeshes,
        selectedMeshId,
        setSelectedMeshId,
        loading,
        error,
        setError,
        // create form
        showCreate,
        setShowCreate,
        creating,
        createWarning,
        setCreateWarning,
        createName,
        setCreateName,
        createRepoIdentity,
        setCreateRepoIdentity,
        createRepoRemoteUrl,
        setCreateRepoRemoteUrl,
        newMeshDaemonId,
        setNewMeshDaemonId,
        newMeshWorkspace,
        setNewMeshWorkspace,
        createPickerWorkspaces,
        createPickerProviders,
        createOnboardingPlan,
        createPlanLoading,
        // actions
        loadMeshes,
        handleCreate,
        handleDelete,
        cancelCreate,
    }
}
