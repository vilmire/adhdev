/**
 * ProviderCloneModal — Create a user provider by cloning from upstream.
 *
 * Lets the user:
 * - Pick a base upstream IDE provider to clone
 * - Enter custom type name and display name
 * - Calls scaffold API to create the user provider
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderInfo } from './types'
import ModalPortal from '../../components/ui/ModalPortal'
import { IconCheckCircle } from '../../components/Icons'
import { ProviderLogo } from '../../components/ProviderLogo'

interface ProviderCloneModalProps {
    machineId: string
    providers: ProviderInfo[]
    sendDaemonCommand: (id: string, type: string, data?: Record<string, unknown>) => Promise<any>
    onClose: () => void
    onCreated?: (type: string) => void
}

export default function ProviderCloneModal({ machineId, providers, sendDaemonCommand, onClose, onCreated }: ProviderCloneModalProps) {
    const { t } = useTranslation('common')
    const ideProviders = providers.filter(p => p.category === 'ide')
    const [baseType, setBaseType] = useState(ideProviders[0]?.type || '')
    const [customType, setCustomType] = useState('')
    const [displayName, setDisplayName] = useState('')
    const [creating, setCreating] = useState(false)
    const [error, setError] = useState('')
    const [created, setCreated] = useState(false)

    // Auto-fill display name when customType changes
    const handleTypeChange = (val: string) => {
        const cleaned = val.toLowerCase().replace(/[^a-z0-9-]/g, '')
        setCustomType(cleaned)
        if (!displayName || displayName === toDisplayName(customType)) {
            setDisplayName(toDisplayName(cleaned))
        }
    }

    const toDisplayName = (type: string) => type
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')

    const handleCreate = async () => {
        if (!customType || !displayName || !baseType) return
        setCreating(true)
        setError('')

        try {
            const res = await sendDaemonCommand(machineId, 'provider_clone', {
                type: customType,
                name: displayName,
                category: 'ide',
                location: 'user',
                // Pass base provider info so scaffold can copy CDP ports etc
                cloneFrom: baseType,
            })
            if (res?.success || res?.created) {
                setCreated(true)
                onCreated?.(customType)
            } else {
                setError(res?.error || 'Failed to create provider')
            }
        } catch (e: any) {
            setError(e?.message || 'Connection failed')
        }
        setCreating(false)
    }


    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-end justify-center overflow-y-auto bg-black/60 backdrop-blur-sm px-2 pt-[calc(8px+env(safe-area-inset-top,0px))] pb-[calc(8px+env(safe-area-inset-bottom,0px))] sm:items-center sm:p-4" onClick={onClose}>
            <div
                className="w-full max-w-[480px] max-h-[calc(100dvh-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px)-16px)] rounded-[24px] sm:rounded-2xl bg-bg-primary border border-border-subtle shadow-2xl flex flex-col overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Header — with a usable >=44px close target (previously the
                    only dismissal paths were the footer Cancel and backdrop). */}
                <div className="px-5 py-4 border-b border-border-subtle flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-[15px] font-semibold text-text-primary">{t('machine.providerClone.title')}</h2>
                        <p className="text-2xs text-text-muted mt-0.5">{t('machine.providerClone.subtitle')}</p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center text-text-muted hover:text-text-primary text-lg leading-none"
                    >×</button>
                </div>

                {/* Body */}
                <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 sm:px-5 sm:py-4 flex flex-col gap-4">
                    {!created ? (
                        <>
                            {/* Base Provider */}
                            <div>
                                <label className="text-2xs text-text-muted font-semibold uppercase tracking-wider mb-1.5 block">
                                    {t('machine.providerClone.baseProvider')}
                                </label>
                                <div className="grid grid-cols-3 gap-1.5">
                                    {ideProviders.map(p => (
                                        <button
                                            key={p.type}
                                            onClick={() => setBaseType(p.type)}
                                            className="px-2.5 py-2 rounded-lg border text-center transition-all"
                                            style={{
                                                borderColor: baseType === p.type ? 'color-mix(in srgb, var(--accent-primary) 40%, transparent)' : 'var(--border-subtle)',
                                                background: baseType === p.type ? 'color-mix(in srgb, var(--accent-primary) 8%, transparent)' : 'transparent',
                                            }}
                                        >
                                            <div className="flex justify-center"><ProviderLogo type={p.type} label={p.displayName} size={22} /></div>
                                            <div className="text-3xs font-medium mt-0.5" style={{ color: baseType === p.type ? '#a78bfa' : 'var(--text-secondary)' }}>
                                                {p.displayName}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Custom Type */}
                            <div>
                                <label className="text-2xs text-text-muted font-semibold uppercase tracking-wider mb-1.5 block">
                                    {t('machine.providerClone.providerTypeId')}
                                </label>
                                <input
                                    value={customType}
                                    onChange={e => handleTypeChange(e.target.value)}
                                    placeholder={t('machine.providerClone.typeIdPlaceholder')}
                                    className="w-full px-3 py-2 rounded-lg border border-border-subtle bg-bg-secondary text-text-primary text-[12px] placeholder:text-text-muted/50 focus:outline-none focus:border-accent-primary/40"
                                />
                                <p className="text-3xs text-text-muted mt-1">
                                    {t('machine.providerClone.typeIdHint')} <code className="text-accent-primary">~/.adhdev/providers/{customType || '...'}/</code>
                                </p>
                            </div>

                            {/* Display Name */}
                            <div>
                                <label className="text-2xs text-text-muted font-semibold uppercase tracking-wider mb-1.5 block">
                                    {t('machine.providerClone.displayName')}
                                </label>
                                <input
                                    value={displayName}
                                    onChange={e => setDisplayName(e.target.value)}
                                    placeholder={t('machine.providerClone.displayNamePlaceholder')}
                                    className="w-full px-3 py-2 rounded-lg border border-border-subtle bg-bg-secondary text-text-primary text-[12px] placeholder:text-text-muted/50 focus:outline-none focus:border-accent-primary/40"
                                />
                            </div>

                            {error && (
                                <div className="px-3 py-2 rounded-lg bg-red-500/[0.06] border border-red-500/20 text-red-400 text-2xs">
                                    {error}
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="text-center py-6">
                            <div className="mb-2 flex justify-center text-emerald-400"><IconCheckCircle size={30} /></div>
                            <h3 className="text-[14px] font-semibold text-text-primary">{t('machine.providerClone.createdTitle')}</h3>
                            <p className="text-2xs text-text-muted mt-1">
                                {t('machine.providerClone.createdDesc', { type: customType })} <code className="text-green-400">~/.adhdev/providers/{customType}/</code>
                            </p>
                            <p className="text-2xs text-text-muted mt-2">
                                {t('machine.providerClone.createdRunHint', { type: customType })}
                            </p>
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-[calc(12px+env(safe-area-inset-bottom,0px))] sm:px-5 sm:py-3.5 border-t border-border-subtle flex justify-end gap-2 shrink-0">
                    {!created ? (
                        <>
                            <button onClick={onClose} className="machine-btn">{t('machine.providerClone.cancel')}</button>
                            <button
                                onClick={handleCreate}
                                disabled={!customType || !displayName || creating}
                                className="machine-btn"
                                style={{
                                    background: customType && displayName ? 'rgba(34,197,94,0.12)' : undefined,
                                    borderColor: customType && displayName ? 'rgba(34,197,94,0.3)' : undefined,
                                    color: customType && displayName ? '#86efac' : undefined,
                                    opacity: !customType || !displayName || creating ? 0.4 : 1,
                                }}
                            >
                                {creating ? t('machine.providerClone.creating') : t('machine.providerClone.createProvider')}
                            </button>
                        </>
                    ) : (
                        <button onClick={onClose} className="machine-btn">{t('machine.providerClone.close')}</button>
                    )}
                </div>
            </div>
        </div>
        </ModalPortal>
    )
}
