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

interface UseMeshListOptions {
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
}: UseMeshListOptions) {
    const [meshes, setMeshes] = useState<MeshEntry[]>([])
    const [selectedMeshId, setSelectedMeshId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // Create form
    const [showCreate, setShowCreate] = useState(false)
    const [createName, setCreateName] = useState('')
    const [createRepoIdentity, setCreateRepoIdentity] = useState('')
    const [createRepoRemoteUrl, setCreateRepoRemoteUrl] = useState('')

    // Cloud create extras
    const [newMeshDaemonId, setNewMeshDaemonId] = useState('')
    const [newMeshWorkspace, setNewMeshWorkspace] = useState('')

    const selectedCreateDaemon = useMemo(
        () => daemons.find(d => d.id === newMeshDaemonId),
        [daemons, newMeshDaemonId],
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
        if (!features.createDaemonPicker || !loadDaemonMetadata) return
        if (!newMeshDaemonId || !selectedCreateDaemon) return
        const missingMetadata = !selectedCreateDaemon.workspaces
            || !(selectedCreateDaemon as any).availableProviders
        if (!missingMetadata) return
        void Promise.resolve(loadDaemonMetadata(newMeshDaemonId, { minFreshMs: 30_000 })).catch(() => {})
    }, [features.createDaemonPicker, loadDaemonMetadata, newMeshDaemonId, selectedCreateDaemon])

    const loadMeshes = useCallback(async () => {
        setLoading(true)
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
                setMeshes(Array.from(byId.values()))
            } else {
                if (!primaryDaemonId) return
                const res: any = await sendCommand(primaryDaemonId, 'list_meshes')
                if (res?.success) {
                    setMeshes((res.meshes || []).map((m: any) => normalizeMesh(m, primaryDaemonId)))
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
    }, [daemons, primaryDaemonId, sendCommand, unwrapResult, normalizeMesh, features.createDaemonPicker])

    async function handleCreate() {
        const targetDaemonId = features.createDaemonPicker ? newMeshDaemonId : primaryDaemonId
        if (!targetDaemonId || !createName.trim()) return
        const remoteUrl = createRepoRemoteUrl.trim()
        const identity = createRepoIdentity.trim()
        if (!remoteUrl && !identity) return
        try {
            const payload: any = { name: createName.trim() }
            if (remoteUrl) payload.repoRemoteUrl = remoteUrl
            if (identity) payload.repoIdentity = identity
            const raw = await sendCommand(targetDaemonId, 'create_mesh', payload)
            const result = unwrapResult(raw)
            if (result?.success === false) throw new Error(result.error || 'Create failed')
            const meshId = typeof result?.mesh?.id === 'string' ? result.mesh.id : ''
            if (meshId && features.createDaemonPicker && newMeshWorkspace) {
                const addRaw = await sendCommand(targetDaemonId, 'add_mesh_node', {
                    meshId,
                    daemonId: targetDaemonId,
                    machineId: selectedCreateDaemon?.machineId,
                    workspace: newMeshWorkspace,
                    role: 'host',
                    providerPriority: defaultProviderPriorityFromInventory(createPickerProviders),
                })
                const addResult = unwrapResult(addRaw)
                if (addResult?.success === false) throw new Error(addResult.error || 'Mesh created but failed to attach workspace')
            }
            setShowCreate(false)
            setCreateName('')
            setCreateRepoIdentity('')
            setCreateRepoRemoteUrl('')
            setNewMeshWorkspace('')
            await loadMeshes()
            if (result?.mesh?.id) setSelectedMeshId(result.mesh.id)
        } catch (e: any) { setError(e?.message || 'Create failed') }
    }

    async function handleDelete(meshId: string) {
        if (!confirm('Delete this mesh? This cannot be undone.')) return
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
        // actions
        loadMeshes,
        handleCreate,
        handleDelete,
        cancelCreate,
    }
}
