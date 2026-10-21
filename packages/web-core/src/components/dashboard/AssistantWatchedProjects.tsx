/**
 * "Following N" / "Follow projects" — the projects the assistant is following
 * (open relay threads + checkout-less followed remote projects; 2026-10-18
 * review + rc24 remote follow).
 *
 * Remains visible even when zero threads are open so the owner can discover
 * registered projects on same-account remote hosts and explicitly grant narrow
 * follower access ("Allow this assistant and follow"), stop following locally
 * ("Stop following"), or revoke access on the remote host ("Remove access").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
    ASSISTANT_REMOTE_FOLLOW_COMMAND,
    ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND,
    ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND,
    canonicalDaemonId,
    daemonIdsEquivalent,
    followedRemoteProjectKey,
    type FollowedRemoteProjectEntry,
    type RemoteProjectCatalogItem,
} from '@adhdev/mesh-shared'
import { useDaemons } from '../../compat'
import { cn } from '../../lib/utils'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import { RelativeTime } from '../ui/RelativeTime'
import { IconX } from '../Icons'
import { unwrapStagedAnswer } from './assistant-staged'

type SendCommand = (daemonId: string, type: string, payload?: any) => Promise<any>

export interface WatchedThread {
    meshId: string
    project: string | null
    openedAt: number
    lastSendAt: number
    hosting?: 'here' | 'remote' | 'remote_followed'
    hostDaemonId?: string
    hostLabel?: string
    canonicalKey?: string
    grantRevision?: number
    bindingRevision?: number
    remoteState?: 'followed' | 'unfollowed' | 'revoked'
}

export interface RemoteHostCandidate {
    id: string
    label: string
    online: boolean
}

interface PartialGrantSuccess {
    hostDaemonId: string
    hostLabel: string
    meshId: string
    name: string
    sanitizedRepoIdentity: string | null
    grantRevision: number
    bindingRevision: number
    error: string
}

function isOwnerAuthRefusal(out: any): boolean {
    const code = String(out?.code ?? '')
    return code === 'COMMAND_SOURCE_REJECTED' || code === 'owner_authorization_required'
}

function isUnsupportedHostError(out: any): boolean {
    const code = String(out?.code ?? '')
    const err = String(out?.error ?? '')
    return code === 'host_unsupported' || /^unknown command/i.test(err)
}

export default function AssistantWatchedProjects({
    daemonId,
    status,
    sendCommand,
    remoteHosts: remoteHostsProp,
}: {
    daemonId: string | null | undefined
    status?: string
    sendCommand: SendCommand
    remoteHosts?: RemoteHostCandidate[]
}) {
    const { t } = useTranslation('common')
    const daemonCtx = useDaemons()
    const [threads, setThreads] = useState<WatchedThread[]>([])
    const [followedRemote, setFollowedRemote] = useState<FollowedRemoteProjectEntry[]>([])
    const [open, setOpen] = useState(false)
    const [busy, setBusy] = useState<string | null>(null)
    const [ownerRequired, setOwnerRequired] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)
    const [partialSuccess, setPartialSuccess] = useState<PartialGrantSuccess | null>(null)
    const [selectedHostId, setSelectedHostId] = useState<string>('')
    const [catalogLoading, setCatalogLoading] = useState(false)
    const [catalogUnsupported, setCatalogUnsupported] = useState(false)
    const [catalogError, setCatalogError] = useState<string | null>(null)
    const [catalogProjects, setCatalogProjects] = useState<RemoteProjectCatalogItem[]>([])
    const rootRef = useRef<HTMLDivElement>(null)
    const seq = useRef(0)
    const catalogSeq = useRef(0)

    const remoteHosts = useMemo<RemoteHostCandidate[]>(() => {
        if (remoteHostsProp) return remoteHostsProp
        const ides = Array.isArray(daemonCtx?.ides) ? daemonCtx.ides : []
        const seen = new Map<string, RemoteHostCandidate>()
        for (const machine of ides) {
            if (!machine?.id || (daemonId && daemonIdsEquivalent(machine.id, daemonId))) continue
            const key = canonicalDaemonId(machine.id) ?? machine.id
            const statusStr = String(machine.status || '').toLowerCase()
            const online = statusStr !== 'offline' && statusStr !== 'disconnected'
            const label = getMachineDisplayName(machine, { fallbackId: machine.id })
            const prev = seen.get(key)
            if (!prev || (!prev.online && online)) {
                seen.set(key, { id: machine.id, label, online })
            }
        }
        return [...seen.values()]
    }, [remoteHostsProp, daemonCtx?.ides, daemonId])

    useEffect(() => {
        if (remoteHosts.length === 0) {
            if (selectedHostId) setSelectedHostId('')
            return
        }
        if (!selectedHostId || !remoteHosts.some(h => daemonIdsEquivalent(h.id, selectedHostId))) {
            const firstOnline = remoteHosts.find(h => h.online) ?? remoteHosts[0]!
            setSelectedHostId(firstOnline.id)
        }
    }, [remoteHosts, selectedHostId])

    const selectedHost = useMemo(
        () => remoteHosts.find(h => daemonIdsEquivalent(h.id, selectedHostId)) ?? null,
        [remoteHosts, selectedHostId],
    )

    const refresh = useCallback(async () => {
        if (!daemonId) {
            setThreads([])
            setFollowedRemote([])
            return
        }
        const mine = ++seq.current
        try {
            const out = unwrapStagedAnswer(await sendCommand(daemonId, 'assistant_threads', {}))
            if (mine !== seq.current) return
            setThreads(out?.success && Array.isArray(out.threads) ? out.threads as WatchedThread[] : [])
            setFollowedRemote(out?.success && Array.isArray(out.followedRemoteProjects) ? out.followedRemoteProjects as FollowedRemoteProjectEntry[] : [])
        } catch {
            if (mine === seq.current) {
                setThreads([])
                setFollowedRemote([])
            }
        }
    }, [daemonId, sendCommand])

    const refreshCatalog = useCallback(async (host: RemoteHostCandidate | null) => {
        if (!host || !host.online) {
            setCatalogProjects([])
            setCatalogUnsupported(false)
            setCatalogError(null)
            setCatalogLoading(false)
            return
        }
        const mine = ++catalogSeq.current
        setCatalogLoading(true)
        setCatalogUnsupported(false)
        setCatalogError(null)
        try {
            const out = unwrapStagedAnswer(await sendCommand(host.id, ASSISTANT_REMOTE_PROJECT_CATALOG_COMMAND, {}))
            if (mine !== catalogSeq.current) return
            if (!out?.success) {
                if (isOwnerAuthRefusal(out)) {
                    setOwnerRequired(true)
                } else if (isUnsupportedHostError(out)) {
                    setCatalogUnsupported(true)
                } else {
                    setCatalogError(String(out?.error || out?.code || 'catalog_unavailable'))
                }
                setCatalogProjects([])
            } else {
                setCatalogProjects(Array.isArray(out.projects) ? out.projects as RemoteProjectCatalogItem[] : [])
            }
        } catch (err) {
            if (mine !== catalogSeq.current) return
            setCatalogProjects([])
            setCatalogError(err instanceof Error ? err.message : String(err))
        } finally {
            if (mine === catalogSeq.current) setCatalogLoading(false)
        }
    }, [sendCommand])

    useEffect(() => { void refresh() }, [refresh, status])

    useEffect(() => {
        if (!open) return
        void refreshCatalog(selectedHost)
    }, [open, selectedHost, refreshCatalog])

    useEffect(() => {
        if (!open) return
        const onDown = (e: PointerEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
        window.addEventListener('pointerdown', onDown)
        window.addEventListener('keydown', onKey)
        return () => { window.removeEventListener('pointerdown', onDown); window.removeEventListener('keydown', onKey) }
    }, [open])

    if (!daemonId) return null

    const followedByKey = new Map<string, FollowedRemoteProjectEntry>()
    for (const f of followedRemote) {
        followedByKey.set(f.key, f)
    }

    const activeCount = threads.length

    const stopLocalOrRemote = async (thread: WatchedThread) => {
        if (!daemonId) return
        const busyId = thread.canonicalKey || thread.meshId
        setBusy(busyId)
        setActionError(null)
        try {
            if (thread.hosting === 'remote_followed' || thread.canonicalKey) {
                const out = unwrapStagedAnswer(await sendCommand(daemonId, ASSISTANT_REMOTE_FOLLOW_COMMAND, {
                    action: 'unfollow',
                    ...(thread.canonicalKey ? { key: thread.canonicalKey } : {}),
                    ...(thread.hostDaemonId ? { hostDaemonId: thread.hostDaemonId } : {}),
                    meshId: thread.meshId,
                }))
                if (isOwnerAuthRefusal(out)) setOwnerRequired(true)
                else if (!out?.success) setActionError(String(out?.error || out?.code || 'unfollow_failed'))
            } else {
                const out = unwrapStagedAnswer(await sendCommand(daemonId, 'assistant_thread_close', { meshId: thread.meshId }))
                setOwnerRequired(isOwnerAuthRefusal(out))
            }
        } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err))
        }
        setBusy(null)
        await refresh()
    }

    const stopFollowingRemoteEntry = async (entry: Pick<FollowedRemoteProjectEntry, 'key' | 'hostDaemonId' | 'meshId'>) => {
        if (!daemonId) return
        setBusy(`unfollow:${entry.key}`)
        setActionError(null)
        try {
            const out = unwrapStagedAnswer(await sendCommand(daemonId, ASSISTANT_REMOTE_FOLLOW_COMMAND, {
                action: 'unfollow',
                key: entry.key,
                hostDaemonId: entry.hostDaemonId,
                meshId: entry.meshId,
            }))
            if (isOwnerAuthRefusal(out)) setOwnerRequired(true)
            else if (!out?.success) setActionError(String(out?.error || out?.code || 'unfollow_failed'))
        } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err))
        }
        setBusy(null)
        await refresh()
    }

    const removeRemoteAccess = async (target: { key?: string; hostDaemonId: string; meshId: string }) => {
        if (!daemonId) return
        const key = target.key || followedRemoteProjectKey(target.hostDaemonId, target.meshId)
        setBusy(`revoke:${key}`)
        setActionError(null)
        try {
            const revokeOut = unwrapStagedAnswer(await sendCommand(target.hostDaemonId, ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND, {
                action: 'revoke',
                meshId: target.meshId,
            }))
            if (isOwnerAuthRefusal(revokeOut)) {
                setOwnerRequired(true)
                setBusy(null)
                return
            }
            if (!revokeOut?.success) {
                setActionError(String(revokeOut?.error || revokeOut?.code || 'revoke_failed'))
                setBusy(null)
                return
            }
            await sendCommand(daemonId, ASSISTANT_REMOTE_FOLLOW_COMMAND, {
                action: 'mark_revoked',
                key,
                hostDaemonId: target.hostDaemonId,
                meshId: target.meshId,
            })
            if (partialSuccess && partialSuccess.meshId === target.meshId && daemonIdsEquivalent(partialSuccess.hostDaemonId, target.hostDaemonId)) {
                setPartialSuccess(null)
            }
        } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err))
        }
        setBusy(null)
        await refresh()
    }

    const allowAndFollow = async (project: RemoteProjectCatalogItem, hostLabel: string) => {
        if (!daemonId) return
        const key = followedRemoteProjectKey(project.hostDaemonId, project.meshId)
        setBusy(`follow:${key}`)
        setOwnerRequired(false)
        setActionError(null)
        setPartialSuccess(null)
        try {
            // 1. Ensure local durable ownerBinding receipt on this assistant daemon
            const bindingOut = unwrapStagedAnswer(await sendCommand(daemonId, ASSISTANT_REMOTE_FOLLOW_COMMAND, {
                action: 'ensure_binding',
            }))
            if (isOwnerAuthRefusal(bindingOut)) {
                setOwnerRequired(true)
                setBusy(null)
                return
            }
            const bindingRevision = Number(bindingOut?.ownerBinding?.bindingRevision ?? 1)

            // 2. Grant narrow follower ACL on the remote host
            const grantOut = unwrapStagedAnswer(await sendCommand(project.hostDaemonId, ASSISTANT_REMOTE_PROJECT_ACCESS_COMMAND, {
                action: 'grant',
                meshId: project.meshId,
                activeDaemonId: daemonId,
                bindingRevision,
            }))
            if (isOwnerAuthRefusal(grantOut)) {
                setOwnerRequired(true)
                setBusy(null)
                return
            }
            if (!grantOut?.success || !grantOut?.access?.grantRevision) {
                setActionError(String(grantOut?.error || grantOut?.code || 'grant_failed'))
                setBusy(null)
                return
            }
            const grantRevision = Number(grantOut.access.grantRevision)

            // 3. Follow on local assistant (initializes high-water cursor via cursorOnly poll; sends no message)
            const followOut = unwrapStagedAnswer(await sendCommand(daemonId, ASSISTANT_REMOTE_FOLLOW_COMMAND, {
                action: 'follow',
                hostDaemonId: project.hostDaemonId,
                hostLabel,
                meshId: project.meshId,
                name: project.name,
                sanitizedRepoIdentity: project.sanitizedRepoIdentity,
                grantRevision,
                bindingRevision,
            }))
            if (!followOut?.success) {
                setPartialSuccess({
                    hostDaemonId: project.hostDaemonId,
                    hostLabel,
                    meshId: project.meshId,
                    name: project.name,
                    sanitizedRepoIdentity: project.sanitizedRepoIdentity,
                    grantRevision,
                    bindingRevision,
                    error: String(followOut?.error || followOut?.code || 'follow_failed'),
                })
                setBusy(null)
                await refresh()
                return
            }
        } catch (err) {
            setActionError(err instanceof Error ? err.message : String(err))
        }
        setBusy(null)
        await refresh()
    }

    const retryPartialFollow = async (partial: PartialGrantSuccess) => {
        if (!daemonId) return
        const key = followedRemoteProjectKey(partial.hostDaemonId, partial.meshId)
        setBusy(`follow:${key}`)
        setActionError(null)
        try {
            const followOut = unwrapStagedAnswer(await sendCommand(daemonId, ASSISTANT_REMOTE_FOLLOW_COMMAND, {
                action: 'follow',
                hostDaemonId: partial.hostDaemonId,
                hostLabel: partial.hostLabel,
                meshId: partial.meshId,
                name: partial.name,
                sanitizedRepoIdentity: partial.sanitizedRepoIdentity,
                grantRevision: partial.grantRevision,
                bindingRevision: partial.bindingRevision,
            }))
            if (followOut?.success) {
                setPartialSuccess(null)
            } else {
                setPartialSuccess({
                    ...partial,
                    error: String(followOut?.error || followOut?.code || 'follow_failed'),
                })
            }
        } catch (err) {
            setPartialSuccess({
                ...partial,
                error: err instanceof Error ? err.message : String(err),
            })
        }
        setBusy(null)
        await refresh()
    }

    return (
        <div ref={rootRef} className="assistant-watched relative" data-assistant-watched-count={activeCount}>
            <button
                type="button"
                className={cn('chat-activity-toggle assistant-watched-badge', open && 'chat-activity-toggle-active')}
                onClick={() => { setOpen(v => { if (!v) void refresh(); return !v }) }}
                aria-expanded={open}
                aria-haspopup="dialog"
                title={t('assistantWatched.hint')}
            >
                <span className="chat-activity-toggle-dot" />
                {activeCount > 0 ? t('assistantWatched.badge', { count: activeCount }) : t('assistantWatched.badgeZero')}
            </button>
            {open && (
                <div
                    role="dialog"
                    aria-label={t('assistantWatched.title')}
                    className="assistant-staged-panel assistant-watched-panel pointer-events-auto absolute right-0 top-full mt-1.5 flex max-h-[min(70vh,520px)] w-[min(400px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-border-default bg-bg-card text-xs text-text-secondary shadow-xl backdrop-blur-xl"
                >
                    <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
                        <span className="font-semibold text-text-primary">{t('assistantWatched.title')}</span>
                        <button type="button" className="btn btn-icon ml-auto" onClick={() => setOpen(false)} aria-label={t('assistantStaged.close')}>
                            <IconX size={14} />
                        </button>
                    </div>
                    <div className="flex flex-col gap-2 overflow-y-auto p-2">
                        <p className="m-0 px-1 text-text-muted">{t('assistantWatched.hint')}</p>
                        {ownerRequired && <p className="m-0 px-1 text-status-error" role="alert">{t('assistantWatched.ownerRequired')}</p>}
                        {actionError && <p className="m-0 px-1 text-status-error" role="alert">{actionError}</p>}
                        {partialSuccess && (
                            <div
                                data-testid="assistant-follow-partial-success"
                                role="alert"
                                className="rounded-md border border-status-warning/40 bg-bg-subtle p-2 text-text-primary"
                            >
                                <p className="m-0 mb-1.5">
                                    {t('assistantWatched.partialSuccess', {
                                        grantRevision: partialSuccess.grantRevision,
                                        error: partialSuccess.error,
                                    })}
                                </p>
                                <div className="flex items-center gap-1.5">
                                    <button
                                        type="button"
                                        className="btn btn-quiet"
                                        onClick={() => { void retryPartialFollow(partialSuccess) }}
                                    >
                                        {t('assistantWatched.allowAndFollow')}
                                    </button>
                                    <button
                                        type="button"
                                        className="btn btn-quiet text-status-error"
                                        onClick={() => { void removeRemoteAccess({ hostDaemonId: partialSuccess.hostDaemonId, meshId: partialSuccess.meshId }) }}
                                    >
                                        {t('assistantWatched.removeAccess')}
                                    </button>
                                </div>
                            </div>
                        )}
                        {threads.length === 0 ? (
                            <p className="m-0 px-1 py-1 text-text-muted" data-testid="assistant-watched-empty">
                                {t('assistantWatched.emptyFollowed')}
                            </p>
                        ) : (
                            <ul className="m-0 flex list-none flex-col gap-1 p-0">
                                {threads.map(thread => {
                                    const isRemoteFollowed = thread.hosting === 'remote_followed' || Boolean(thread.canonicalKey)
                                    const rowKey = thread.canonicalKey || thread.meshId
                                    return (
                                        <li key={rowKey} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]">
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate font-semibold text-text-primary">
                                                    {thread.project ?? t('assistantWatched.removedProject')}
                                                    {thread.hostLabel && (
                                                        <span className="ml-1.5 font-normal text-text-muted">({thread.hostLabel})</span>
                                                    )}
                                                </div>
                                                <div className="text-text-muted">{t('assistantWatched.lastRequest')} <RelativeTime value={thread.lastSendAt} /></div>
                                            </div>
                                            <div className="flex shrink-0 items-center gap-1">
                                                <button
                                                    type="button"
                                                    className="btn btn-quiet shrink-0"
                                                    disabled={busy === rowKey}
                                                    onClick={() => { void stopLocalOrRemote(thread) }}
                                                >
                                                    {t('assistantWatched.stop')}
                                                </button>
                                                {isRemoteFollowed && thread.hostDaemonId && (
                                                    <button
                                                        type="button"
                                                        className="btn btn-quiet shrink-0 text-status-error"
                                                        disabled={busy === `revoke:${rowKey}`}
                                                        onClick={() => {
                                                            void removeRemoteAccess({
                                                                key: thread.canonicalKey,
                                                                hostDaemonId: thread.hostDaemonId!,
                                                                meshId: thread.meshId,
                                                            })
                                                        }}
                                                    >
                                                        {t('assistantWatched.removeAccess')}
                                                    </button>
                                                )}
                                            </div>
                                        </li>
                                    )
                                })}
                            </ul>
                        )}

                        <div className="mt-1 border-t border-border-subtle pt-2" data-testid="assistant-remote-discovery">
                            <div className="mb-1 font-semibold text-text-primary">{t('assistantWatched.remoteSectionTitle')}</div>
                            <p className="m-0 mb-2 text-[11px] leading-snug text-text-muted">
                                {t('assistantWatched.scopeNote')}
                            </p>
                            {remoteHosts.length === 0 ? (
                                <p className="m-0 text-text-muted" data-testid="assistant-no-remote-hosts">
                                    {t('assistantWatched.noRemoteHosts')}
                                </p>
                            ) : (
                                <>
                                    <label className="mb-2 flex items-center gap-2">
                                        <span className="shrink-0 text-text-muted">{t('assistantWatched.selectRemoteHost')}</span>
                                        <select
                                            data-testid="assistant-remote-host-select"
                                            className="min-w-0 flex-1 rounded border border-border-default bg-bg-subtle px-2 py-1 text-xs text-text-primary"
                                            value={selectedHost?.id ?? ''}
                                            onChange={e => setSelectedHostId(e.target.value)}
                                        >
                                            {remoteHosts.map(h => (
                                                <option key={h.id} value={h.id}>
                                                    {h.label} ({h.online ? t('assistantWatched.hostStateOnline') : t('assistantWatched.hostStateOffline')})
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    {selectedHost && !selectedHost.online && (
                                        <p className="m-0 text-text-muted" data-testid="assistant-remote-host-offline">
                                            {t('assistantWatched.hostOffline')}
                                        </p>
                                    )}
                                    {selectedHost && selectedHost.online && catalogLoading && (
                                        <p className="m-0 text-text-muted">{t('assistantWatched.loadingCatalog')}</p>
                                    )}
                                    {selectedHost && selectedHost.online && !catalogLoading && catalogUnsupported && (
                                        <p className="m-0 text-status-warning" data-testid="assistant-remote-host-unsupported">
                                            {t('assistantWatched.hostUnsupported')}
                                        </p>
                                    )}
                                    {selectedHost && selectedHost.online && !catalogLoading && catalogError && (
                                        <p className="m-0 text-status-error" role="alert">{catalogError}</p>
                                    )}
                                    {selectedHost && selectedHost.online && !catalogLoading && !catalogUnsupported && !catalogError && (
                                        catalogProjects.length === 0 ? (
                                            <p className="m-0 text-text-muted">{t('assistantWatched.emptyCatalog')}</p>
                                        ) : (
                                            <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="assistant-remote-catalog-list">
                                                {catalogProjects.map(project => {
                                                    const key = followedRemoteProjectKey(project.hostDaemonId, project.meshId)
                                                    const localEntry = followedByKey.get(key)
                                                    const isFollowed = localEntry?.state === 'followed'
                                                    const isUnfollowed = localEntry?.state === 'unfollowed'
                                                    const isRevoked = localEntry?.state === 'revoked'
                                                    return (
                                                        <li
                                                            key={key}
                                                            data-testid={`remote-catalog-item-${project.meshId}`}
                                                            className="flex flex-col gap-1 rounded-md border border-border-subtle px-2 py-1.5"
                                                        >
                                                            <div className="flex items-center justify-between gap-2">
                                                                <span className="truncate font-semibold text-text-primary">{project.name}</span>
                                                                <span className="shrink-0 text-[11px] leading-4 text-text-muted">
                                                                    {t('assistantWatched.coordinatorState', { state: project.coordinatorState })}
                                                                </span>
                                                            </div>
                                                            {project.sanitizedRepoIdentity && (
                                                                <div className="truncate text-[11px] leading-4 text-text-muted">{project.sanitizedRepoIdentity}</div>
                                                            )}
                                                            {isFollowed && (
                                                                <div className="text-[11px] leading-4 text-status-success">{t('assistantWatched.stateFollowed')}</div>
                                                            )}
                                                            {isUnfollowed && (
                                                                <div className="text-[11px] leading-4 text-text-muted">{t('assistantWatched.stateUnfollowed')}</div>
                                                            )}
                                                            {isRevoked && (
                                                                <div className="text-[11px] leading-4 text-status-warning">{t('assistantWatched.stateRevoked')}</div>
                                                            )}
                                                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                                                                {!isFollowed && (
                                                                    <button
                                                                        type="button"
                                                                        data-testid={`allow-and-follow-${project.meshId}`}
                                                                        className="btn btn-quiet"
                                                                        disabled={busy === `follow:${key}`}
                                                                        onClick={() => { void allowAndFollow(project, selectedHost.label) }}
                                                                    >
                                                                        {t('assistantWatched.allowAndFollow')}
                                                                    </button>
                                                                )}
                                                                {isFollowed && (
                                                                    <button
                                                                        type="button"
                                                                        data-testid={`stop-following-${project.meshId}`}
                                                                        className="btn btn-quiet"
                                                                        disabled={busy === `unfollow:${key}`}
                                                                        onClick={() => {
                                                                            void stopFollowingRemoteEntry({
                                                                                key,
                                                                                hostDaemonId: project.hostDaemonId,
                                                                                meshId: project.meshId,
                                                                            })
                                                                        }}
                                                                    >
                                                                        {t('assistantWatched.stop')}
                                                                    </button>
                                                                )}
                                                                {(isFollowed || isUnfollowed) && (
                                                                    <button
                                                                        type="button"
                                                                        data-testid={`remove-access-${project.meshId}`}
                                                                        className="btn btn-quiet text-status-error"
                                                                        disabled={busy === `revoke:${key}`}
                                                                        onClick={() => {
                                                                            void removeRemoteAccess({
                                                                                key,
                                                                                hostDaemonId: project.hostDaemonId,
                                                                                meshId: project.meshId,
                                                                            })
                                                                        }}
                                                                    >
                                                                        {t('assistantWatched.removeAccess')}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </li>
                                                    )
                                                })}
                                            </ul>
                                        )
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

