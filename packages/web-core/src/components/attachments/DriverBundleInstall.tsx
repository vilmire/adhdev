import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBaseDaemons } from '../../context/BaseDaemonContext'
import { useTransport } from '../../context/TransportContext'
import { trArtifact } from './artifact-i18n'
import type { ArtifactViewerItem } from './artifact-viewer-item'

/** Owner-side "Install driver" for a shared `*.driver-bundle.json` artifact (docs/design/2026-10-29-driver-authoring-and-sharing.md). */
export const DRIVER_BUNDLE_FILENAME = /\.driver-bundle\.json$/i

export function isDriverBundleItem(item: Pick<ArtifactViewerItem, 'kind' | 'filename' | 'text'>): boolean {
    return item.kind === 'json' && DRIVER_BUNDLE_FILENAME.test(item.filename) && typeof item.text === 'string' && item.text.length > 0
}

/** Display-only peek; the daemon re-verifies everything (digest, manifest, paths) on install. */
export function peekDriverBundle(text: string): { type: string; name: string } | null {
    try {
        const raw = JSON.parse(text)
        if (raw?.format !== 'adhdev-driver-bundle' || typeof raw.type !== 'string') return null
        return { type: raw.type, name: typeof raw.name === 'string' ? raw.name : raw.type }
    } catch { return null }
}

/** Cloud wraps the P2P reply once (`{success, result}`); standalone returns the daemon body. */
export function unwrapDriverImportReply(reply: any): Record<string, any> {
    const inner = reply?.result
    return inner && typeof inner === 'object' && ('success' in inner || 'code' in inner) ? inner : (reply ?? {})
}

export default function DriverBundleInstall({ item }: { item: ArtifactViewerItem }) {
    const { t, i18n } = useTranslation('common')
    const tr = (key: Parameters<typeof trArtifact>[2]) => trArtifact(t, i18n.language, key)
    const { sendCommand } = useTransport()
    const { ides } = useBaseDaemons()
    const machines = useMemo(() => (ides ?? [])
        .filter((d: any) => d && typeof d.id === 'string' && (d.daemonMode || d.type === 'adhdev-daemon'))
        .map((d: any) => ({ id: d.id as string, label: String(d.nickname || d.hostname || d.id) })), [ides])
    const peek = useMemo(() => peekDriverBundle(item.text ?? ''), [item.text])
    const [target, setTarget] = useState('')
    const [busy, setBusy] = useState(false)
    const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)
    const effectiveTarget = target || machines[0]?.id || ''
    if (!peek) return null

    const install = async () => {
        if (!effectiveTarget || busy) return
        setBusy(true); setOutcome(null)
        try {
            const body = unwrapDriverImportReply(await sendCommand(effectiveTarget, 'driver_import', { bundle: item.text }))
            setOutcome(body.success === true
                ? { ok: true, text: tr('artifact.driverInstalled') }
                : { ok: false, text: `${tr('artifact.driverInstallFailed')}: ${String(body.code ?? body.error ?? 'unknown')}` })
        } catch (error) {
            setOutcome({ ok: false, text: `${tr('artifact.driverInstallFailed')}: ${error instanceof Error ? error.message : String(error)}` })
        } finally { setBusy(false) }
    }

    return (
        <div data-testid="driver-bundle-install" className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-bg-secondary px-4 py-1.5 text-2xs">
            <span className="font-semibold">{peek.name}</span>
            <span className="font-mono text-text-muted">{peek.type}</span>
            {machines.length > 1 && (
                <label className="flex items-center gap-1 text-text-muted">
                    {tr('artifact.driverInstallTarget')}
                    <select data-testid="driver-bundle-target" value={effectiveTarget} onChange={e => setTarget(e.target.value)} className="rounded border border-border-subtle bg-bg-primary px-1 py-0.5 text-text-primary">
                        {machines.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                </label>
            )}
            <button type="button" data-testid="driver-bundle-install-button" disabled={busy || !effectiveTarget} onClick={install}
                className="inline-flex min-h-[28px] items-center rounded-lg border border-border-subtle bg-bg-primary px-2.5 font-semibold text-text-primary disabled:opacity-50">
                {tr('artifact.driverInstall')}
            </button>
            {outcome && <span role="status" data-testid="driver-bundle-outcome" className={outcome.ok ? 'text-emerald-600 dark:text-emerald-300' : 'text-red-600 dark:text-red-300'}>{outcome.text}</span>}
        </div>
    )
}
