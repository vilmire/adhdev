/**
 * "다른 머신 연결" — standalone multi-machine mesh pairing (design
 * docs/design/2026-10-07-standalone-multi-machine-mesh.md §4.6).
 *
 * Two roles, one card:
 *   - HOST:   create a one-time pairing code (create_mesh_host_pairing_token),
 *             show it with an address hint and its expiry, list paired members
 *             with their live link state and a revoke (revoke_mesh_peer) action.
 *   - MEMBER: enter host address + code → configure_mesh_host_pairing then
 *             join_mesh_host_pairing; show the daemon's own error text verbatim
 *             on failure, and the host link badge once peer state arrives.
 *
 * Also exports the per-node link badge used by the overview node list. The
 * link state is the mesh_status node payload's `node.connection` (the
 * coordinator's MeshPeerSnapshot for that daemon); `self` / `unknown` / absent
 * render nothing.
 *
 * The raw pairing code is held only in component state for display/copy — it
 * is never logged or written anywhere else.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { RepoMeshNodeStatus, RepoMeshStatus } from '@adhdev/daemon-core'
import { canonicalDaemonId } from '@adhdev/mesh-shared'
import type { MeshGraphTheme } from './meshGraphTheme'
import { Card, EmptyHint, StatusBadge, relativeTime, type Tone } from './meshOverviewPrimitives'
import { nodeDisplayName } from './MeshObservabilitySurface/meshSurfaceHelpers'
import { SettingsTabBar } from '../ui/SettingsTabs'
import { Tooltip } from '../ui/InfoTip'
import Button from '../ui/Button'
import { Input } from '../ui/FormField'
import { unwrapDaemonCommandBody } from '../../utils/daemon-command-envelope'

// ── copy ────────────────────────────────────────────────────────────────────
// Keys live under `mesh.pairing.*`; the Korean default renders until the
// catalogs carry the key, so the card is never shown as raw keys.

export const MESH_PAIRING_COPY = {
    title: '다른 머신 연결',
    tabHost: '호스트',
    tabMember: '멤버',
    hostIntro: '이 머신을 호스트로 두고, 다른 머신이 연결 코드로 붙게 합니다.',
    createCode: '연결 코드 만들기',
    creating: '만드는 중…',
    address: '주소',
    addressHint: "이 머신의 LAN 또는 Tailscale IP와 포트({{port}})를 쓰세요",
    loopbackWarning: '이 데몬은 이 머신에서만 접속할 수 있게(127.0.0.1) 떠 있어 다른 머신이 연결할 수 없습니다. --host 0.0.0.0 (또는 LAN/Tailscale IP)으로 다시 시작하세요.',
    code: '코드',
    codeOnce: '코드는 지금 한 번만 표시됩니다.',
    expiresAt: '만료: {{time}}',
    copy: '복사',
    copied: '복사됨',
    members: '연결된 머신',
    noMembers: '아직 연결된 머신이 없습니다.',
    revoke: '연결 해제',
    revokeConfirm: '해제',
    cancel: '취소',
    memberIntro: '호스트 머신에서 만든 주소와 코드를 입력하세요.',
    addressPlaceholder: '호스트:포트 (예: 100.64.0.2:3847)',
    codePlaceholder: '연결 코드',
    connect: '연결',
    connecting: '연결 중…',
    joined: '페어링 완료: {{host}}',
    waitingLink: '연결 대기 중',
    pairedTo: '호스트 {{address}}에 페어링됨',
    loadFailed: '페어링 정보를 불러오지 못했습니다',
    requestFailed: '요청이 실패했습니다',
    peerConnected: '연결됨',
    peerReconnecting: '재연결 중',
    peerDisconnected: '끊김',
    peerLastConnected: '마지막 연결 {{time}}',
    peerFailure: '실패 코드: {{code}}',
} as const

export type MeshPairingCopyKey = keyof typeof MESH_PAIRING_COPY

export function pairingText(t: TFunction | ((key: string, opts?: Record<string, unknown>) => string), key: MeshPairingCopyKey, opts?: Record<string, unknown>): string {
    return String((t as (k: string, o?: Record<string, unknown>) => string)(`mesh.pairing.${key}`, { defaultValue: MESH_PAIRING_COPY[key], ...opts }))
}

// ── peer link (node.connection) ───────────────────────────────────────────────────

export type MeshPeerLinkState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

export interface MeshNodePeerLink {
    state: MeshPeerLinkState
    lastConnectedAt?: string | number
    lastFailureCode?: string
}

const PEER_LINK_STATES: ReadonlySet<string> = new Set(['connecting', 'connected', 'disconnected', 'failed', 'closed'])

/**
 * Reads the node's `connection` (MeshPeerSnapshot as reported by the selected
 * coordinator) as a link state; null when absent, `self`, `unknown` or malformed.
 */
export function readNodePeerLink(node: RepoMeshNodeStatus | null | undefined): MeshNodePeerLink | null {
    const connection = (node as { connection?: unknown } | null | undefined)?.connection
    if (!connection || typeof connection !== 'object') return null
    const record = connection as { state?: unknown; lastConnectedAt?: unknown; lastFailureCode?: unknown }
    if (typeof record.state !== 'string' || !PEER_LINK_STATES.has(record.state)) return null
    return {
        state: record.state as MeshPeerLinkState,
        ...(typeof record.lastConnectedAt === 'string' || typeof record.lastConnectedAt === 'number' ? { lastConnectedAt: record.lastConnectedAt } : {}),
        ...(typeof record.lastFailureCode === 'string' && record.lastFailureCode ? { lastFailureCode: record.lastFailureCode } : {}),
    }
}

export type MeshPeerBadgeKind = 'connected' | 'reconnecting' | 'disconnected'

/** Link state → the three user-facing buckets (연결됨 / 재연결 중 / 끊김). */
export function peerLinkBadgeModel(peer: MeshNodePeerLink | null | undefined): { kind: MeshPeerBadgeKind; labelKey: MeshPairingCopyKey; tone: Tone } | null {
    if (!peer) return null
    switch (peer.state) {
        case 'connected': return { kind: 'connected', labelKey: 'peerConnected', tone: 'emerald' }
        case 'connecting': return { kind: 'reconnecting', labelKey: 'peerReconnecting', tone: 'amber' }
        case 'disconnected':
        case 'failed':
        case 'closed': return { kind: 'disconnected', labelKey: 'peerDisconnected', tone: 'rose' }
        default: return null
    }
}

function toIso(value: string | number | undefined): string | null {
    if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
    if (typeof value === 'string' && value) return value
    return null
}

export function MeshPeerLinkBadge({ meshTheme, peer }: { meshTheme: MeshGraphTheme; peer: MeshNodePeerLink | null | undefined }) {
    const { t } = useTranslation('common')
    const model = peerLinkBadgeModel(peer)
    if (!model || !peer) return null
    const last = relativeTime(toIso(peer.lastConnectedAt))
    const hint = [
        last ? pairingText(t, 'peerLastConnected', { time: last }) : null,
        peer.lastFailureCode && model.kind !== 'connected' ? pairingText(t, 'peerFailure', { code: peer.lastFailureCode }) : null,
    ].filter(Boolean).join('\n')
    return (
        <span data-peer-link={model.kind} className="inline-flex shrink-0">
            <Tooltip content={hint || undefined}>
                <StatusBadge meshTheme={meshTheme} label={pairingText(t, model.labelKey)} tone={model.tone} />
            </Tooltip>
        </span>
    )
}

/** Badge for one overview node row: renders only when the node carries peer state. */
export function MeshNodePeerLinkBadge({ meshTheme, node }: { meshTheme: MeshGraphTheme; node: RepoMeshNodeStatus }) {
    return <MeshPeerLinkBadge meshTheme={meshTheme} peer={readNodePeerLink(node)} />
}

// ── pairing card ────────────────────────────────────────────────────────────

type SendDaemonCommand = (id: string, type: string, data?: Record<string, unknown>) => Promise<any>

type PairingTab = 'host' | 'member'

interface PairingInfo {
    role?: string
    hostAddress?: string
    hostDaemonId?: string
    pairingStatus?: string
    addressCandidates: string[]
    /** The daemon listens on loopback only — no other machine can reach it. */
    loopbackOnly: boolean
}

interface CreatedCode {
    token: string
    expiresAt?: string
}

// Flat (not a discriminated union): web-core builds without strictNullChecks,
// where boolean-literal discriminants do not narrow.
interface JoinResult {
    ok: boolean
    hostDaemonId?: string
    hostLabel?: string
    error?: string
}

function isLoopbackHost(hostname: string): boolean {
    const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return h === 'localhost' || h === '::1' || h.startsWith('127.') || h.endsWith('.localhost')
}

/**
 * Address candidates for the host hint: daemon-reported addresses first
 * (`addressCandidates` / `lanAddresses` on get_mesh_host_pairing), else the
 * address this dashboard was opened on when it is not loopback.
 */
export function resolveHostAddressCandidates(body: Record<string, unknown> | undefined, location?: { hostname: string; host: string } | null): string[] {
    const out: string[] = []
    for (const field of ['addressCandidates', 'lanAddresses'] as const) {
        const list = body?.[field]
        if (Array.isArray(list)) for (const entry of list) if (typeof entry === 'string' && entry.trim()) out.push(entry.trim())
    }
    // A loopback-only daemon is unreachable whatever this page was opened on.
    if (body?.bindWarning === 'loopback_only') return []
    if (out.length === 0 && location && location.host && !isLoopbackHost(location.hostname)) out.push(location.host)
    return Array.from(new Set(out))
}

function currentLocation(): { hostname: string; host: string; port: string } | null {
    if (typeof window === 'undefined' || !window.location) return null
    return { hostname: window.location.hostname, host: window.location.host, port: window.location.port }
}

function errorText(body: Record<string, unknown> | undefined, fallback: string): string {
    const err = body?.error
    if (typeof err === 'string' && err.trim()) return err
    const code = body?.code
    if (typeof code === 'string' && code.trim()) return code
    return fallback
}

function sameDaemon(a: string | null | undefined, b: string | null | undefined): boolean {
    const ca = canonicalDaemonId(a ?? undefined)
    const cb = canonicalDaemonId(b ?? undefined)
    return !!ca && ca === cb
}

/** Remote member nodes on the host side, one row per member daemon. */
export function collectPairedMembers(status: RepoMeshStatus, selfDaemonId?: string | null): RepoMeshNodeStatus[] {
    const seen = new Set<string>()
    const out: RepoMeshNodeStatus[] = []
    for (const node of status.nodes ?? []) {
        const isMember = (node as { role?: string }).role === 'member' || readNodePeerLink(node) !== null
        if (!isMember || !node.daemonId) continue
        if (selfDaemonId && sameDaemon(node.daemonId, selfDaemonId)) continue
        const key = canonicalDaemonId(node.daemonId) || node.daemonId
        if (seen.has(key)) continue
        seen.add(key)
        out.push(node)
    }
    return out
}

const INPUT_CLASS = 'px-3 py-2 text-xs'

export default function MeshMachinePairingCard({
    meshTheme,
    status,
    daemonId,
    meshId,
    sendDaemonCommand,
}: {
    meshTheme: MeshGraphTheme
    status: RepoMeshStatus
    daemonId: string | null
    meshId: string | null
    sendDaemonCommand: SendDaemonCommand | null
}) {
    const { t } = useTranslation('common')
    const [tab, setTab] = useState<PairingTab>('host')
    const [info, setInfo] = useState<PairingInfo | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [busy, setBusy] = useState<'create' | 'join' | null>(null)
    const [created, setCreated] = useState<CreatedCode | null>(null)
    const [createError, setCreateError] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [addressInput, setAddressInput] = useState('')
    const [codeInput, setCodeInput] = useState('')
    const [joinResult, setJoinResult] = useState<JoinResult | null>(null)
    const [revokeTarget, setRevokeTarget] = useState<string | null>(null)
    const [revokeError, setRevokeError] = useState<string | null>(null)

    const run = useCallback(async (type: string, payload: Record<string, unknown>) => {
        if (!daemonId || !sendDaemonCommand) throw new Error(pairingText(t, 'requestFailed'))
        return unwrapDaemonCommandBody<Record<string, unknown>>(await sendDaemonCommand(daemonId, type, payload))
    }, [daemonId, sendDaemonCommand, t])

    const loadInfo = useCallback(async () => {
        if (!meshId) return
        try {
            const body = await run('get_mesh_host_pairing', { meshId })
            if (body?.success === false) { setLoadError(errorText(body, pairingText(t, 'loadFailed'))); return }
            const meshHost = (body?.meshHost ?? {}) as { role?: string; hostDaemonId?: string; pairing?: { status?: string } }
            const next: PairingInfo = {
                role: meshHost.role,
                hostAddress: typeof body?.hostAddress === 'string' ? body.hostAddress : undefined,
                hostDaemonId: meshHost.hostDaemonId,
                pairingStatus: meshHost.pairing?.status,
                addressCandidates: resolveHostAddressCandidates(body, currentLocation()),
                loopbackOnly: body?.bindWarning === 'loopback_only',
            }
            setInfo(next)
            setLoadError(null)
            if (next.role === 'member') setTab('member')
        } catch (err) {
            setLoadError(err instanceof Error ? err.message : pairingText(t, 'loadFailed'))
        }
    }, [meshId, run, t])

    useEffect(() => { void loadInfo() }, [loadInfo])

    const createCode = useCallback(async () => {
        if (!meshId) return
        setBusy('create')
        setCreateError(null)
        setCopied(false)
        try {
            const body = await run('create_mesh_host_pairing_token', { meshId })
            if (body?.success === false || typeof body?.token !== 'string') {
                setCreated(null)
                setCreateError(errorText(body, pairingText(t, 'requestFailed')))
            } else {
                setCreated({ token: body.token, expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined })
            }
        } catch (err) {
            setCreated(null)
            setCreateError(err instanceof Error ? err.message : pairingText(t, 'requestFailed'))
        } finally {
            setBusy(null)
        }
    }, [meshId, run, t])

    const copyCode = useCallback(async () => {
        if (!created) return
        try {
            await navigator.clipboard?.writeText(created.token)
            setCopied(true)
        } catch { /* clipboard unavailable — the code stays selectable */ }
    }, [created])

    const join = useCallback(async () => {
        const hostAddress = addressInput.trim()
        const token = codeInput.trim()
        if (!meshId || !hostAddress || !token) return
        setBusy('join')
        setJoinResult(null)
        try {
            const configured = await run('configure_mesh_host_pairing', { meshId, hostAddress, token })
            if (configured?.success === false) {
                setJoinResult({ ok: false, error: errorText(configured, pairingText(t, 'requestFailed')) })
                return
            }
            const joined = await run('join_mesh_host_pairing', { meshId, token })
            if (!joined || joined.success === false) {
                setJoinResult({ ok: false, error: errorText(joined, pairingText(t, 'requestFailed')) })
                return
            }
            const meshHost = (joined.meshHost ?? {}) as { hostDaemonId?: string }
            const hostNode = (joined.hostResult as { meshHost?: { hostDaemonId?: string } } | undefined)?.meshHost
            const hostDaemonId = meshHost.hostDaemonId || hostNode?.hostDaemonId
            setJoinResult({ ok: true, hostDaemonId, hostLabel: hostDaemonId || hostAddress })
            setCodeInput('')
            void loadInfo()
        } catch (err) {
            setJoinResult({ ok: false, error: err instanceof Error ? err.message : pairingText(t, 'requestFailed') })
        } finally {
            setBusy(null)
        }
    }, [addressInput, codeInput, meshId, run, t, loadInfo])

    const revoke = useCallback(async (peerDaemonId: string) => {
        if (!meshId) return
        setRevokeError(null)
        try {
            const body = await run('revoke_mesh_peer', { meshId, peerDaemonId })
            if (body?.success === false) setRevokeError(errorText(body, pairingText(t, 'requestFailed')))
            else setRevokeTarget(null)
        } catch (err) {
            setRevokeError(err instanceof Error ? err.message : pairingText(t, 'requestFailed'))
        }
    }, [meshId, run, t])

    const members = useMemo(() => collectPairedMembers(status, daemonId), [status, daemonId])
    const hostDaemonForLink = (joinResult?.ok ? joinResult.hostDaemonId : undefined) ?? info?.hostDaemonId
    const hostLink = useMemo(() => {
        if (!hostDaemonForLink) return null
        const node = (status.nodes ?? []).find(n => sameDaemon(n.daemonId, hostDaemonForLink))
        return readNodePeerLink(node)
    }, [status, hostDaemonForLink])

    if (!daemonId || !sendDaemonCommand || !meshId) return null

    const port = currentLocation()?.port || '3847'
    const expiresLabel = created?.expiresAt && !Number.isNaN(Date.parse(created.expiresAt))
        ? new Date(created.expiresAt).toLocaleString()
        : created?.expiresAt

    return (
        <Card meshTheme={meshTheme} title={pairingText(t, 'title')}>
            <div data-testid="mesh-pairing-card" className="flex flex-col gap-3">
                <SettingsTabBar
                    tabs={[
                        { key: 'host', label: pairingText(t, 'tabHost') },
                        { key: 'member', label: pairingText(t, 'tabMember') },
                    ]}
                    activeKey={tab}
                    onSelect={key => setTab(key === 'member' ? 'member' : 'host')}
                    tabIdPrefix="mesh-pairing-tab"
                    className="mb-0"
                />
                {loadError && <div className="text-2xs text-status-error" data-testid="mesh-pairing-load-error">{loadError}</div>}

                {tab === 'host' ? (
                    <div className="flex flex-col gap-3" data-testid="mesh-pairing-host">
                        <EmptyHint meshTheme={meshTheme}>{pairingText(t, 'hostIntro')}</EmptyHint>
                        {info?.loopbackOnly && (
                            <div className="text-2xs text-status-warning" data-testid="mesh-pairing-loopback-warning">{pairingText(t, 'loopbackWarning')}</div>
                        )}
                        {info && info.addressCandidates.length > 0 && !created && (
                            <div className="flex flex-wrap items-baseline gap-2 text-xs" data-testid="mesh-pairing-address-candidates">
                                <span className={meshTheme.textMuted}>{pairingText(t, 'address')}</span>
                                <span className={`font-mono ${meshTheme.textPrimary}`}>{info.addressCandidates.join(' · ')}</span>
                            </div>
                        )}
                        <div>
                            <Button variant="primary" size="sm" onClick={() => { void createCode() }} disabled={busy === 'create'} data-testid="mesh-pairing-create">
                                {busy === 'create' ? pairingText(t, 'creating') : pairingText(t, 'createCode')}
                            </Button>
                        </div>
                        {createError && <div className="text-2xs text-status-error" data-testid="mesh-pairing-create-error">{createError}</div>}
                        {created && (
                            <div className="flex flex-col gap-1.5 rounded-lg border border-border-subtle bg-bg-glass px-3 py-2 text-xs" data-testid="mesh-pairing-code-box">
                                <div className="flex flex-wrap items-baseline gap-2">
                                    <span className={meshTheme.textMuted}>{pairingText(t, 'address')}</span>
                                    {info && info.addressCandidates.length > 0 ? (
                                        <span className={`font-mono ${meshTheme.textPrimary}`} data-testid="mesh-pairing-address">{info.addressCandidates.join(' · ')}</span>
                                    ) : (
                                        <span className={meshTheme.textSecondary} data-testid="mesh-pairing-address-hint">{pairingText(t, 'addressHint', { port })}</span>
                                    )}
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className={meshTheme.textMuted}>{pairingText(t, 'code')}</span>
                                    <code className={`select-all break-all font-mono text-sm ${meshTheme.textPrimary}`} data-testid="mesh-pairing-code">{created.token}</code>
                                    <Button size="sm" onClick={() => { void copyCode() }} data-testid="mesh-pairing-copy">
                                        {copied ? pairingText(t, 'copied') : pairingText(t, 'copy')}
                                    </Button>
                                </div>
                                {expiresLabel && <div className={`text-2xs ${meshTheme.textMuted}`} data-testid="mesh-pairing-expiry">{pairingText(t, 'expiresAt', { time: expiresLabel })}</div>}
                                <div className={`text-3xs ${meshTheme.textMuted}`}>{pairingText(t, 'codeOnce')}</div>
                            </div>
                        )}
                        <div className="border-t border-border-subtle pt-2">
                            <div className={`mb-1 text-3xs font-medium ${meshTheme.textMuted}`}>{pairingText(t, 'members')}</div>
                            {members.length === 0 ? (
                                <EmptyHint meshTheme={meshTheme}>{pairingText(t, 'noMembers')}</EmptyHint>
                            ) : (
                                <div className="flex flex-col gap-1">
                                    {members.map(node => {
                                        const peerId = node.daemonId as string
                                        const confirming = revokeTarget === peerId
                                        return (
                                            <div key={peerId} className="flex min-w-0 flex-wrap items-center gap-2 text-xs" data-testid="mesh-pairing-member">
                                                <span className={`min-w-0 flex-1 truncate ${meshTheme.textPrimary}`}>{nodeDisplayName(node)}</span>
                                                <MeshNodePeerLinkBadge meshTheme={meshTheme} node={node} />
                                                {confirming ? (
                                                    <>
                                                        <Button variant="danger" size="sm" onClick={() => { void revoke(peerId) }} data-testid="mesh-pairing-revoke-confirm">{pairingText(t, 'revokeConfirm')}</Button>
                                                        <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(null)}>{pairingText(t, 'cancel')}</Button>
                                                    </>
                                                ) : (
                                                    <Button variant="ghost" size="sm" onClick={() => { setRevokeError(null); setRevokeTarget(peerId) }} data-testid="mesh-pairing-revoke">{pairingText(t, 'revoke')}</Button>
                                                )}
                                            </div>
                                        )
                                    })}
                                </div>
                            )}
                            {revokeError && <div className="mt-1 text-2xs text-status-error">{revokeError}</div>}
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2" data-testid="mesh-pairing-member-tab">
                        <EmptyHint meshTheme={meshTheme}>{pairingText(t, 'memberIntro')}</EmptyHint>
                        {info?.role === 'member' && info.hostAddress && info.pairingStatus === 'paired' && !joinResult && (
                            <div className={`flex flex-wrap items-center gap-2 text-xs ${meshTheme.textSecondary}`}>
                                <span>{pairingText(t, 'pairedTo', { address: info.hostAddress })}</span>
                                <MeshPeerLinkBadge meshTheme={meshTheme} peer={hostLink} />
                            </div>
                        )}
                        <Input
                            className={INPUT_CLASS}
                            value={addressInput}
                            onChange={event => setAddressInput(event.target.value)}
                            placeholder={pairingText(t, 'addressPlaceholder')}
                            aria-label={pairingText(t, 'address')}
                            autoComplete="off"
                            data-testid="mesh-pairing-address-input"
                        />
                        <Input
                            className={INPUT_CLASS}
                            value={codeInput}
                            onChange={event => setCodeInput(event.target.value)}
                            placeholder={pairingText(t, 'codePlaceholder')}
                            aria-label={pairingText(t, 'code')}
                            autoComplete="off"
                            data-testid="mesh-pairing-code-input"
                        />
                        <div>
                            <Button
                                variant="primary"
                                size="sm"
                                onClick={() => { void join() }}
                                disabled={busy === 'join' || !addressInput.trim() || !codeInput.trim()}
                                data-testid="mesh-pairing-join"
                            >
                                {busy === 'join' ? pairingText(t, 'connecting') : pairingText(t, 'connect')}
                            </Button>
                        </div>
                        {joinResult && (joinResult.ok ? (
                            <div className={`flex flex-wrap items-center gap-2 text-xs ${meshTheme.textPrimary}`} data-testid="mesh-pairing-join-success">
                                <span>{pairingText(t, 'joined', { host: joinResult.hostLabel })}</span>
                                {hostLink
                                    ? <MeshPeerLinkBadge meshTheme={meshTheme} peer={hostLink} />
                                    : <span className={`text-2xs ${meshTheme.textMuted}`}>{pairingText(t, 'waitingLink')}</span>}
                            </div>
                        ) : (
                            <div className="text-xs text-status-error" data-testid="mesh-pairing-join-error">{joinResult.error}</div>
                        ))}
                    </div>
                )}
            </div>
        </Card>
    )
}
