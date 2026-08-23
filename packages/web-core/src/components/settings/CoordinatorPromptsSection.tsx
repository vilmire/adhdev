/**
 * CoordinatorPromptsSection
 *
 * Settings-page block for editing the user-level coordinator prompt files at
 * ~/.adhdev/coordinator-prompts/<cli>.{md,append.md}. These files are
 * per-daemon local config (not synced through the cloud or any mesh), so we
 * route reads/writes through the local-daemon RPC commands
 * `list_coordinator_prompts` / `write_coordinator_prompt`.
 *
 * Empty content on save clears the file — that's how "reset to default"
 * works, since absence of the file is the signal for the daemon to fall back
 * to its built-in template.
 *
 * Mesh-level and per-node prompts are NOT edited here — those live on the
 * RepoMesh page (they're mesh config, not per-machine config).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useTransport } from '../../context/TransportContext'

interface PromptEntry {
    override: string
    append: string
}

interface Props {
    daemonId: string | undefined
    /** CLI types we recognize and show inputs for. Anything else loaded from
     *  disk gets shown as well — that lets a user create a `default.md` or
     *  hand-author an entry for a CLI we haven't shipped yet without losing
     *  it from the UI. */
    knownCliTypes?: string[]
}

const DEFAULT_KNOWN_CLI_TYPES = [
    'default',
    'claude-cli',
    'codex-cli',
    'antigravity-cli',
    'hermes-cli',
    'gemini-cli',
]

export default function CoordinatorPromptsSection({ daemonId, knownCliTypes = DEFAULT_KNOWN_CLI_TYPES }: Props) {
    const { t } = useTranslation('common')
    const { sendCommand } = useTransport()
    const [drafts, setDrafts] = useState<Record<string, PromptEntry>>({})
    const [savedSnapshot, setSavedSnapshot] = useState<Record<string, PromptEntry>>({})
    const [loading, setLoading] = useState(true)
    const [savingKey, setSavingKey] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [dir, setDir] = useState<string>('')

    const load = useCallback(async () => {
        if (!daemonId) return
        setLoading(true)
        setError(null)
        try {
            const raw: any = await sendCommand(daemonId, 'list_coordinator_prompts', {})
            // Cloud transport wraps once; standalone returns the daemon body
            // directly. See TransportContext jsdoc for the canonical warning.
            const result = (raw?.result && typeof raw.result === 'object') ? raw.result : raw
            if (!result?.success) {
                setError(result?.error || 'Failed to load')
                return
            }
            const entries = (result.entries || {}) as Record<string, PromptEntry>
            setDir(result.dir || '')
            // Merge: known CLI types we always show (empty if missing); any
            // additional keys on disk we add too so a hand-authored file
            // isn't hidden.
            const merged: Record<string, PromptEntry> = {}
            for (const k of knownCliTypes) merged[k] = entries[k] || { override: '', append: '' }
            for (const k of Object.keys(entries)) if (!merged[k]) merged[k] = entries[k]
            setDrafts(merged)
            setSavedSnapshot(JSON.parse(JSON.stringify(merged)))
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setLoading(false)
        }
    }, [sendCommand, daemonId, knownCliTypes])

    useEffect(() => { void load() }, [load])

    const save = useCallback(async (key: string, kind: 'override' | 'append') => {
        if (!daemonId) return
        setSavingKey(`${key}:${kind}`)
        setError(null)
        try {
            const content = drafts[key]?.[kind] || ''
            const raw: any = await sendCommand(daemonId, 'write_coordinator_prompt', { key, kind, content })
            const result = (raw?.result && typeof raw.result === 'object') ? raw.result : raw
            if (!result?.success) {
                setError(result?.error || 'Save failed')
                return
            }
            setSavedSnapshot(prev => ({ ...prev, [key]: { ...(prev[key] || { override: '', append: '' }), [kind]: content } }))
        } catch (e: any) {
            setError(e?.message || String(e))
        } finally {
            setSavingKey(null)
        }
    }, [sendCommand, daemonId, drafts])

    const dirtyOf = useMemo(() => (key: string, kind: 'override' | 'append'): boolean => {
        return (drafts[key]?.[kind] || '') !== (savedSnapshot[key]?.[kind] || '')
    }, [drafts, savedSnapshot])

    if (!daemonId) {
        return (
            <div className="text-xs text-text-muted">
                Connect a daemon to edit coordinator prompts.
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="text-xs text-text-muted">
                <p>
                    Customize the coordinator prompt this daemon's mesh coordinator
                    sessions get. <span className="font-mono text-2xs">{dir || '~/.adhdev/coordinator-prompts/'}</span>
                </p>
                <p className="mt-1">
                    <Trans i18nKey="settings.coordinatorPrompts.overrideDesc" ns="common" components={{ strong: <strong /> }} />
                    {' '}
                    <Trans i18nKey="settings.coordinatorPrompts.appendDesc" ns="common" components={{ strong: <strong /> }} />
                    Leave a field empty + Save to remove it (reset to default).
                    Supports placeholders: {'{{meshName}}'}, {'{{repo}}'}, {'{{nodes}}'}, {'{{rules}}'}, etc.
                </p>
            </div>

            {error && <div className="text-xs text-status-error bg-status-error/10 border border-status-error/40 rounded px-3 py-2">{error}</div>}
            {loading && <div className="text-xs text-text-muted">Loading…</div>}

            <div className="flex flex-col gap-6">
                {Object.entries(drafts).map(([key, entry]) => (
                    <div key={key} className="rounded-lg border border-border-subtle bg-bg-secondary/40 p-3">
                        <div className="text-[13px] font-semibold mb-2">{key}</div>

                        <label className="block text-2xs uppercase tracking-wide text-text-muted mb-1">{t('settings.coordinatorPrompts.overrideLabel')}</label>
                        <textarea
                            className="w-full px-3 py-2 rounded bg-bg-secondary border border-border-subtle text-xs font-mono text-text-primary"
                            rows={4}
                            value={entry.override}
                            onChange={e => setDrafts(prev => ({ ...prev, [key]: { ...prev[key], override: e.target.value } }))}
                            placeholder="(empty — use daemon default base prompt)"
                            disabled={savingKey === `${key}:override`}
                        />
                        <div className="mt-1 mb-3 flex justify-end">
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => void save(key, 'override')}
                                disabled={savingKey === `${key}:override` || !dirtyOf(key, 'override')}
                            >
                                {savingKey === `${key}:override` ? 'Saving…' : dirtyOf(key, 'override') ? 'Save override' : 'Saved'}
                            </button>
                        </div>

                        <label className="block text-2xs uppercase tracking-wide text-text-muted mb-1">{t('settings.coordinatorPrompts.appendLabel')}</label>
                        <textarea
                            className="w-full px-3 py-2 rounded bg-bg-secondary border border-border-subtle text-xs font-mono text-text-primary"
                            rows={3}
                            value={entry.append}
                            onChange={e => setDrafts(prev => ({ ...prev, [key]: { ...prev[key], append: e.target.value } }))}
                            placeholder="(empty — nothing appended at this layer)"
                            disabled={savingKey === `${key}:append`}
                        />
                        <div className="mt-1 flex justify-end">
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => void save(key, 'append')}
                                disabled={savingKey === `${key}:append` || !dirtyOf(key, 'append')}
                            >
                                {savingKey === `${key}:append` ? 'Saving…' : dirtyOf(key, 'append') ? 'Save append' : 'Saved'}
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
