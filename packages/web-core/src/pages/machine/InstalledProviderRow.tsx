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

const STATUS_LABEL: Record<string, string> = {
    detected: 'Detected',
    not_detected: 'Not detected',
    enabled_unchecked: 'Enabled (unchecked)',
    disabled: 'Disabled',
}

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
}

export default function InstalledProviderRow({
    prov,
    providerInfo,
    savingKey,
    onSetSetting,
    onEnableToggle,
    onDetect,
    onResetCommand,
}: InstalledProviderRowProps) {
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
        <div className="rounded-xl bg-bg-secondary border border-border-subtle">
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
                        {STATUS_LABEL[machineStatus] ?? machineStatus}
                    </span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                    {isRuntime && (
                        <button
                            onClick={(e) => { e.stopPropagation(); void onEnableToggle(prov.type, !enabled) }}
                            disabled={savingKey === `${prov.type}.enabled`}
                            className={`machine-btn text-[10px] px-2 py-0.5 ${enabled ? 'text-red-400 border-red-500/25' : 'text-green-400 border-green-500/25'}`}
                        >{enabled ? 'Disable' : 'Enable'}</button>
                    )}
                    <span className="text-text-muted text-xs">{expanded ? '▾' : '▸'}</span>
                </div>
            </button>

            {/* Expanded body */}
            {expanded && (
                <div className="border-t border-border-subtle px-4 py-3 flex flex-col gap-3">
                    {/* Details: manifest metadata + source identity. Pulled
                        from the daemon's status broadcast — no extra round-trip. */}
                    <div className="grid gap-1 text-[10px] text-text-muted">
                        <div><span className="text-text-secondary font-medium">Type:</span> <span className="font-mono">{prov.type}</span></div>
                        {(providerInfo as any)?.providerVersion && (
                            <div><span className="text-text-secondary font-medium">Version:</span> {(providerInfo as any).providerVersion}</div>
                        )}
                        {(providerInfo as any)?.binary && (
                            <div><span className="text-text-secondary font-medium">Binary:</span> <span className="font-mono">{(providerInfo as any).binary}</span></div>
                        )}
                        {(providerInfo as any)?.status && (
                            <div><span className="text-text-secondary font-medium">Status:</span> {(providerInfo as any).status}</div>
                        )}
                        {(providerInfo as any)?.details && (
                            <div><span className="text-text-secondary font-medium">Details:</span> {(providerInfo as any).details}</div>
                        )}
                        {(providerInfo as any)?.sourceLayer && (
                            <div>
                                <span className="text-text-secondary font-medium">Source:</span>{' '}
                                {(providerInfo as any).sourceLayer}
                                {(providerInfo as any).sourceName ? ` · ${(providerInfo as any).sourceName}` : ''}
                            </div>
                        )}
                        {(providerInfo as any)?.trust && (providerInfo as any)?.trustDescription && (
                            <div><span className="text-text-secondary font-medium">Trust:</span> {(providerInfo as any).trustDescription}</div>
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
                                    <span className="text-text-secondary font-medium">Links:</span>{' '}
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
                            <div><span className="text-text-secondary font-medium">Detection:</span> {formatCheck(providerInfo?.lastDetection)}</div>
                            <div><span className="text-text-secondary font-medium">Verification:</span> {formatCheck(providerInfo?.lastVerification)}</div>
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
                                                <span className="ml-1.5 text-[9px] text-violet-500">saving…</span>
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
                                >Detect</button>
                                <button
                                    onClick={() => void onResetCommand(prov.type)}
                                    className="machine-btn text-[10px] px-2 py-0.5"
                                >Reset command</button>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
