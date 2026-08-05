/**
 * InstalledProviderRow — one row per installed provider.
 *
 * Default state: compact line with icon, name, category badge, machine status
 * badge, Enable/Disable toggle, and an expand toggle. Expanded state shows
 * detection details + per-provider settings + secondary actions (Detect,
 * Reset command).
 *
 * No Auto-Fix button. That feature was over-scoped for this surface; users
 * can edit the manifest directly or use the Reset command + Detect cycle.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Card from '../../components/Card'
import type { ProviderInfo, ProviderSettingsEntry } from './types'
import TrustBadge, { type ProviderTrust } from './TrustBadge'

/**
 * Validate a provider-manifest URL before rendering it as an anchor.
 * Manifests from external/untrusted sources could otherwise smuggle
 * `javascript:` / `data:` URIs into the catalog. We accept only http/
 * https; anything else collapses to a non-link.
 */
function safeHttpHref(raw: unknown): string | null {
    if (typeof raw !== 'string') return null
    try {
        const u = new URL(raw)
        return (u.protocol === 'https:' || u.protocol === 'http:') ? u.toString() : null
    } catch {
        return null
    }
}

type ProviderMachineCheck = NonNullable<ProviderInfo['lastDetection']>

const STATUS_CLASS: Record<string, string> = {
    detected: 'bg-green-500/[0.10] border-green-500/25 text-green-400',
    not_detected: 'bg-red-500/[0.10] border-red-500/25 text-red-400',
    enabled_unchecked: 'bg-yellow-500/[0.10] border-yellow-500/25 text-yellow-400',
    disabled: 'bg-white/[0.04] border-white/[0.10] text-text-muted',
}

const CATEGORY_BG: Record<string, string> = {
    acp: 'bg-violet-500/10 text-violet-300 border-violet-500/20',
    cli: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
    ide: 'bg-green-500/10 text-green-300 border-green-500/20',
    extension: 'bg-yellow-500/10 text-yellow-300 border-yellow-500/20',
}

function formatCheck(check?: ProviderMachineCheck): string {
    if (!check) return '—'
    const ok = check.ok ? 'OK' : 'Failed'
    const detail = check.message || check.path || check.command || ''
    return detail ? `${ok} — ${detail}` : ok
}

function isMachineRuntimeProvider(category: string): boolean {
    return category === 'cli' || category === 'acp'
}

interface InstalledProviderRowProps {
    prov: ProviderSettingsEntry
    providerInfo: ProviderInfo | undefined
    savingKey: string | null
    onSetSetting: (providerType: string, key: string, value: unknown) => Promise<void>
    onEnableToggle: (providerType: string, enabled: boolean) => Promise<void>
    onDetect: (providerType: string) => Promise<void>
    onResetCommand: (providerType: string) => Promise<void>
    /**
     * Quota account-label preference. Machine-level (not a provider manifest
     * setting), so it is passed in rather than read from `prov.values` — but it
     * is rendered HERE, inside the provider whose quota carries the label, which
     * is where a user looking at that provider expects to find it.
     * `undefined` while it is still loading, or for providers that report no
     * account at all (then nothing renders).
     */
    quotaAccountLabelEnabled?: boolean
    onQuotaAccountLabelToggle?: (enabled: boolean) => Promise<void>
    /**
     * Verified-channel PIN for this provider — the manifest the daemon actually
     * loads, which is NOT the same as the CLI binary version shown above it.
     * `undefined` while loading or when this provider has no pin.
     *
     * Provider updates do not propagate on their own: the pin advances only on
     * an explicit activation (by design, for reproducibility + rollback). So a
     * machine can sit on an old spec indefinitely with nothing on screen saying
     * so — which is exactly how a published kimi fix stayed unadopted for a day.
     * This row is where that becomes visible.
     */
    pin?: ProviderPinInfo
    /** Activate the newest channel objects (moves the pointer). */
    onActivateUpdate?: () => Promise<void>
    /** Flip back to the previous pinned object — local, no network. */
    onRollbackUpdate?: () => Promise<void>
}

export interface ProviderPinInfo {
    /** Manifest version currently activated (what the daemon loads). */
    activeVersion?: string | null
    /** Newest version the channel offers. */
    latestVersion?: string | null
    /** True when activeVersion is behind latestVersion. */
    stale?: boolean
    digest?: string | null
    activatedAt?: string | null
    /** Rollback target; absent means there is nothing to roll back to. */
    previousVersion?: string | null
}

export default function InstalledProviderRow({
    prov,
    providerInfo,
    savingKey,
    onSetSetting,
    onEnableToggle,
    onDetect,
    onResetCommand,
    quotaAccountLabelEnabled,
    onQuotaAccountLabelToggle,
    pin,
    onActivateUpdate,
    onRollbackUpdate,
}: InstalledProviderRowProps) {
    const [pinBusy, setPinBusy] = useState<'activate' | 'rollback' | null>(null)
    // Activating replaces what the daemon loads for every session started
    // afterwards, so it asks first. Rollback does not: it returns to the object
    // that was already running, is a purely local pointer flip, and is the
    // action a user reaches for when an update just broke something — putting a
    // dialog in front of that is friction at the worst moment.
    const [confirmActivate, setConfirmActivate] = useState(false)
    const { t } = useTranslation('common')
    const STATUS_LABEL_I18N: Record<string, string> = {
        detected: t('machine.providerRow.statusDetected'),
        not_detected: t('machine.providerRow.statusNotDetected'),
        enabled_unchecked: t('machine.providerRow.statusEnabledUnchecked'),
        disabled: t('machine.providerRow.statusDisabled'),
    }
    const [expanded, setExpanded] = useState(false)
    const enabled = providerInfo?.enabled === true || prov.values.enabled === true
    // If we've just locally enabled the provider but the status broadcast
    // (providerInfo.machineStatus) still says "disabled", that snapshot is
    // stale — prefer the local enabled flag and surface "enabled (unchecked)"
    // until the next detection result lands.
    const rawStatus = providerInfo?.machineStatus
    const machineStatus =
        enabled && rawStatus === 'disabled'
            ? 'enabled_unchecked'
            : (rawStatus || (enabled ? 'enabled_unchecked' : 'disabled'))
    const isRuntime = isMachineRuntimeProvider(prov.category)

    return (
        <Card padding="none">
            {/* Compact header */}
            <button
                onClick={() => setExpanded(v => !v)}
                className="w-full px-4 py-2.5 flex items-center gap-3 text-left"
            >
                <span className="text-base shrink-0">{prov.icon}</span>
                <span className="text-[13px] font-semibold text-text-primary truncate">{prov.displayName}</span>
                <span className={`text-[9px] font-semibold px-1.5 py-px rounded border ${CATEGORY_BG[prov.category] ?? 'border-border-subtle text-text-muted'}`}>
                    {prov.category.toUpperCase()}
                </span>
                {(providerInfo as any)?.trust && (
                    <TrustBadge
                        trust={(providerInfo as any).trust as ProviderTrust}
                        sourceName={(providerInfo as any).sourceName ?? null}
                        description={(providerInfo as any).trustDescription}
                    />
                )}
                {isRuntime && (
                    <span className={`text-[9px] font-semibold px-1.5 py-px rounded border ${STATUS_CLASS[machineStatus] ?? STATUS_CLASS.disabled}`}>
                        {STATUS_LABEL_I18N[machineStatus] ?? machineStatus}
                    </span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                    {isRuntime && (
                        <button
                            onClick={(e) => { e.stopPropagation(); void onEnableToggle(prov.type, !enabled) }}
                            disabled={savingKey === `${prov.type}.enabled`}
                            className={`machine-btn text-[10px] px-2 py-0.5 ${enabled ? 'text-red-400 border-red-500/25' : 'text-green-400 border-green-500/25'}`}
                        >{enabled ? t('machine.providerRow.disable') : t('machine.providerRow.enable')}</button>
                    )}
                    <span className="text-text-muted text-xs">{expanded ? '▾' : '▸'}</span>
                </div>
            </button>

            {/* Expanded body */}
            {expanded && (
                <div className="border-t border-border-subtle px-4 py-3 flex flex-col gap-3">
                    {/* Quota account label — machine-level, but shown on the
                        provider whose quota carries it. Only offered for
                        providers that actually report an account (codex today);
                        rendering it on claude/kimi would promise something the
                        provider cannot deliver. */}
                    {onQuotaAccountLabelToggle && quotaAccountLabelEnabled !== undefined && (
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-[11px] text-text-secondary font-medium">{t('machine.providerRow.quotaAccountLabel')}</div>
                                <div className="text-[10px] text-text-muted">{t('machine.providerRow.quotaAccountLabelHint')}</div>
                            </div>
                            <button
                                onClick={(e) => { e.stopPropagation(); void onQuotaAccountLabelToggle(!quotaAccountLabelEnabled) }}
                                className={`machine-btn text-[10px] px-2 py-0.5 shrink-0 ${quotaAccountLabelEnabled ? 'text-green-400 border-green-500/25' : 'text-text-muted'}`}
                            >{quotaAccountLabelEnabled ? t('machine.providerRow.quotaAccountLabelOn') : t('machine.providerRow.quotaAccountLabelOff')}</button>
                        </div>
                    )}
                    {/* Details: manifest metadata + source identity. Pulled
                        from the daemon's status broadcast — no extra round-trip. */}
                    <div className="grid gap-1 text-[10px] text-text-muted">
                        <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelType')}</span> <span className="font-mono">{prov.type}</span></div>
                        {(providerInfo as any)?.providerVersion && (
                            <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelVersion')}</span> {(providerInfo as any).providerVersion}</div>
                        )}
                        {/* Verified-channel PIN. Rendered separately from the
                            manifest version above because they answer different
                            questions: that is the CLI binary, this is the spec
                            the daemon loads. They routinely disagree. */}
                        {pin?.activeVersion && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-text-secondary font-medium">{t('machine.providerRow.labelSpecPin')}</span>
                                <span className="font-mono">{pin.activeVersion}</span>
                                {pin.stale && pin.latestVersion && (
                                    <span
                                        className="px-1 py-px rounded border border-amber-500/30 text-amber-400"
                                        title={t('machine.providerRow.specPinStaleHint', { latest: pin.latestVersion })}
                                    >{t('machine.providerRow.specPinStale', { latest: pin.latestVersion })}</span>
                                )}
                            </div>
                        )}
                        {pin?.activatedAt && (
                            <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelActivatedAt')}</span> {new Date(pin.activatedAt).toLocaleString()}</div>
                        )}
                        {pin?.previousVersion && (
                            <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelPreviousPin')}</span> <span className="font-mono">{pin.previousVersion}</span></div>
                        )}
                        {pin?.digest && (
                            <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelDigest')}</span> <span className="font-mono">{pin.digest.replace(/^sha256:/, '').slice(0, 12)}</span></div>
                        )}
                        {(providerInfo as any)?.binary && (
                            <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelBinary')}</span> <span className="font-mono">{(providerInfo as any).binary}</span></div>
                        )}
                        {(providerInfo as any)?.status && (
                            <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelStatus')}</span> {(providerInfo as any).status}</div>
                        )}
                        {(providerInfo as any)?.details && (
                            <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelDetails')}</span> {(providerInfo as any).details}</div>
                        )}
                        {(providerInfo as any)?.sourceLayer && (
                            <div>
                                <span className="text-text-secondary font-medium">{t('machine.providerRow.labelSource')}</span>{' '}
                                {(providerInfo as any).sourceLayer}
                                {(providerInfo as any).sourceName ? ` · ${(providerInfo as any).sourceName}` : ''}
                            </div>
                        )}
                        {(providerInfo as any)?.trust && (providerInfo as any)?.trustDescription && (
                            <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelTrust')}</span> {(providerInfo as any).trustDescription}</div>
                        )}
                        {(() => {
                            const links = (providerInfo as any)?.links as Record<string, unknown> | undefined
                            if (!links) return null
                            const safe = Object.entries(links)
                                .map(([k, v]) => ({ k, href: safeHttpHref(v) }))
                                .filter((e): e is { k: string; href: string } => e.href !== null)
                            if (safe.length === 0) return null
                            return (
                                <div>
                                    <span className="text-text-secondary font-medium">{t('machine.providerRow.labelLinks')}</span>{' '}
                                    {safe.map(({ k, href }) => (
                                        <a
                                            key={k}
                                            href={href}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-violet-400 hover:underline mr-2"
                                        >{k}</a>
                                    ))}
                                </div>
                            )
                        })()}
                    </div>
                    {isRuntime && (
                        <div className="grid gap-1 text-[10px] text-text-muted">
                            <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelDetection')}</span> {formatCheck(providerInfo?.lastDetection)}</div>
                            <div><span className="text-text-secondary font-medium">{t('machine.providerRow.labelVerification')}</span> {formatCheck(providerInfo?.lastVerification)}</div>
                        </div>
                    )}

                    {/* Settings */}
                    {prov.schema.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                            {prov.schema.map(s => (
                                <div key={s.key} className="flex items-center justify-between gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[11px] font-medium text-text-primary">
                                            {s.label || s.key}
                                            {savingKey === `${prov.type}.${s.key}` && (
                                                <span className="ml-1.5 text-[9px] text-violet-500">{t('machine.providerRow.saving')}</span>
                                            )}
                                        </div>
                                        {s.description && (
                                            <div className="text-[10px] text-text-muted mt-px">{s.description}</div>
                                        )}
                                    </div>
                                    <div className="shrink-0">
                                        {s.type === 'boolean' ? (
                                            <button
                                                onClick={() => void onSetSetting(prov.type, s.key, !(prov.values[s.key] ?? s.default))}
                                                className="w-10 h-[22px] rounded-[11px] border-none relative cursor-pointer transition-colors duration-200"
                                                style={{ background: (prov.values[s.key] ?? s.default) ? '#8b5cf6' : 'var(--border-subtle)' }}
                                            >
                                                <div
                                                    className="w-4 h-4 rounded-full bg-white absolute top-[3px] transition-[left] duration-200 shadow-[0_1px_3px_rgba(0,0,0,0.3)]"
                                                    style={{ left: (prov.values[s.key] ?? s.default) ? 21 : 3 }}
                                                />
                                            </button>
                                        ) : s.type === 'number' ? (
                                            <input
                                                type="number"
                                                value={Number(prov.values[s.key] ?? s.default ?? 0) || 0}
                                                min={s.min}
                                                max={s.max}
                                                onChange={e => {
                                                    const v = parseInt(e.target.value) || 0
                                                    if (s.min !== undefined && v < s.min) return
                                                    if (s.max !== undefined && v > s.max) return
                                                    void onSetSetting(prov.type, s.key, v)
                                                }}
                                                className="machine-input w-20 text-center text-[11px]"
                                            />
                                        ) : s.type === 'select' && s.options ? (
                                            <select
                                                value={String(prov.values[s.key] ?? s.default ?? '')}
                                                onChange={e => void onSetSetting(prov.type, s.key, e.target.value)}
                                                className="machine-input text-[11px]"
                                            >
                                                {s.options.map(o => <option key={o} value={o}>{o}</option>)}
                                            </select>
                                        ) : (
                                            <input
                                                type="text"
                                                defaultValue={String(prov.values[s.key] ?? s.default ?? '')}
                                                onBlur={e => void onSetSetting(prov.type, s.key, e.target.value)}
                                                className="machine-input w-[180px] text-[11px]"
                                            />
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Secondary actions */}
                    <div className="flex gap-1.5 flex-wrap pt-1 border-t border-border-subtle">
                        {isRuntime && (
                            <>
                                <button
                                    onClick={() => void onDetect(prov.type)}
                                    disabled={!enabled || savingKey === `${prov.type}.detect`}
                                    className={`machine-btn text-[10px] px-2 py-0.5 text-blue-400 border-blue-500/25 ${enabled ? '' : 'opacity-40 cursor-not-allowed'}`}
                                    title={enabled ? 'Run detection for the configured executable' : 'Enable provider before detection'}
                                >{t('machine.providerRow.detect')}</button>
                                <button
                                    onClick={() => void onResetCommand(prov.type)}
                                    className="machine-btn text-[10px] px-2 py-0.5"
                                >{t('machine.providerRow.resetCommand')}</button>
                            </>
                        )}
                        {/* Pin actions. Update asks first (it changes what every
                            later session loads); rollback does not (it returns to
                            the object that was already running, locally). */}
                        {onActivateUpdate && pin?.stale && !confirmActivate && (
                            <button
                                onClick={() => setConfirmActivate(true)}
                                disabled={pinBusy !== null}
                                className="machine-btn text-[10px] px-2 py-0.5 text-amber-400 border-amber-500/25"
                                title={t('machine.providerRow.specPinUpdateHint')}
                            >{t('machine.providerRow.specPinUpdate')}</button>
                        )}
                        {onActivateUpdate && confirmActivate && (
                            <>
                                <button
                                    onClick={() => {
                                        setPinBusy('activate')
                                        void onActivateUpdate()
                                            .finally(() => { setPinBusy(null); setConfirmActivate(false) })
                                    }}
                                    disabled={pinBusy !== null}
                                    className="machine-btn text-[10px] px-2 py-0.5 text-amber-400 border-amber-500/25"
                                >{pinBusy === 'activate' ? t('machine.providerRow.specPinUpdating') : t('machine.providerRow.specPinUpdateConfirm')}</button>
                                <button
                                    onClick={() => setConfirmActivate(false)}
                                    disabled={pinBusy !== null}
                                    className="machine-btn text-[10px] px-2 py-0.5"
                                >{t('machine.providerRow.specPinCancel')}</button>
                            </>
                        )}
                        {onRollbackUpdate && pin?.previousVersion && (
                            <button
                                onClick={() => {
                                    setPinBusy('rollback')
                                    void onRollbackUpdate().finally(() => setPinBusy(null))
                                }}
                                disabled={pinBusy !== null}
                                className="machine-btn text-[10px] px-2 py-0.5"
                                title={t('machine.providerRow.specPinRollbackHint', { version: pin.previousVersion })}
                            >{pinBusy === 'rollback' ? t('machine.providerRow.specPinRollingBack') : t('machine.providerRow.specPinRollback')}</button>
                        )}
                    </div>
                </div>
            )}
        </Card>
    )
}
