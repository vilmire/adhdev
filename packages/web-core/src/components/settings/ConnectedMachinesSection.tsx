/**
 * ConnectedMachinesSection — Shows connected daemon machines with version info & upgrade.
 * Shared between cloud and standalone settings.
 */
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { DaemonData } from '../../types'
import { EmptyState } from '../ui/EmptyState'
import { StatusBadge } from '../ui/StatusBadge'
import { getMachineDisplayName } from '../../utils/daemon-utils'
import { isVersionMismatch, isVersionUpdateRequired } from '../../utils/version-update'

declare const __APP_VERSION__: string

export interface ConnectedMachinesSectionProps {
    ides: DaemonData[]
    emptyMessage?: string
    sendDaemonCommand?: (daemonId: string, type: string, payload: Record<string, unknown>) => Promise<any>
    /** Server-side disconnect (close WS connection) */
    onDisconnect?: (daemonId: string) => Promise<any>
    /** Remove machine registration (requires re-setup) */
    onRevokeToken?: (daemonId: string) => Promise<any>
}

interface UpgradeCommandResult {
    alreadyLatest?: boolean
    upgraded?: boolean
    success?: boolean
    version?: string
    error?: string
}

function unwrapUpgradeResult(raw: unknown): UpgradeCommandResult {
    if (!raw || typeof raw !== 'object') return {}
    if ('result' in raw && raw.result && typeof raw.result === 'object') {
        return raw.result as UpgradeCommandResult
    }
    return raw as UpgradeCommandResult
}

function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback
}

export function ConnectedMachinesSection({ ides, emptyMessage, sendDaemonCommand, onDisconnect, onRevokeToken }: ConnectedMachinesSectionProps) {
    const { t } = useTranslation('common')
    const machines = ides.filter((i) => i.type === 'adhdev-daemon')

    if (machines.length === 0) {
        return (
            <EmptyState
                icon={<img src="/otter-logo.png" alt="ADHDev" className="w-12 h-12 object-contain mx-auto opacity-90" />}
                title={t('machine.connectedMachines.noMachines')}
                description={emptyMessage || t('machine.connectedMachines.defaultDescription')}
            />
        )
    }

    return (
        <div className="flex flex-col gap-2">
            {machines.map((ide) => (
                <MachineCard
                    key={ide.id}
                    ide={ide}
                    allIdes={ides}
                    sendDaemonCommand={sendDaemonCommand}
                    onDisconnect={onDisconnect}
                    onRevokeToken={onRevokeToken}
                />
            ))}
        </div>
    )
}

// ── Confirmation Dialog ──

function ConfirmDialog({ title, message, confirmLabel, confirmColor, onConfirm, onCancel }: {
    title: string
    message: string
    confirmLabel: string
    confirmColor: 'amber' | 'red'
    onConfirm: () => void
    onCancel: () => void
}) {
    const { t } = useTranslation('common')
    const colorClass = confirmColor === 'red'
        ? 'bg-status-error/20 text-status-error border-status-error/40 hover:bg-status-error/30'
        : ''

    return createPortal(
        <div className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            style={{ zIndex: 'var(--z-modal)' }}
            onClick={onCancel}
        >
            <div
                className="bg-bg-primary border border-border-subtle rounded-xl p-5 max-w-sm w-full mx-4 shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <div className="font-semibold text-sm mb-3">{title}</div>
                <div className="text-xs text-text-muted leading-relaxed mb-5 whitespace-pre-line">{message}</div>
                <div className="flex gap-2 justify-end">
                    <button
                        onClick={onCancel}
                        className="text-xs px-3 py-1.5 rounded-lg font-medium bg-bg-secondary text-text-secondary border border-border-subtle hover:bg-bg-glass transition-colors"
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        onClick={onConfirm}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium border transition-colors ${colorClass}`}
                        style={confirmColor === 'amber' ? { background: 'color-mix(in srgb, var(--status-warning) 20%, transparent)', color: 'var(--status-warning)', borderColor: 'color-mix(in srgb, var(--status-warning) 30%, transparent)' } : undefined}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    )
}

import { SUPPORTED_IDES, SUPPORTED_CLI_AGENTS, SUPPORTED_EXTENSIONS } from '../../constants/supported'

function getIdeLabel(type: string): { icon: string; name: string } {
    // Type format: "vscode", "cursor", or full "adhdev-daemon" (skip)
    const key = type.replace(/^ide-/, '').replace(/-provider$/, '').toLowerCase()
    
    // Combine all supported lists to find matching icon/name
    const allSupported = [...SUPPORTED_IDES, ...SUPPORTED_CLI_AGENTS, ...SUPPORTED_EXTENSIONS]
    const match = allSupported.find(s => 
        s.id === key || 
        key.includes(s.id) || 
        s.id.includes(key)
    )
    
    if (match) {
        return { icon: match.icon, name: match.name }
    }
    
    return { icon: '📝', name: type }
}

// ── Machine Card ──

function MachineCard({ ide, allIdes, sendDaemonCommand, onDisconnect, onRevokeToken }: {
    ide: DaemonData
    allIdes: DaemonData[]
    sendDaemonCommand?: (daemonId: string, type: string, payload: Record<string, unknown>) => Promise<any>
    onDisconnect?: (daemonId: string) => Promise<any>
    onRevokeToken?: (daemonId: string) => Promise<any>
}) {
    const { t } = useTranslation('common')
    const [upgradeState, setUpgradeState] = useState<'idle' | 'upgrading' | 'done' | 'error'>('idle')
    const [upgradeMsg, setUpgradeMsg] = useState('')
    const [confirmAction, setConfirmAction] = useState<'disconnect' | 'revoke' | null>(null)
    const [actionState, setActionState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
    const [actionMsg, setActionMsg] = useState('')

    const version = ide.version || null
    const platform = ide.machine?.platform || ide.system?.platform || ''
    const nickname = getMachineDisplayName(ide, { fallbackId: ide.id })

    const platformIcon = platform === 'win32' ? '🪟' : platform === 'darwin' ? '🍎' : '🐧'

    // Collect connected sessions by transport (IDE via CDP, CLI via PTY, ACP via stdio)
    const connectedIdes = allIdes.filter(i => i.daemonId === ide.id && i.transport === 'cdp-page')
    const connectedClis = allIdes.filter(i => i.daemonId === ide.id && i.transport === 'pty')
    const connectedAcps = allIdes.filter(i => i.daemonId === ide.id && i.transport === 'acp')

    // P2P connection status
    const p2p = ide.p2p

    const handleUpgrade = async () => {
        if (!sendDaemonCommand) return
        setUpgradeState('upgrading')
        setUpgradeMsg(t('machine.connectedMachines.startingUpgrade'))
        try {
            const result = unwrapUpgradeResult(await sendDaemonCommand(ide.id, 'daemon_upgrade', {}))
            if (result.alreadyLatest) {
                setUpgradeState('done')
                setUpgradeMsg(`Already on v${result.version || 'latest'}.`)
            } else if (result.upgraded || result.success) {
                setUpgradeState('done')
                setUpgradeMsg(`Upgrade to v${result.version || 'latest'} started. Daemon is restarting...`)
            } else {
                setUpgradeState('error')
                setUpgradeMsg(result.error || 'Upgrade failed')
            }
        } catch (e) {
            setUpgradeState('error')
            setUpgradeMsg(getErrorMessage(e, 'Connection lost during upgrade'))
        }
    }

    const handleDisconnect = async () => {
        setConfirmAction(null)
        if (!onDisconnect) return
        setActionState('loading')
        try {
            await onDisconnect(ide.id)
            setActionState('done')
            setActionMsg(t('machine.connectedMachines.machineDisconnected'))
        } catch (e) {
            setActionState('error')
            setActionMsg(getErrorMessage(e, t('machine.connectedMachines.failedToDisconnect')))
        }
    }

    const handleRevoke = async () => {
        setConfirmAction(null)
        if (!onRevokeToken) return
        setActionState('loading')
        try {
            await onRevokeToken(ide.id)
            setActionState('done')
            setActionMsg(t('machine.connectedMachines.tokenRevoked'))
        } catch (e) {
            setActionState('error')
            setActionMsg(getErrorMessage(e, t('machine.connectedMachines.failedToRevokeToken')))
        }
    }

    // Compare daemon version with dashboard version — hide update if already latest
    const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null
    const isOutdated = isVersionMismatch(ide, appVersion)
    const requiresUpdate = isVersionUpdateRequired(ide, appVersion)

    const totalInstances = connectedIdes.length + connectedClis.length + connectedAcps.length

    return (
        <>
            <div className="bg-bg-glass rounded-lg px-4 py-3 border border-border-subtle">
                {/* Header row */}
                <div className="flex justify-between items-center">
                    <div className="flex items-center gap-3">
                        <span className="text-xl">{platformIcon}</span>
                        <div>
                            <div className="font-medium text-sm">{nickname}</div>
                            <div className="text-xs text-text-muted font-mono flex items-center gap-2">
                                <span>{ide.id.substring(0, 12)}…</span>
                                {version && (
                                    <span
                                        className={`px-1.5 py-0.5 rounded text-[10px] ${!isOutdated ? 'bg-bg-secondary' : ''}`}
                                        style={isOutdated ? { background: 'color-mix(in srgb, var(--status-warning) 15%, transparent)', color: 'var(--status-warning)' } : undefined}
                                    >
                                        v{version}
                                        {!isOutdated && ' ✓'}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {sendDaemonCommand && isOutdated && (
                            <button
                                onClick={handleUpgrade}
                                disabled={upgradeState === 'upgrading' || upgradeState === 'done'}
                                className="btn btn-sm btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                                title={`Update to v${appVersion || 'latest'}`}
                            >
                                {upgradeState === 'upgrading' ? (
                                    <span className="flex items-center gap-1">
                                        <span className="animate-spin">⟳</span> {t('machine.connectedMachines.upgrading')}
                                    </span>
                                ) : upgradeState === 'done' ? (
                                    t('machine.connectedMachines.updated')
                                ) : (
                                    requiresUpdate ? t('machine.connectedMachines.updateNow') : (appVersion ? t('machine.connectedMachines.updateTo', { version: appVersion }) : t('machine.connectedMachines.updateNow'))
                                )}
                            </button>
                        )}
                        {onDisconnect && (
                            <button
                                onClick={() => setConfirmAction('disconnect')}
                                disabled={actionState === 'loading'}
                                className="btn btn-sm btn-warning disabled:opacity-50 disabled:cursor-not-allowed"
                                title="Disconnect this machine"
                            >
                                {t('machine.connectedMachines.disconnect')}
                            </button>
                        )}
                        {onRevokeToken && (
                            <button
                                onClick={() => setConfirmAction('revoke')}
                                disabled={actionState === 'loading'}
                                className="btn btn-sm btn-danger disabled:opacity-50 disabled:cursor-not-allowed"
                                title="Remove machine (requires re-setup)"
                            >
                                {t('machine.connectedMachines.remove')}
                            </button>
                        )}
                        <StatusBadge status={ide.status === 'online' ? 'online' : 'error'} />
                    </div>
                </div>

                {/* Connection details row */}
                <div className="flex items-center gap-3 mt-2.5 pt-2.5 border-t border-border-subtle/50">
                    {/* P2P Status */}
                    {p2p && (
                        <div className="flex items-center gap-1.5 text-[11px]">
                            <span
                                className={`w-1.5 h-1.5 rounded-full ${
                                    p2p.state === 'connected' ? 'bg-status-online' :
                                    'bg-text-muted/30'
                                } ${p2p.state === 'connecting' || p2p.state === 'new' ? 'animate-pulse' : ''}`}
                                style={(p2p.state === 'connecting' || p2p.state === 'new') ? { background: 'var(--status-warning)' } : undefined}
                            />
                            <span className="text-text-muted">
                                P2P {p2p.state === 'connected' ? 'connected' :
                                     p2p.state === 'connecting' || p2p.state === 'new' ? t('machine.connectedMachines.connecting') :
                                     p2p.state || 'off'}
                            </span>
                            {p2p.peers !== undefined && p2p.peers > 0 && (
                                <span className="text-text-muted/60">({p2p.peers} peer{p2p.peers !== 1 ? 's' : ''})</span>
                            )}
                        </div>
                    )}

                    {/* Separator */}
                    {p2p && totalInstances > 0 && (
                        <span className="text-border-subtle">·</span>
                    )}

                    {/* Connected instances summary */}
                    {totalInstances > 0 ? (
                        <div className="flex items-center gap-2 text-[11px] text-text-muted">
                            {connectedIdes.map(ideInst => {
                                const label = getIdeLabel(ideInst.type)
                                const cdp = ideInst.cdpConnected
                                return (
                                    <span key={ideInst.id} className="flex items-center gap-1 bg-bg-secondary px-1.5 py-0.5 rounded">
                                        <span>{label.icon}</span>
                                        <span>{label.name}</span>
                                        {cdp !== undefined && (
                                            <span
                                                className={`w-1.5 h-1.5 rounded-full ${cdp ? 'bg-status-online' : 'animate-pulse'}`}
                                                style={!cdp ? { background: 'var(--status-warning)' } : undefined}
                                                title={cdp ? t('machine.connectedMachines.cdpConnected') : t('machine.connectedMachines.cdpConnecting')} />
                                        )}
                                    </span>
                                )
                            })}
                            {connectedClis.map(cli => (
                                <span key={cli.id} className="flex items-center gap-1 bg-bg-secondary px-1.5 py-0.5 rounded">
                                    <span>⌨️</span>
                                    <span>{cli.cliName || 'CLI'}</span>
                                </span>
                            ))}
                            {connectedAcps.map(acp => (
                                <span key={acp.id} className="flex items-center gap-1 bg-bg-secondary px-1.5 py-0.5 rounded">
                                    <span>🔗</span>
                                    <span>{acp.cliName || 'ACP'}</span>
                                </span>
                            ))}
                        </div>
                    ) : (
                        <span className="text-[11px] text-text-muted/60 italic">{t('machine.connectedMachines.noIdesConnected')}</span>
                    )}
                </div>

                {/* Action messages */}
                {(upgradeMsg || actionMsg) && (
                    <div className={`text-xs mt-2 px-1 ${
                        (upgradeState === 'error' || actionState === 'error') ? 'text-status-error' :
                        (upgradeState === 'done' || actionState === 'done') ? 'text-status-online' :
                        'text-text-muted'
                    }`}>
                        {actionMsg || upgradeMsg}
                    </div>
                )}
            </div>

            {/* Confirmation Dialogs */}
            {confirmAction === 'disconnect' && (
                <ConfirmDialog
                    title={t('machine.connectedMachines.disconnectTitle')}
                    message={`Disconnect "${nickname}" from ADHDev?\n\nThis will close the server connection. The daemon process will continue running on the machine and will automatically reconnect.\n\nUse this if you want to temporarily stop remote control.`}
                    confirmLabel={t('machine.connectedMachines.disconnect')}
                    confirmColor="amber"
                    onConfirm={handleDisconnect}
                    onCancel={() => setConfirmAction(null)}
                />
            )}
            {confirmAction === 'revoke' && (
                <ConfirmDialog
                    title={t('machine.connectedMachines.removeTitle')}
                    message={`Remove "${nickname}" from your dashboard?\n\nThis will:\n• Immediately disconnect the machine\n• Delete the machine registration\n• Require restarting ADHDev on that machine\n\nUse this if you want to permanently remove a machine.`}
                    confirmLabel={t('machine.connectedMachines.remove')}
                    confirmColor="red"
                    onConfirm={handleRevoke}
                    onCancel={() => setConfirmAction(null)}
                />
            )}
        </>
    )
}
