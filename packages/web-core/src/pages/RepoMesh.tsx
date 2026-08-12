/**
 * RepoMesh — shared mesh management page (standalone + cloud)
 *
 * Platform-specific behaviour is injected via RepoMeshContext.
 * Standalone: wrap with StandaloneRepoMeshProvider (useTransport + useBaseDaemons).
 * Cloud:      wrap with a cloud provider that supplies multi-daemon loading,
 *             retry logic, coordinator targeting, and cloud-only UI sections.
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import { daemonIdsEquivalent } from '@adhdev/mesh-shared'

import AppPage from '../components/ui/AppPage'
import { IconMesh } from '../components/Icons'
import {
    defaultProviderPriorityFromInventory,
    normalizeAvailableCliProviders,
    type AvailableCliProviderOption,
} from '../utils/provider-priority'
import { useMeshGraphMetadataSubscription } from '../hooks/useMeshGraphMetadataSubscription'
import { useMeshStateRevisionRefresh } from '../hooks/useMeshStateRevisionRefresh'
import { useDaemonMetadataLoader } from '../hooks/useDaemonMetadataLoader'
import {
    useRepoMeshContext,
    type RepoMeshDaemonEntry,
} from '../context/RepoMeshContext'
import { MeshListView } from './repo-mesh/MeshListView'
import { MeshDetailView } from './repo-mesh/MeshDetailView'
import { useMeshList } from './repo-mesh/useMeshList'
import { useMeshNodeActions } from './repo-mesh/useMeshNodeActions'
import { useMeshQueue } from './repo-mesh/useMeshQueue'
import { useMeshGraph, getCachedMeshGraphStatus } from './repo-mesh/useMeshGraph'
import { resolveFirstSetupSeedDaemonId, readAuthoritativeMeshHostPin } from './repo-mesh/host-seed'
import {
    createGraphPollBackoffState,
    recordGraphSnapshot,
    resetGraphPollBackoff,
    resolvePollIntervalMs,
} from './repo-mesh/graph-poll-backoff'
import type { MeshNode, MeshQueueEntry, AvailableCliAgent } from './repo-mesh/types'

// Re-export types that cloud/standalone wrappers may reference
export type { MeshNode, MeshQueueEntry, AvailableCliAgent }
export { RepoMeshHermesMcpConfig } from './repo-mesh/MeshHermesMcpConfig'
export { getNodeActiveAssignments, describeNodeActiveAssignmentLabel } from './repo-mesh/MeshNodeList'

// Interval for the visibility-gated automatic graph revalidation. Node
// git/topology/health is pull-only (no server push), so without this the graph
// stays stale until a manual Refresh. Kept conservative: revalidation triggers
// a git probe that is heavy on win32, and we never want to pile reloads onto a
// coordinator's own in-flight refresh. Polling only runs while the tab is
// visible and the detail view is open.
//
// This is the FAST rate — deliberately unchanged from the original conservative
// choice (see commit 12d206c1). What changed is that it no longer runs forever:
// once several consecutive ticks report an identical graph (repo-mesh/graph-poll-
// backoff.ts), the effective interval backs off to BACKOFF_SLOW_INTERVAL_MS. Any
// detected change — or an explicit reload (mesh switch, manual Refresh) — snaps
// straight back to this rate, since that's exactly when the operator is watching
// for convergence.
const GRAPH_AUTO_REVALIDATE_INTERVAL_MS = 7000

// When the daemon pushes per-mesh revision counters (cloud), the graph refreshes
// event-driven on push, so the interval poll is demoted to a slow safety net that
// only catches a dropped/missed push. Kept well above the push cadence so it never
// competes with the event-driven path. Backoff (above) still applies on top of
// this — an already-slow cloud safety net can back off further when stable.
const GRAPH_PUSH_FALLBACK_INTERVAL_MS = 45000

// ─── Main page ───────────────────────────────────────────────────

export default function RepoMesh() {
    const ctx = useRepoMeshContext()
    const {
        sendCommand, sendData, daemons, userName,
        loadMeshStatus, launchCoordinator, loadLiveMesh,
        extractStatus, unwrapResult, normalizeMesh, normalizeNode,
        resolveCommandTarget, features,
        gateIncompleteGraph,
    } = ctx

    // Held-first background freshen for daemon metadata (workspaces/providers),
    // used by the create-mesh daemon picker so it never stalls on empty state.
    const loadDaemonMetadata = useDaemonMetadataLoader()

    // An ARBITRARY connected daemon — NOT an identity.
    //
    // On standalone there is exactly one daemon, so this is "the" daemon and using it
    // as a command target is correct. On cloud `daemons` is ordered by P2P arrival, so
    // index 0 is whichever peer connected first — it carries no meaning about which
    // machine owns anything. It is therefore legitimate ONLY as (a) a source of
    // provider/workspace inventory for pickers and (b) a connection-availability
    // fallback for commands that are not machine-specific.
    //
    // HOST-SELF-SYNTHESIS-GUARD: it must NEVER participate in resolving WHICH daemon
    // hosts a mesh, nor in targeting a coordinator launch — a launch permanently pins
    // the host, so a wrong target here pins the wrong machine forever. Host identity
    // comes from the persisted/daemon-resolved pin only (persistedHostInfo /
    // resolveFirstSetupSeedDaemonId), which stays unresolved rather than guessing.
    const primaryDaemon = daemons[0] as RepoMeshDaemonEntry | undefined
    const primaryDaemonId = primaryDaemon?.id || ''

    // Extract available CLI agents + providers from the primary daemon
    const availableCliAgents: AvailableCliAgent[] = useMemo(() => {
        const providers = (primaryDaemon as any)?.availableProviders || []
        return providers
            .filter((p: any) => p.category === 'cli')
            .map((p: any) => ({ id: p.type || p.id, name: p.displayName || p.name || p.type, meshCoordinator: p.meshCoordinator }))
    }, [primaryDaemon])

    const availableCliProviders: AvailableCliProviderOption[] = useMemo(
        () => normalizeAvailableCliProviders((primaryDaemon as any)?.availableProviders || []),
        [primaryDaemon],
    )

    // ─── Mesh list ───

    const {
        meshes, selectedMeshId, setSelectedMeshId,
        loading, error, setError,
        showCreate, setShowCreate,
        createName, setCreateName,
        createRepoIdentity, setCreateRepoIdentity,
        createRepoRemoteUrl, setCreateRepoRemoteUrl,
        newMeshDaemonId, setNewMeshDaemonId,
        newMeshWorkspace, setNewMeshWorkspace,
        createPickerWorkspaces, createOnboardingPlan, createPlanLoading,
        creating, createWarning, setCreateWarning,
        loadMeshes, handleCreate, handleDelete, cancelCreate,
    } = useMeshList({
        daemons,
        primaryDaemonId,
        sendCommand,
        unwrapResult,
        normalizeMesh,
        features,
        loadDaemonMetadata,
    })

    const selectedMesh = meshes.find(m => m.id === selectedMeshId) || null

    // ─── Graph ───

    const {
        meshGraphStatus, setMeshGraphStatus,
        graphLoading, graphError, setGraphError,
        loadGraph,
    } = useMeshGraph({ selectedMeshId, loadMeshStatus, extractStatus, normalizeNode, gateIncompleteGraph })

    // ─── Coordinator daemon (cloud) ───
    // The host is a fixed 1:1 pin per mesh — there is no UI picker for it. This
    // state is the resolved command/view-source target, derived (not user-chosen):
    // the persisted host normally, or a temporary re-bind override when the host
    // daemon is offline so commands still have a connected route. Kept here so it
    // can flow into useMeshNodeActions and useMeshQueue.
    const [coordinatorDaemonId, setCoordinatorDaemonId] = useState('')

    // Temporary command-routing override used ONLY while the pinned host daemon is
    // offline. This is NOT a host re-assignment — it just picks a connected daemon
    // to command over P2P until the host reconnects. Cleared once the host is back.
    const [hostRebindDaemonId, setHostRebindDaemonId] = useState('')

    // Resolved command/view-source daemon for THIS mesh.
    //
    // HOST-SELF-SYNTHESIS-GUARD: the cloud branch no longer falls back to
    // `primaryDaemonId` (= daemons[0] = P2P arrival order). That fallback is what made
    // mesh_status/graph/queue/node-detail query — and handleLaunchCoordinator target —
    // an arbitrary peer whenever the host pin had not resolved yet, so the dashboard
    // showed an unrelated machine as host and a Launch would have pinned it for good.
    // With no authoritative host signal we resolve to '' instead: the live panels stay
    // empty and MeshHostDaemonSection renders its neutral first-setup state, which
    // requires the operator to pick the host explicitly.
    // Standalone (no meshHostDaemonSection) has exactly one daemon, so primaryDaemonId
    // is that daemon rather than an arbitrary choice — unchanged.
    const resolvedActiveDaemonId = features.meshHostDaemonSection
        ? coordinatorDaemonId
        : primaryDaemonId

    // ─── Queue ───
    // The dedicated Queue settings section was removed (runtime telemetry, not config).
    // meshQueue is still loaded because per-node "active assignments" diagnostics in the
    // node list and the scheduler in useMeshNodeActions consume it; the standalone path
    // auto-loads it below.

    const {
        meshQueue,
        loadQueue,
    } = useMeshQueue({
        primaryDaemonId,
        activeDaemonId: resolvedActiveDaemonId,
        sendCommand,
        unwrapResult,
        loadLiveMesh,
        resolveCommandTarget,
    })

    // ─── Node actions ───

    const {
        selectedNodeId, setSelectedNodeId,
        showAddNode, setShowAddNode,
        nodeWorkspace, setNodeWorkspace,
        nodeProviderPriority, setNodeProviderPriority,
        nodeDaemonId, setNodeDaemonId,
        nodeCustomPath, setNodeCustomPath,
        nodePickerWorkspaces, nodePickerProviders, nodeOnboardingPlan, nodePlanLoading,
        coordinatorCliType, setCoordinatorCliType,
        launchingCoordinator, launchResult,
        savingPolicy,
        coordinatorPromptDraft, setCoordinatorPromptDraft,
        savingCoordinatorPrompt,
        nodeSystemPromptDrafts, setNodeSystemPromptDrafts,
        savingNodeSystemPromptId,
        savingNodeSlotsId,
        savingNodeCapabilitiesId,
        handleAddNode, handleRemoveNode, handleUpdatePolicy,
        handleUpdateNodeSlots,
        handleUpdateNodeCapabilities,
        handleSaveCoordinatorPrompt, handleSaveNodeSystemPrompt,
        handleLaunchCoordinator,
        settingMeshHost, handleSetMeshHost,
    } = useMeshNodeActions({
        selectedMesh,
        selectedMeshId,
        primaryDaemonId,
        activeDaemonId: resolvedActiveDaemonId,
        daemons,
        availableCliProviders,
        sendCommand,
        unwrapResult,
        loadLiveMesh,
        resolveCommandTarget,
        launchCoordinator,
        features: { addNodeDaemonPicker: features.addNodeDaemonPicker },
        loadMeshes,
        loadQueue,
        queueSection: features.queueSection,
        setError,
    })

    // ─── Derived ────────────────────────────────────────────────

    const activeDaemon = useMemo(
        () => daemons.find(d => d.id === resolvedActiveDaemonId) || primaryDaemon,
        [daemons, resolvedActiveDaemonId, primaryDaemon],
    )

    const attachedDaemonIds = useMemo(
        () => new Set((selectedMesh?.nodes || []).map(n => String(n.daemon_id || n.daemonId || ''))),
        [selectedMesh],
    )
    const attachableDaemons = useMemo(
        () => daemons.filter(d => d.id && !attachedDaemonIds.has(d.id)),
        [daemons, attachedDaemonIds],
    )

    const nodes: MeshNode[] = selectedMesh?.nodes || []
    // The node on the *command-target* daemon. This is an attachment check, not a host
    // identity: it gates "you must attach a workspace on this daemon before launching",
    // so it must follow coordinatorDaemonId (the daemon a launch would run on) even in
    // first-setup where no host is resolved yet. For DISPLAY, prefer
    // persistedHostInfo.hostNode (see hostNodeForDisplay below) so the host name and the
    // host node path can never come from two different machines.
    const commandTargetNode = useMemo(
        () => nodes.find(n => daemonIdsEquivalent(String(n.daemon_id || n.daemonId || ''), coordinatorDaemonId)),
        [nodes, coordinatorDaemonId],
    )
    const isHostNodeAttached = features.meshHostDaemonSection ? !!commandTargetNode : true

    // The daemon this mesh is pinned to as its host. The host is a fixed 1:1 pin
    // decided daemon-side at mesh creation, so this is read from persisted meshHost
    // metadata (hostDaemonId, else the daemon of hostNodeId), NOT chosen in the UI.
    //
    // Crucially this must survive the host being offline: when the host daemon is
    // not in the connected `daemons` list we still report `pinned` with a stable id
    // and a best-effort label (from the persisted host node), marked `online:false`,
    // instead of collapsing to '' and re-exposing a picker. Resolution goes through
    // daemonIdsEquivalent because the persisted id is frequently a config-form id
    // that does not byte-equal a connected runtime daemon id.
    //
    // HOST-SELF-SYNTHESIS-GUARD: a pin the daemon flagged `hostSynthesized` was inferred
    // from whichever daemon answered (its own identity), not read from config. Treating
    // it as pinned is what rendered a confident host badge for an arbitrary peer, so it
    // is deliberately demoted to `pinned:false` → the neutral first-setup state that
    // makes the operator choose. Note the daemon-side guard already withholds the
    // synthesis on a multi-peer mesh; this is the second layer, and it also covers a
    // single-peer mesh where the pin is still only a guess.
    //
    // Display coherence: `hostNode` is resolved HERE and returned alongside the daemon
    // id/label, so the "Host:" name and the "Host node:" path always come from one
    // resolved object instead of two independently-derived keys that can disagree
    // mid-transition.
    const persistedHostInfo = useMemo<{ pinned: boolean; daemonId: string; label: string; online: boolean; hostNode: MeshNode | undefined }>(() => {
        if (!features.meshHostDaemonSection || !selectedMesh) {
            return { pinned: false, daemonId: '', label: '', online: false, hostNode: undefined }
        }
        const listMeshHost = (selectedMesh as any).meshHost as { hostDaemonId?: string; hostNodeId?: string; hostSynthesized?: boolean } | undefined
        // HOST-MISSEED-CLOUD-SURFACE: the mesh_status payload (meshGraphStatus.meshHost)
        // carries the daemon-side *resolved* host pin (resolveMeshHostStatus synthesizes
        // hostDaemonId = the host daemon for a role:'host' mesh whose pin was never
        // persisted). The list_meshes entry historically lacked that synthesis, so reading
        // pinned solely from selectedMesh.meshHost produced 'no host yet' even when the
        // daemon already resolved this daemon as host. Read the resolved pin from the
        // loaded mesh_status FIRST, then fall back to the list entry's meshHost.
        const statusMeshHost = (meshGraphStatus?.meshId && String(meshGraphStatus.meshId) === String(selectedMesh.id ?? ''))
            ? (meshGraphStatus.meshHost as { hostDaemonId?: string; hostNodeId?: string; hostSynthesized?: boolean } | undefined)
            : undefined
        const meshHost = statusMeshHost?.hostDaemonId ? statusMeshHost : (listMeshHost ?? statusMeshHost)
        // HOST-SELF-SYNTHESIS-GUARD: a synthesized pin is the evaluating daemon's guess
        // about itself — not an established host. Strip it so we fall through to the
        // neutral first-setup state rather than badging an arbitrary daemon as host.
        const authoritativePin = readAuthoritativeMeshHostPin(meshHost)
        const pinnedDaemonId = authoritativePin.hostDaemonId
        // HOST-MISSEED-FIRSTSETUP transition boost: the mesh-list `meshHost` may still
        // lack a persisted pin (the daemon-side read-side default only fills it in the
        // mesh_status payload, not the list entry). When hostNodeId is absent, infer the
        // host node from a node already flagged role:'host' so the host badge resolves to
        // M4 instead of collapsing to a picker before the pin propagates.
        const inferredHostNode = nodes.find(n => (n as any).role === 'host')
        // Same demotion for the node anchor (a synthesized pin's hostNodeId is the
        // evaluating daemon's own node). A node explicitly flagged role:'host' IS a real
        // daemon-side declaration and is still honoured.
        const hostNodeId = authoritativePin.hostNodeId || String((inferredHostNode as any)?.id || '')
        const hostNode = hostNodeId ? nodes.find(n => String(n.id) === hostNodeId) : undefined
        const nodeDaemonId = String(hostNode?.daemon_id || hostNode?.daemonId || '')

        // Effective persisted host daemon id (config-form id is fine — kept as-is so
        // the badge/command target stays stable even when the daemon is offline).
        const effectiveId = pinnedDaemonId || nodeDaemonId
        if (!effectiveId) return { pinned: false, daemonId: '', label: '', online: false, hostNode: undefined }

        // Resolve to a connected runtime daemon if one matches → host is online.
        const connected =
            daemons.find(d => pinnedDaemonId && daemonIdsEquivalent(d.id, pinnedDaemonId)) ||
            (nodeDaemonId ? daemons.find(d => daemonIdsEquivalent(d.id, nodeDaemonId)) : undefined)
        if (connected) {
            return { pinned: true, daemonId: connected.id, label: daemonDisplayLabel(connected), online: true, hostNode }
        }

        // Host daemon is offline / not connected: preserve the pin and a label from
        // the persisted host node (machineLabel/workspace) so the read-only badge
        // never falls back to a daemon picker. Never blank the id.
        const offlineLabel =
            String((hostNode as any)?.machineLabel || '') ||
            String((hostNode as any)?.workspace || '') ||
            effectiveId
        return { pinned: true, daemonId: effectiveId, label: offlineLabel, online: false, hostNode }
    }, [selectedMesh, nodes, daemons, meshGraphStatus, features.meshHostDaemonSection])

    const persistedHostDaemonId = persistedHostInfo.daemonId
    const hostOnline = persistedHostInfo.online

    // Display coherence: the host NAME and the host NODE path must describe the same
    // machine. Both now come from the single resolved persistedHostInfo whenever a host
    // is pinned. Only in first-setup (nothing pinned) do we fall back to the
    // command-target node — there the section's own copy says "will host on <daemon>",
    // so the node shown is that same command target and the two still agree.
    const hostNodeForDisplay = persistedHostInfo.pinned
        ? persistedHostInfo.hostNode
        : commandTargetNode

    // While the pinned host is offline, route commands through the chosen re-bind
    // daemon (a connected daemon) if one is set and still connected. Otherwise the
    // resolved target is the persisted host id (which may be offline — loads will
    // just fail until reconnect, which the UI surfaces).
    const effectiveCommandDaemonId = useMemo(() => {
        if (!features.meshHostDaemonSection) return ''
        if (!persistedHostInfo.pinned) return ''
        if (!hostOnline && hostRebindDaemonId && daemons.some(d => d.id === hostRebindDaemonId)) {
            return hostRebindDaemonId
        }
        return persistedHostDaemonId
    }, [features.meshHostDaemonSection, persistedHostInfo.pinned, hostOnline, hostRebindDaemonId, daemons, persistedHostDaemonId])

    const meshNodeDaemonIds = useMemo(() => {
        if (!meshGraphStatus) return []
        return [...new Set(
            (meshGraphStatus.nodes ?? [])
                .map((n: any) => String(n.daemonId || n.daemon_id || ''))
                .filter(Boolean)
        )]
    }, [meshGraphStatus])

    const displayedMeshStatus = useMeshGraphMetadataSubscription({
        status: meshGraphStatus,
        daemonId: resolvedActiveDaemonId || null,
        extraDaemonIds: meshNodeDaemonIds,
        meshId: selectedMeshId,
        sendData,
    })

    // ─── Effects ────────────────────────────────────────────────

    // Sync coordinator + node system prompt drafts when selected mesh changes
    useEffect(() => {
        const coord = (selectedMesh as any)?.coordinator || {}
        setCoordinatorPromptDraft({
            override: typeof coord.systemPromptOverride === 'string' ? coord.systemPromptOverride : '',
            append: typeof coord.systemPromptAppend === 'string' ? coord.systemPromptAppend
                : typeof coord.systemPromptSuffix === 'string' ? coord.systemPromptSuffix : '',
        })
        setNodeSystemPromptDrafts(Object.fromEntries(
            (selectedMesh?.nodes || []).map(node => [node.id, typeof (node as any).systemPrompt === 'string' ? (node as any).systemPrompt : '']),
        ))
    }, [selectedMesh])

    // Auto-set default provider priority when opening add-node form
    useEffect(() => {
        const defaultPriority = features.addNodeDaemonPicker
            ? defaultProviderPriorityFromInventory(nodePickerProviders)
            : defaultProviderPriorityFromInventory(availableCliProviders)
        if (showAddNode && nodeProviderPriority.length === 0 && defaultPriority.length > 0) {
            setNodeProviderPriority(defaultPriority)
        }
    }, [showAddNode, availableCliProviders, nodePickerProviders, nodeProviderPriority.length, features.addNodeDaemonPicker])

    // Clear selectedNodeId when node is removed from mesh
    useEffect(() => {
        const nodeIds = new Set((selectedMesh?.nodes || []).map(n => n.id))
        if (selectedNodeId && !nodeIds.has(selectedNodeId)) setSelectedNodeId(null)
    }, [selectedMesh, selectedNodeId])

    // Cloud: derive the command/view-source daemon id. There is no host picker —
    // this is computed deterministically:
    //   • pinned host (online or offline) → the persisted host id, unless the host
    //     is offline AND the user picked a re-bind daemon, in which case route
    //     through that connected daemon (effectiveCommandDaemonId encodes both).
    //   • no host pinned yet (first-time setup) → see firstSetupSeedDaemonId below.
    // Keeping this as the single writer of coordinatorDaemonId is what lets
    // loadGraph/loadMeshStatus/metadata-subscription keep working without a select.
    //
    // HOST-MISSEED-FIRSTSETUP: the old first-setup fallback was a bare `daemons[0]`,
    // which on cloud is just the P2P insertion order — so an unrelated member daemon
    // (e.g. moltbot) could land at index 0 and get seeded as the host candidate,
    // producing "Will host on <wrong daemon>" for a flash on cold entry. That arbitrary
    // fallback (and the self/primaryDaemonId collapse that also reduces to daemons[0] on
    // cloud) is now REMOVED: resolveFirstSetupSeedDaemonId seeds ONLY from an authoritative
    // signal — the daemon-resolved host pin (mesh_status meshHost.hostDaemonId), else a
    // node already flagged role:'host'. With neither present it returns '' and the header
    // renders a neutral "resolving host… / pick a daemon" state instead of a wrong node.
    // The operator explicitly picks the host in genuine first-setup (no pin exists yet).
    // HOST-MISSEED-CLOUD-SURFACE: feed the daemon-resolved host pin (mesh_status
    // meshHost.hostDaemonId for THIS mesh) into the seed so the transition-window seed
    // prefers the daemon the daemon itself names as host.
    // HOST-SELF-SYNTHESIS-GUARD: only an AUTHORITATIVE pin may seed the first-setup
    // candidate. Feeding a synthesized pin here would re-introduce the defect through
    // the back door — the seed becomes coordinatorDaemonId, which is the Launch target,
    // and launching pins the host permanently. An unresolved seed ('') is correct: the
    // section then asks the operator to choose.
    const resolvedHostPinDaemonId = useMemo(() => {
        if (!meshGraphStatus?.meshId || String(meshGraphStatus.meshId) !== String(selectedMesh?.id ?? '')) return undefined
        return readAuthoritativeMeshHostPin(meshGraphStatus.meshHost as any).hostDaemonId || undefined
    }, [meshGraphStatus, selectedMesh])
    const firstSetupSeedDaemonId = useMemo(
        () => resolveFirstSetupSeedDaemonId(daemons, nodes, resolvedActiveDaemonId, primaryDaemonId, resolvedHostPinDaemonId),
        [daemons, nodes, resolvedActiveDaemonId, primaryDaemonId, resolvedHostPinDaemonId],
    )

    useEffect(() => {
        if (!features.meshHostDaemonSection) return
        if (!daemons.length && !persistedHostInfo.pinned) { setCoordinatorDaemonId(''); return }
        const target = persistedHostInfo.pinned
            ? effectiveCommandDaemonId
            : firstSetupSeedDaemonId
        if (target && !daemonIdsEquivalent(target, coordinatorDaemonId)) {
            setCoordinatorDaemonId(target)
        }
    }, [daemons, coordinatorDaemonId, persistedHostInfo.pinned, effectiveCommandDaemonId, firstSetupSeedDaemonId, features.meshHostDaemonSection])

    // Drop a stale re-bind override once the pinned host comes back online (or the
    // chosen re-bind daemon disconnects), so we snap back to commanding the host.
    useEffect(() => {
        if (!hostRebindDaemonId) return
        if (hostOnline || !daemons.some(d => d.id === hostRebindDaemonId)) {
            setHostRebindDaemonId('')
        }
    }, [hostOnline, hostRebindDaemonId, daemons])

    // Cloud: init newMeshDaemonId
    useEffect(() => {
        if (!features.createDaemonPicker) return
        if (!daemons.length) { setNewMeshDaemonId(''); return }
        if (!newMeshDaemonId || !daemons.some(d => d.id === newMeshDaemonId)) {
            setNewMeshDaemonId(daemons[0].id)
        }
    }, [daemons, newMeshDaemonId, features.createDaemonPicker])

    // Cloud: auto-select first workspace when daemon changes in create form
    useEffect(() => {
        if (!features.createDaemonPicker || !newMeshDaemonId) { setNewMeshWorkspace(''); return }
        if (!createPickerWorkspaces.length) { setNewMeshWorkspace(''); return }
        if (!createPickerWorkspaces.some(w => w.path === newMeshWorkspace)) {
            setNewMeshWorkspace(createPickerWorkspaces[0]?.path || '')
        }
    }, [newMeshDaemonId, newMeshWorkspace, createPickerWorkspaces, features.createDaemonPicker])

    // Load graph on mesh or coordinator daemon selection.
    //
    // SWR: only a genuine MESH switch clears the held graph — that prior graph is a
    // different mesh's topology and showing it would be wrong, so a first-paint
    // (spinner) load is correct there. A same-mesh command-daemon change (host
    // rebind while staying on this mesh) must NOT clear: the existing nodes are
    // still valid, so we keep them on screen and freshen in the background
    // (refresh=true → no spinner, no white flash). This is the flicker the operator
    // saw when the coordinator's own activity nudged resolvedActiveDaemonId.
    const graphLoadedForMeshRef = useRef<string | null>(null)
    // Poll-rate backoff state (repo-mesh/graph-poll-backoff.ts). A mesh switch is
    // exactly the "operator just acted, watch closely" moment, so it also resets
    // the backoff to the fast rate below.
    const pollBackoffRef = useRef(createGraphPollBackoffState())
    // Fast rate: cloud demotes to the push-fallback safety-net rate; standalone
    // (no push) uses the original conservative interval directly.
    const fastPollIntervalMs = features.meshStatePushRefresh
        ? GRAPH_PUSH_FALLBACK_INTERVAL_MS
        : GRAPH_AUTO_REVALIDATE_INTERVAL_MS
    // Effective interval for the auto-revalidate timer, widened once the graph has
    // been observed stable for BACKOFF_STABLE_TICKS_THRESHOLD consecutive snapshots.
    // Held in state (not a ref) so flipping it re-subscribes the setInterval below
    // with the new period instead of silently drifting.
    const [pollIntervalMs, setPollIntervalMs] = useState(fastPollIntervalMs)
    useEffect(() => {
        if (!selectedMeshId) return
        const meshChanged = graphLoadedForMeshRef.current !== selectedMeshId
        graphLoadedForMeshRef.current = selectedMeshId
        if (meshChanged) {
            resetGraphPollBackoff(pollBackoffRef.current)
            setPollIntervalMs(fastPollIntervalMs)
            // Seed from the last-good module cache for THIS mesh (if any) instead of
            // blanking to null — a previously-viewed mesh paints instantly and
            // freshens in the background (refresh=true). Only a never-seen mesh with
            // no cache entry does a spinner first-paint.
            const cached = getCachedMeshGraphStatus(selectedMeshId)
            setMeshGraphStatus(cached)
            setGraphError(null)
            void loadGraph(resolvedActiveDaemonId, selectedMeshId, cached !== null)
        } else {
            setGraphError(null)
            void loadGraph(resolvedActiveDaemonId, selectedMeshId, true)
        }
    }, [selectedMeshId, resolvedActiveDaemonId])

    // Visibility-gated automatic graph revalidation (SWR-style).
    // `loadGraph` is recreated each render, so we read it through a ref to keep
    // the interval stable (re-creating it every render would reset the timer and
    // it would never fire). A guard ref drops a tick while a prior auto-reload is
    // still in flight, so a slow git probe cannot pile up overlapping refreshes.
    // The manual Refresh button (onRefreshGraph) remains the explicit path.
    //
    // When the daemon pushes mesh revision counters (features.meshStatePushRefresh,
    // cloud), the revision hook below drives refreshes event-driven and this timer
    // is demoted to a slow safety net (GRAPH_PUSH_FALLBACK_INTERVAL_MS). Standalone
    // (no push) keeps the original fast poll.
    const loadGraphRef = useRef(loadGraph)
    loadGraphRef.current = loadGraph
    const autoRevalidateInFlight = useRef(false)
    // Single SWR background-refresh entrypoint shared by the revision-push hook and
    // the interval fallback. Held in a ref and reassigned each render so it always
    // closes over the current mesh/daemon without resetting the interval timer.
    const refreshGraphInBackground = useRef<() => void>(() => {})
    refreshGraphInBackground.current = () => {
        if (autoRevalidateInFlight.current) return
        if (!selectedMeshId || !resolvedActiveDaemonId) return
        autoRevalidateInFlight.current = true
        // refresh=true → SWR semantics: keep the current graph on screen (no
        // loading spinner) and commit the fresh snapshot when it arrives.
        void Promise.resolve(loadGraphRef.current(resolvedActiveDaemonId, selectedMeshId, true))
            .finally(() => { autoRevalidateInFlight.current = false })
    }

    // Every committed graph snapshot — regardless of which path produced it
    // (interval tick, event-driven push refresh, mesh switch, manual Refresh) —
    // feeds the backoff comparison (graph-poll-backoff.ts) so a real change
    // anywhere snaps the poll rate back to fast.
    useEffect(() => {
        recordGraphSnapshot(pollBackoffRef.current, meshGraphStatus)
        setPollIntervalMs(resolvePollIntervalMs(pollBackoffRef.current, fastPollIntervalMs))
    }, [meshGraphStatus, fastPollIntervalMs])

    // Event-driven refresh: re-fetch mesh_status the moment the daemon reports the
    // viewed mesh's state advanced, instead of waiting out the poll interval. No-op
    // on standalone (revision counters absent → hook never fires) and harmless when
    // the tab is hidden (loadGraph is cheap and the git probe is peer-gated).
    useMeshStateRevisionRefresh({
        daemonIds: useMemo(
            () => [resolvedActiveDaemonId, ...meshNodeDaemonIds].filter(Boolean),
            [resolvedActiveDaemonId, meshNodeDaemonIds],
        ),
        meshId: selectedMeshId,
        sendData,
        onRevisionAdvance: () => {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
            refreshGraphInBackground.current()
        },
    })

    useEffect(() => {
        if (!selectedMeshId || !resolvedActiveDaemonId) return
        if (typeof document === 'undefined') return

        let timer: ReturnType<typeof setInterval> | null = null

        const tick = () => {
            if (document.visibilityState !== 'visible') return
            refreshGraphInBackground.current()
        }

        const start = () => {
            if (timer === null) timer = setInterval(tick, pollIntervalMs)
        }
        const stop = () => {
            if (timer !== null) { clearInterval(timer); timer = null }
        }

        // Poll only while the tab is visible; pause immediately when hidden and
        // resume when the user returns. No leading tick — the selection effect
        // above already does the first paint.
        const onVisibilityChange = () => {
            if (document.visibilityState === 'visible') start()
            else stop()
        }
        if (document.visibilityState === 'visible') start()
        document.addEventListener('visibilitychange', onVisibilityChange)

        return () => {
            stop()
            document.removeEventListener('visibilitychange', onVisibilityChange)
        }
    }, [selectedMeshId, resolvedActiveDaemonId, pollIntervalMs])

    // Standalone: auto-load queue on mesh selection. The dedicated Queue settings
    // section is gone, but meshQueue still feeds per-node assignment diagnostics and
    // the scheduler, so the standalone path keeps loading it.
    useEffect(() => {
        if (features.queueSection) return
        void loadQueue(selectedMeshId)
    }, [selectedMeshId, features.queueSection])

    // Mesh list load. The first mount (no meshes held yet) does a plain load that
    // shows the 'Loading meshes...' state; every subsequent re-fire — triggered
    // only when the connected-daemon set actually changes — is a background SWR
    // refresh (refresh=true) that keeps the current list on screen instead of
    // clearing it to a spinner (the white-flash the operator complained about).
    // Keyed on a stable sorted daemon-id string, NOT the unstable `loadMeshes`
    // callback identity, so an unrelated parent re-render can't re-fire this.
    const meshDaemonIdsKey = useMemo(
        () => daemons.map(d => d.id).filter(Boolean).sort().join(','),
        [daemons],
    )
    const didInitialMeshLoad = useRef(false)
    useEffect(() => {
        void loadMeshes(didInitialMeshLoad.current)
        didInitialMeshLoad.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meshDaemonIdsKey])

    // ─── Render ───────────────────────────────────────────────────

    if (!primaryDaemonId) {
        return (
            <AppPage icon={<IconMesh />} title="Repo Mesh" subtitle="Multi-workspace orchestration">
                <div className="text-sm text-text-muted p-4">Waiting for daemon connection...</div>
            </AppPage>
        )
    }

    if (!selectedMesh) {
        return (
            <MeshListView
                meshes={meshes}
                loading={loading}
                error={error}
                onDismissError={() => setError(null)}
                daemons={daemons}
                features={{ createDaemonPicker: features.createDaemonPicker, maxMeshes: features.maxMeshes }}
                showCreate={showCreate}
                onToggleCreate={() => setShowCreate(!showCreate)}
                createName={createName}
                onCreateNameChange={setCreateName}
                createRepoIdentity={createRepoIdentity}
                onCreateRepoIdentityChange={setCreateRepoIdentity}
                createRepoRemoteUrl={createRepoRemoteUrl}
                onCreateRepoRemoteUrlChange={setCreateRepoRemoteUrl}
                newMeshDaemonId={newMeshDaemonId}
                onNewMeshDaemonIdChange={setNewMeshDaemonId}
                newMeshWorkspace={newMeshWorkspace}
                onNewMeshWorkspaceChange={setNewMeshWorkspace}
                createPickerWorkspaces={createPickerWorkspaces}
                createOnboardingPlan={createOnboardingPlan}
                createPlanLoading={createPlanLoading}
                creating={creating}
                createWarning={createWarning}
                onDismissCreateWarning={() => setCreateWarning(null)}
                onSelectMesh={setSelectedMeshId}
                onCreate={handleCreate}
                onCancelCreate={cancelCreate}
            />
        )
    }

    return (
        <MeshDetailView
            selectedMesh={selectedMesh}
            error={error}
            onDismissError={() => setError(null)}
            onBack={() => { setSelectedMeshId(null); setMeshGraphStatus(null) }}
            onDelete={handleDelete}
            displayedMeshStatus={displayedMeshStatus}
            graphLoading={graphLoading}
            graphError={graphError}
            onRefreshGraph={() => {
                resetGraphPollBackoff(pollBackoffRef.current)
                void loadGraph(resolvedActiveDaemonId, selectedMeshId, true)
            }}
            savingPolicy={savingPolicy}
            onUpdatePolicy={handleUpdatePolicy}
            coordinatorPromptDraft={coordinatorPromptDraft}
            onCoordinatorPromptDraftChange={setCoordinatorPromptDraft}
            savingCoordinatorPrompt={savingCoordinatorPrompt}
            onSaveCoordinatorPrompt={handleSaveCoordinatorPrompt}
            daemons={daemons}
            coordinatorDaemonId={coordinatorDaemonId}
            onCoordinatorDaemonIdChange={setCoordinatorDaemonId}
            coordinatorCliType={coordinatorCliType}
            onCoordinatorCliTypeChange={setCoordinatorCliType}
            launchingCoordinator={launchingCoordinator}
            launchResult={launchResult}
            isHostNodeAttached={isHostNodeAttached}
            selectedHostNode={hostNodeForDisplay}
            hostPinned={persistedHostInfo.pinned}
            hostLabel={persistedHostInfo.label}
            hostOnline={hostOnline}
            hostRebindDaemonId={hostRebindDaemonId}
            onHostRebindDaemonIdChange={id => setHostRebindDaemonId(id)}
            onLaunchCoordinator={handleLaunchCoordinator}
            settingMeshHost={settingMeshHost}
            onSetMeshHost={handleSetMeshHost}
            activeDaemon={activeDaemon}
            activeDaemonId={resolvedActiveDaemonId}
            meshQueue={meshQueue}
            userName={userName}
            availableCliProviders={availableCliProviders}
            savingNodeSlotsId={savingNodeSlotsId}
            onUpdateNodeSlots={handleUpdateNodeSlots}
            savingNodeCapabilitiesId={savingNodeCapabilitiesId}
            onUpdateNodeCapabilities={handleUpdateNodeCapabilities}
            nodeSystemPromptDrafts={nodeSystemPromptDrafts}
            onNodeSystemPromptDraftChange={(nodeId, value) => setNodeSystemPromptDrafts(prev => ({ ...prev, [nodeId]: value }))}
            savingNodeSystemPromptId={savingNodeSystemPromptId}
            onSaveNodeSystemPrompt={handleSaveNodeSystemPrompt}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            showAddNode={showAddNode}
            onShowAddNode={() => setShowAddNode(true)}
            onCancelAddNode={() => setShowAddNode(false)}
            nodeWorkspace={nodeWorkspace}
            onNodeWorkspaceChange={setNodeWorkspace}
            nodeProviderPriority={nodeProviderPriority}
            onNodeProviderPriorityChange={setNodeProviderPriority}
            nodeDaemonId={nodeDaemonId}
            onNodeDaemonIdChange={setNodeDaemonId}
            nodeCustomPath={nodeCustomPath}
            onNodeCustomPathChange={setNodeCustomPath}
            nodePickerWorkspaces={nodePickerWorkspaces}
            nodePickerProviders={nodePickerProviders}
            nodeOnboardingPlan={nodeOnboardingPlan}
            nodePlanLoading={nodePlanLoading}
            attachableDaemons={attachableDaemons}
            onAddNode={handleAddNode}
            onRemoveNode={handleRemoveNode}
            availableCliAgents={availableCliAgents}
            features={{
                coordinatorPrompt: features.coordinatorPrompt,
                meshHostDaemonSection: features.meshHostDaemonSection,
                hermesMcpConfig: features.hermesMcpConfig,
                addNodeDaemonPicker: features.addNodeDaemonPicker,
                nodeInstruction: features.nodeInstruction,
            }}
            sendCommand={sendCommand}
        />
    )
}

// ─── Helper ──────────────────────────────────────────────────────

function daemonDisplayLabel(daemon: RepoMeshDaemonEntry | undefined): string {
    if (!daemon) return 'Unknown'
    return daemon.machineNickname || daemon.nickname || daemon.hostname || daemon.id || 'Unknown'
}
