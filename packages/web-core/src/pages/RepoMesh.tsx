/**
 * RepoMesh — shared mesh management page (standalone + cloud)
 *
 * Platform-specific behaviour is injected via RepoMeshContext.
 * Standalone: wrap with StandaloneRepoMeshProvider (useTransport + useBaseDaemons).
 * Cloud:      wrap with a cloud provider that supplies multi-daemon loading,
 *             retry logic, coordinator targeting, and cloud-only UI sections.
 */
import { useState, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { daemonIdsEquivalent, isPhantomDaemonEntry } from '@adhdev/mesh-shared'

import AppPage from '../components/ui/AppPage'
import { IconMesh } from '../components/Icons'
import {
    defaultProviderPriorityFromInventory,
    normalizeAvailableCliProviders,
    type AvailableCliProviderOption,
} from '../utils/provider-priority'
import { useMeshGraphMetadataSubscription } from '../hooks/useMeshGraphMetadataSubscription'
import { useMeshStatusSubscription } from '../hooks/useMeshStatusSubscription'
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
import { useMeshGraph } from './repo-mesh/useMeshGraph'
import { resolveFirstSetupSeedDaemonId, readAuthoritativeMeshHostPin } from './repo-mesh/host-seed'
import type { MeshNode, MeshQueueEntry, AvailableCliAgent } from './repo-mesh/types'
import { useConfirmDialog } from '../hooks/useConfirmDialog'

// Re-export types that cloud/standalone wrappers may reference
export type { MeshNode, MeshQueueEntry, AvailableCliAgent }
export { RepoMeshHermesMcpConfig } from './repo-mesh/MeshHermesMcpConfig'
export { getNodeActiveAssignments, describeNodeActiveAssignmentLabel } from './repo-mesh/MeshNodeList'


// ─── Main page ───────────────────────────────────────────────────

export default function RepoMesh() {
    const ctx = useRepoMeshContext()
    const { t } = useTranslation('common')
    // Modal confirm for destructive mesh actions (delete mesh / remove node).
    // Replaces the two window.confirm leftovers from the CONFIRM-MIGRATION
    // sweep: a browser suppressing native dialogs turned Delete into a silent
    // no-op (owner repro 2026-08-24).
    const { confirm: confirmAction, confirmDialog: meshConfirmDialog } = useConfirmDialog()

    const {
        sendCommand, sendData, daemons, userName,
        loadMeshStatus, launchCoordinator, loadLiveMesh,
        extractStatus, unwrapResult, normalizeMesh, normalizeNode,
        resolveCommandTarget, features,
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
        confirmAction,
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
        meshGraphStatus,
        graphLoading, graphError, setGraphError,
        loadGraph,
    } = useMeshGraph({ selectedMeshId, loadMeshStatus, extractStatus, normalizeNode })

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
    // The queue is part of the coordinator's mesh_status (`queue.tasks`) — no
    // separate per-daemon read. It feeds the per-node "active assignments"
    // diagnostics in the node list.
    const { meshQueue } = useMeshQueue({ status: meshGraphStatus })

    // Re-read the coordinator's held answer after a mesh write (refresh:false —
    // the coordinator already knows about the write it just performed).
    const reloadMeshStatus = async () => {
        if (!selectedMeshId || !resolvedActiveDaemonId) return
        await loadGraph(resolvedActiveDaemonId, selectedMeshId, false)
    }

    // ─── Node actions ───

    const {
        selectedNodeId, setSelectedNodeId,
        showAddNode, setShowAddNode,
        nodeWorkspace, setNodeWorkspace,
        nodeProviderPriority, setNodeProviderPriority,
        nodeDaemonId, setNodeDaemonId,
        nodeCustomPath, setNodeCustomPath,
        nodePickerWorkspaces, nodePickerProviders, nodeOnboardingPlan, nodePlanLoading,
        coordinatorCliType,
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
        settingMeshHost, handleSetMeshHost,
    } = useMeshNodeActions({
        confirmAction,
        selectedMesh,
        selectedMeshId,
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
        reloadMeshStatus,
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
    // Phantom raw-DO-id entries are dropped here, at the point the candidate list is
    // BUILT — not at render — so the "N available" counter, the empty-state branch and
    // the cards all agree. The client daemon store never evicts an entry once injected,
    // so a ghost that the server has since stopped reporting still lingers in `daemons`;
    // the shape-based rule is the only thing that can retire it browser-side.
    const attachableDaemons = useMemo(
        () => daemons.filter(d => d.id && !attachedDaemonIds.has(d.id) && !isPhantomDaemonEntry(d)),
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

    // Sessions of every node come from the coordinator's mesh_status (remote nodes
    // via `heldRuntime`). Only the COORDINATOR daemon is subscribed — its own
    // sessions' live state and the mesh revision signal. Member daemons are never
    // subscribed from this page.
    const displayedMeshStatus = useMeshGraphMetadataSubscription({
        status: meshGraphStatus,
        daemonId: resolvedActiveDaemonId || null,
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

    // Cloud: auto-select first workspace when daemon changes in create form.
    // STANDALONE MUST NO-OP (create-hang, owner report 2026-08-24): with no
    // daemon picker this effect used to fall into the clear branch on every
    // run — and since newMeshWorkspace is a dependency, the user's selection
    // itself re-fired it, wiping the select right back to empty. That wipe
    // then re-ran the plan effect, whose empty-workspace early-return leaves
    // planLoading stuck true, so the form sat on "Checking the workspace…"
    // forever with nothing selected.
    useEffect(() => {
        if (!features.createDaemonPicker) return
        if (!newMeshDaemonId) { setNewMeshWorkspace(''); return }
        if (!createPickerWorkspaces.length) { setNewMeshWorkspace(''); return }
        if (!createPickerWorkspaces.some(w => w.path === newMeshWorkspace)) {
            setNewMeshWorkspace(createPickerWorkspaces[0]?.path || '')
        }
    }, [newMeshDaemonId, newMeshWorkspace, createPickerWorkspaces, features.createDaemonPicker])

    // The graph is PUSHED by the coordinator: one `mesh.status` subscription —
    // a snapshot on subscribe (so a mesh switch paints at once), keyed per-node /
    // per-task deltas after (an unchanged mesh sends nothing). Same lane on cloud
    // (P2P) and standalone (WS); there is no poll, backstop or revision refetch.
    // The Refresh button (onRefreshGraph) is the only command read, and asks the
    // coordinator to nudge its members (refresh:true).
    useEffect(() => {
        setGraphError(null)
    }, [selectedMeshId, resolvedActiveDaemonId])
    useMeshStatusSubscription({
        meshId: selectedMeshId,
        daemonId: resolvedActiveDaemonId || null,
        sendData,
    })

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
        // The first load that can actually ask a daemon is the initial one: an
        // empty daemon set keeps the list on its loading state (never "no meshes").
        if (meshDaemonIdsKey) didInitialMeshLoad.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [meshDaemonIdsKey])

    // ─── Render ───────────────────────────────────────────────────

    if (!primaryDaemonId) {
        return (
            <AppPage icon={<IconMesh />} title="Repo Mesh" subtitle={t('mesh.page.subtitle')}>
                <div className="text-sm text-text-muted p-4">{t('mesh.page.waitingForDaemon')}</div>
            </AppPage>
        )
    }

    if (!selectedMesh) {
        return (
            <>
            {meshConfirmDialog}
            <MeshListView
                meshes={meshes}
                loading={loading}
                error={error}
                onDismissError={() => setError(null)}
                daemons={daemons}
                features={{ createDaemonPicker: features.createDaemonPicker }}
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
                sendCommand={sendCommand}
            />
            </>
        )
    }

    return (
        <>
        {meshConfirmDialog}
        <MeshDetailView
            selectedMesh={selectedMesh}
            error={error}
            onDismissError={() => setError(null)}
            onBack={() => { setSelectedMeshId(null) }}
            onDelete={handleDelete}
            displayedMeshStatus={displayedMeshStatus}
            graphLoading={graphLoading}
            graphError={graphError}
            onRefreshGraph={() => {
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
            isHostNodeAttached={isHostNodeAttached}
            selectedHostNode={hostNodeForDisplay}
            hostPinned={persistedHostInfo.pinned}
            hostLabel={persistedHostInfo.label}
            hostOnline={hostOnline}
            hostRebindDaemonId={hostRebindDaemonId}
            onHostRebindDaemonIdChange={id => setHostRebindDaemonId(id)}
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
        </>
    )
}

// ─── Helper ──────────────────────────────────────────────────────

function daemonDisplayLabel(daemon: RepoMeshDaemonEntry | undefined): string {
    if (!daemon) return 'Unknown'
    return daemon.machineNickname || daemon.nickname || daemon.hostname || daemon.id || 'Unknown'
}
